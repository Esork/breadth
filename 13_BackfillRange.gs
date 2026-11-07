/**
 * 13_BackfillRange.gs
 *
 * ONE-OFF recovery tool for the 2026-10 S&P 500 reconstitution incident
 * (VYLR / TWLO / SKYD in, CTVA / WBD / PSKY out).
 *
 * Why this exists: from 2026-10-05 to 2026-10-15 (and 2026-10-21) the daily
 * pipeline never pushed raw OHLCV to Cloudflare -- its health gate failed while
 * the registry still listed WBD/PSKY, and push/derive only run when health is OK.
 * The Sheet cache for those days was then pruned. This tool re-fetches the
 * missing days from GOOGLEFINANCE and pushes them straight to /ingest/ohlcv.
 * It does NOT go through the Sheet DB cache.
 *
 * Which tickers belong to which date comes from the Worker's /api/universe?date=
 * -- the exact index_membership_periods logic the quality gate uses -- so what
 * we push is what the gate will expect.
 *
 * PREREQUISITE: index_membership_periods already patched
 *   VYLR start 2026-10-01; TWLO/SKYD start 2026-10-06; CTVA/WBD/PSKY end 2026-10-06.
 *   startBackfillRange() verifies this and refuses to run otherwise.
 *
 * Flow:
 *   startBackfillRange()       precondition check, build queue, install trigger
 *   backfillRangeWorker()      (trigger) fetch bars in batches under the script lock
 *   finishBackfillRange_()     (automatic) assemble per date, sanity-check, push
 *   deriveBackfilledDates()    (manual, afterwards) re-derive 10-05..10-22
 *
 * Do not run during the daily sync window: both use the script lock and the
 * shared buffer sheet. Expect roughly 35-50 minutes (GOOGLEFINANCE is ~3-4s per
 * ticker). Safe to delete this file once the recovery is verified.
 */

var BACKFILL_RANGE_CFG = {
  STATE_KEY: 'QE_BACKFILL_RANGE_STATE_V1',
  QUEUE_SHEET: 'SYS_BACKFILL_RANGE_QUEUE',
  STAGE_SHEET: 'SYS_BACKFILL_RANGE_STAGE',
  LOG_MODULE: 'BACKFILL_RANGE',

  // One GOOGLEFINANCE range call per ticker covers every target date.
  FETCH_FROM: '2026-10-05',
  FETCH_TO: '2026-10-22',

  // Only the dates that are actually missing from D1 raw. 10-16, 10-19,
  // 10-20 and 10-22 already exist and are deliberately left alone.
  TARGET_DATES: [
    '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
    '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-21'
  ],

  // If a ticker has no bars on a date, try these symbols for the same date.
  // PSKY became SKYD on 2026-10-06 (same company, new symbol); Google Finance
  // may only serve the pre-rename history under the new symbol.
  ALIASES: { PSKY: ['SKYD'] },

  // Abort BEFORE pushing anything if any single date is missing more than this
  // many tickers (a sign GOOGLEFINANCE is misbehaving, not a handful of
  // delisted names).
  MAX_MISSING_PER_DATE: 10,

  BATCH_TICKERS: 60,
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,
  WORKER_EVERY_MINUTES: 5,

  DERIVE_WINDOWS: [
    { from: '2026-10-05', to: '2026-10-15' },
    { from: '2026-10-16', to: '2026-10-22' }
  ]
};

var BACKFILL_QUEUE_HEADER_ = ['Ticker', 'Status', 'Message'];
var BACKFILL_STAGE_HEADER_ = ['Ticker', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume'];

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function startBackfillRange() {
  var startTime = Date.now();
  var cfg = BACKFILL_RANGE_CFG;
  var module = cfg.LOG_MODULE;
  var props = PropertiesService.getScriptProperties();

  var existing = parseJsonSafe_(props.getProperty(cfg.STATE_KEY), null);
  if (existing && existing.status === 'RUNNING') {
    throw new Error(
      'A range backfill is already RUNNING. Run inspectBackfillRange(), ' +
        'or resetBackfillRange() to start over.'
    );
  }

  // The daily sync hammers this same spreadsheet every few minutes while it
  // runs. Starting up alongside it is what caused "Service Spreadsheets timed
  // out" on the first attempt, so refuse up front with a clear instruction.
  if (backfillDailySyncIsRunning_()) {
    throw new Error(
      'Daily sync is RUNNING right now (it shares this spreadsheet and the script lock). ' +
        'Wait until it finishes -- inspectDailySyncState() shows no state once it is done -- ' +
        'then run startBackfillRange() again.'
    );
  }

  var universeByDate = fetchBackfillUniverseByDate_(cfg.TARGET_DATES);
  assertMembershipPatchedForOct2026_(universeByDate);

  var tickerMap = {};
  cfg.TARGET_DATES.forEach(function(d) {
    universeByDate[d].forEach(function(t) { tickerMap[t] = true; });
  });
  Object.keys(cfg.ALIASES).forEach(function(k) {
    cfg.ALIASES[k].forEach(function(a) { tickerMap[a] = true; });
  });
  var tickers = Object.keys(tickerMap).sort();

  // Hold the script lock for the setup so no other worker touches the sheets
  // mid-way. Released BEFORE the first worker run below, which takes the lock
  // itself.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Could not get the script lock (another worker is busy). Try again in a few minutes.');
  }

  try {
    backfillRetry_('Queue/stage sheet setup', function() {
      setupBackfillSheets_(tickers);
    });

    props.setProperty(
      cfg.STATE_KEY,
      JSON.stringify({
        status: 'RUNNING',
        totalTickers: tickers.length,
        startedAt: nowIso_()
      })
    );

    installEveryMinutesTrigger_('backfillRangeWorker', cfg.WORKER_EVERY_MINUTES);

  } finally {
    lock.releaseLock();
  }

  logInfo_(
    module,
    startTime,
    'Range backfill started. Tickers=' + tickers.length +
      ', TargetDates=' + cfg.TARGET_DATES.length +
      ', UniverseSizes=' + cfg.TARGET_DATES.map(function(d) {
        return d.slice(5) + ':' + universeByDate[d].length;
      }).join(',')
  );

  backfillRangeWorker();
}

function backfillRangeWorker() {
  var startTime = Date.now();
  var module = BACKFILL_RANGE_CFG.LOG_MODULE;
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    logWarn_(module, startTime, 'Could not get lock. Worker skipped safely.');
    return;
  }

  try {
    runBackfillRangeBatch_(startTime);

  } catch (err) {
    logError_(module, startTime, String(err));

  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Setup / resilience helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Idempotent: clears and rewrites both sheets, so it is safe to run again
 * after a partial failure (e.g. queue written, stage sheet creation timed out).
 */
function setupBackfillSheets_(tickers) {
  var cfg = BACKFILL_RANGE_CFG;
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var queueSheet = getOrCreateSheet_(ss, cfg.QUEUE_SHEET, BACKFILL_QUEUE_HEADER_);
  queueSheet.clear();
  queueSheet.appendRow(BACKFILL_QUEUE_HEADER_);
  queueSheet.setFrozenRows(1);
  queueSheet
    .getRange(2, 1, tickers.length, 3)
    .setValues(tickers.map(function(t) { return [t, 'PENDING', '']; }));

  var stageSheet = getOrCreateSheet_(ss, cfg.STAGE_SHEET, BACKFILL_STAGE_HEADER_);
  stageSheet.clear();
  stageSheet.appendRow(BACKFILL_STAGE_HEADER_);
  stageSheet.setFrozenRows(1);
  // Keep the Date column as plain text so "2026-10-05" is never silently
  // converted to a date serial (and shifted by a timezone) on write.
  stageSheet.getRange(1, 2, stageSheet.getMaxRows(), 1).setNumberFormat('@');
}

/**
 * Retry wrapper for transient Google-side failures ("Service Spreadsheets
 * timed out", "Internal error", ...). Anything else is rethrown immediately.
 * Only wrap operations that are safe to repeat.
 */
function backfillRetry_(label, fn) {
  var attempts = 4;

  for (var i = 1; i <= attempts; i++) {
    try {
      return fn();

    } catch (err) {
      var msg = String(err && err.message ? err.message : err);
      var transient = /timed out|Service Spreadsheets|Service error|Internal error|try again|temporarily/i.test(msg);

      if (!transient || i === attempts) throw err;

      logWarn_(
        BACKFILL_RANGE_CFG.LOG_MODULE,
        null,
        label + ' hit a transient error (attempt ' + i + '/' + attempts + '): ' + msg.slice(0, 120)
      );
      Utilities.sleep(2000 * i);
    }
  }
}

function backfillDailySyncIsRunning_() {
  var st = parseJsonSafe_(
    PropertiesService.getScriptProperties().getProperty(SYS_CONFIG.DAILY_SYNC.STATE_KEY),
    null
  );
  return !!(st && st.status === 'RUNNING');
}

/* ------------------------------------------------------------------ */
/* Batch worker                                                        */
/* ------------------------------------------------------------------ */

function runBackfillRangeBatch_(startTime) {
  var cfg = BACKFILL_RANGE_CFG;
  var module = cfg.LOG_MODULE;
  var props = PropertiesService.getScriptProperties();

  var state = parseJsonSafe_(props.getProperty(cfg.STATE_KEY), null);

  if (!state || state.status !== 'RUNNING') {
    logInfo_(module, null, 'No active range backfill state. Worker idle.');
    deleteTriggersByHandler_('backfillRangeWorker');
    return;
  }

  // Yield to the daily sync: it shares the spreadsheet, the script lock and the
  // GOOGLEFINANCE buffer sheet. The trigger stays installed and tries again.
  if (backfillDailySyncIsRunning_()) {
    logInfo_(module, null, 'Daily sync is running. Range backfill worker yielding this cycle.');
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var queueSheet = ss.getSheetByName(cfg.QUEUE_SHEET);
  var stageSheet = ss.getSheetByName(cfg.STAGE_SHEET);

  // Fail loudly instead of silently recreating an empty sheet.
  if (!queueSheet || !stageSheet) {
    throw new Error(
      'Backfill sheets are missing (' + cfg.QUEUE_SHEET + ' / ' + cfg.STAGE_SHEET +
        '). Run resetBackfillRange() then startBackfillRange().'
    );
  }

  var tempSheet = getBufferSheet_(ss);

  var data = backfillRetry_('Read queue', function() {
    var lastRow = queueSheet.getLastRow();
    return lastRow >= 2 ? queueSheet.getRange(2, 1, lastRow - 1, 3).getValues() : [];
  });

  var pending = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][1]) === 'PENDING') pending.push(i);
  }

  if (pending.length === 0) {
    finishBackfillRange_(state, startTime);
    return;
  }

  var targetMap = {};
  cfg.TARGET_DATES.forEach(function(d) { targetMap[d] = true; });

  var stageRows = [];
  var processed = 0;

  for (var p = 0; p < pending.length && processed < cfg.BATCH_TICKERS; p++) {
    var idx = pending[p];
    var ticker = normalizeTicker_(data[idx][0]);

    try {
      var bars = fetchGoogleFinanceBarsForRange_(
        tempSheet,
        ticker,
        cfg.FETCH_FROM,
        cfg.FETCH_TO
      );

      var kept = 0;
      for (var b = 0; b < bars.length; b++) {
        if (targetMap[bars[b].dateKey]) {
          stageRows.push([
            ticker,
            bars[b].dateKey,
            bars[b].open,
            bars[b].high,
            bars[b].low,
            bars[b].close,
            bars[b].volume
          ]);
          kept++;
        }
      }

      data[idx][1] = kept > 0 ? 'DONE' : 'NODATA';
      data[idx][2] = kept + ' target bars (of ' + bars.length + ' fetched)';

    } catch (err) {
      var msg = String(err && err.message ? err.message : err);

      // "#N/A" or "no market rows" = Google genuinely has nothing for this
      // symbol in the window (e.g. delisted). Anything else (Loading, timeout)
      // is treated as transient and can be retried.
      var noData = msg.indexOf('#N/A') >= 0 || msg.indexOf('no market rows') >= 0;
      data[idx][1] = noData ? 'NODATA' : 'ERROR';
      data[idx][2] = msg.slice(0, 200);
    }

    processed++;

    if (Date.now() - startTime > cfg.MAX_RUNTIME_MS) {
      logWarn_(module, startTime, 'Runtime guard hit. Processed=' + processed + ' in this run.');
      break;
    }
  }

  // Stage first, queue statuses second: if we crash in between, the tickers
  // stay PENDING and get re-fetched; duplicate stage rows are harmless because
  // assembly keys on ticker+date.
  if (stageRows.length > 0) {
    backfillRetry_('Write stage rows', function() {
      stageSheet
        .getRange(stageSheet.getLastRow() + 1, 1, stageRows.length, BACKFILL_STAGE_HEADER_.length)
        .setValues(stageRows);
    });
  }

  backfillRetry_('Write queue statuses', function() {
    queueSheet
      .getRange(2, 2, data.length, 2)
      .setValues(data.map(function(r) { return [r[1], r[2]]; }));
  });

  var remaining = pending.length - processed;

  logInfo_(
    module,
    startTime,
    'Range backfill batch done. Processed=' + processed +
      ', StagedRows=' + stageRows.length +
      ', RemainingTickers=' + remaining
  );

  if (remaining <= 0) {
    finishBackfillRange_(state, startTime);
  }
}

/* ------------------------------------------------------------------ */
/* Assemble + push                                                     */
/* ------------------------------------------------------------------ */

function finishBackfillRange_(state, startTime) {
  var cfg = BACKFILL_RANGE_CFG;
  var module = cfg.LOG_MODULE;
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var queueSheet = ss.getSheetByName(cfg.QUEUE_SHEET);
  var stageSheet = ss.getSheetByName(cfg.STAGE_SHEET);
  if (!queueSheet || !stageSheet) {
    throw new Error('Backfill sheets are missing at finish time.');
  }

  var qLast = queueSheet.getLastRow();
  var qData = qLast >= 2 ? queueSheet.getRange(2, 1, qLast - 1, 3).getValues() : [];

  var counts = { DONE: 0, NODATA: 0, ERROR: 0, PENDING: 0 };
  var errorTickers = [];
  var noDataTickers = [];

  qData.forEach(function(r) {
    var s = String(r[1]);
    counts[s] = (counts[s] || 0) + 1;
    if (s === 'ERROR') errorTickers.push(r[0]);
    if (s === 'NODATA') noDataTickers.push(r[0]);
  });

  // Transient failures: do not push a partial picture. Park and wait for retry.
  if (errorTickers.length > 0) {
    state.status = 'NEEDS_RETRY';
    props.setProperty(cfg.STATE_KEY, JSON.stringify(state));
    deleteTriggersByHandler_('backfillRangeWorker');

    logWarn_(
      module,
      startTime,
      'Backfill paused: ' + errorTickers.length + ' tickers hit transient errors (' +
        errorTickers.slice(0, 20).join(', ') +
        '). Run retryBackfillRangeErrors() to retry them. Nothing was pushed.'
    );
    return;
  }

  var barsByTicker = loadBackfillStageBars_(stageSheet);
  var universeByDate = fetchBackfillUniverseByDate_(cfg.TARGET_DATES);

  var plan = buildBackfillPlan_(cfg.TARGET_DATES, universeByDate, barsByTicker, cfg.ALIASES);

  // Sanity gate BEFORE any push.
  var tooMissing = plan.filter(function(p) {
    return p.missing.length > cfg.MAX_MISSING_PER_DATE;
  });

  if (tooMissing.length > 0) {
    state.status = 'NEEDS_REVIEW';
    props.setProperty(cfg.STATE_KEY, JSON.stringify(state));
    deleteTriggersByHandler_('backfillRangeWorker');

    logError_(
      module,
      startTime,
      'Backfill aborted before push: too many missing tickers on ' +
        tooMissing.map(function(p) { return p.date + ' (' + p.missing.length + ')'; }).join(', ') +
        '. Inspect the ' + cfg.STAGE_SHEET + ' / ' + cfg.QUEUE_SHEET + ' sheets.'
    );
    return;
  }

  var summary = [];

  for (var i = 0; i < plan.length; i++) {
    var p = plan[i];

    var payloadRows = p.rows.map(function(r) {
      return normalizeOhlcvRowForCloudflare_(r, p.date);
    });

    var result = postCloudflareInBatches_('/ingest/ohlcv', payloadRows, {
      throwOnFailure: true
    });

    if (Number(result.acceptedRows) !== payloadRows.length) {
      throw new Error(
        'Cloudflare accepted row mismatch. Date=' + p.date +
          ', Expected=' + payloadRows.length +
          ', Accepted=' + result.acceptedRows
      );
    }

    summary.push({
      date: p.date,
      universe: p.universeCount,
      pushed: payloadRows.length,
      missing: p.missing,
      aliased: p.aliased
    });
  }

  state.status = 'DONE';
  state.finishedAt = nowIso_();
  props.setProperty(cfg.STATE_KEY, JSON.stringify(state));
  deleteTriggersByHandler_('backfillRangeWorker');

  Logger.log(JSON.stringify({ queueCounts: counts, noDataTickers: noDataTickers, summary: summary }, null, 2));

  var totalPushed = summary.reduce(function(s, x) { return s + x.pushed; }, 0);
  var withMissing = summary.filter(function(x) { return x.missing.length > 0; });

  writeSystemLog(
    module,
    withMissing.length > 0 ? 'WARN' : 'INFO',
    getElapsedSeconds_(startTime),
    'Range backfill pushed. Dates=' + summary.length +
      ', TotalRows=' + totalPushed +
      ', NoDataTickers=' + noDataTickers.length +
      (withMissing.length > 0
        ? ', DatesWithMissing=' + withMissing.map(function(x) {
            return x.date + '[' + x.missing.join('/') + ']';
          }).join(' ')
        : ', AllUniverseTickersCovered=true')
  );
}

function loadBackfillStageBars_(stageSheet) {
  var last = stageSheet.getLastRow();
  var values = last >= 2
    ? stageSheet.getRange(2, 1, last - 1, BACKFILL_STAGE_HEADER_.length).getValues()
    : [];

  var bars = {};

  for (var i = 0; i < values.length; i++) {
    var t = normalizeTicker_(values[i][0]);
    var d = normalizeDateKey_(values[i][1]);
    if (!t || !d) continue;

    if (!bars[t]) bars[t] = {};
    bars[t][d] = values[i]; // later duplicates simply overwrite earlier ones
  }

  return bars;
}

/**
 * Pure function (no Apps Script services): for each target date, decide which
 * rows to push, which universe tickers have no bar, and which were filled from
 * an alias symbol. Only tickers in that date's universe are ever pushed, so a
 * bar for e.g. TWLO on 2026-10-05 (before it joined) is ignored.
 */
function buildBackfillPlan_(targetDates, universeByDate, barsByTicker, aliases) {
  var plan = [];

  for (var i = 0; i < targetDates.length; i++) {
    var d = targetDates[i];
    var uni = universeByDate[d] || [];
    var rows = [];
    var missing = [];
    var aliased = [];

    for (var j = 0; j < uni.length; j++) {
      var t = uni[j];
      var bar = barsByTicker[t] && barsByTicker[t][d] ? barsByTicker[t][d] : null;

      if (!bar) {
        var alts = aliases[t] || [];
        for (var a = 0; a < alts.length; a++) {
          if (barsByTicker[alts[a]] && barsByTicker[alts[a]][d]) {
            bar = barsByTicker[alts[a]][d];
            aliased.push(t + '<-' + alts[a]);
            break;
          }
        }
      }

      if (bar) {
        rows.push([t, d, bar[2], bar[3], bar[4], bar[5], bar[6]]);
      } else {
        missing.push(t);
      }
    }

    plan.push({
      date: d,
      universeCount: uni.length,
      rows: rows,
      missing: missing,
      aliased: aliased
    });
  }

  return plan;
}

/* ------------------------------------------------------------------ */
/* Universe lookup + precondition                                      */
/* ------------------------------------------------------------------ */

function fetchBackfillUniverseByDate_(dates) {
  assertCloudflareConfig_();

  var out = {};

  for (var i = 0; i < dates.length; i++) {
    var d = dates[i];
    var res = UrlFetchApp.fetch(
      SYS_CONFIG.CLOUDFLARE.BASE_URL + '/api/universe?date=' + encodeURIComponent(d),
      { muteHttpExceptions: true }
    );

    var text = res.getContentText();
    var body = parseJsonSafe_(text, null);

    if (
      res.getResponseCode() !== 200 ||
      !body ||
      body.ok === false ||
      !Array.isArray(body.data) ||
      body.data.length === 0
    ) {
      throw new Error(
        'Universe fetch failed for ' + d + ': HTTP ' + res.getResponseCode() + ' ' + text.slice(0, 200)
      );
    }

    out[d] = body.data
      .map(function(r) { return normalizeTicker_(r.ticker); })
      .filter(function(t) { return !!t; });
  }

  return out;
}

function assertMembershipPatchedForOct2026_(universeByDate) {
  var u5 = universeByDate['2026-10-05'];
  var u6 = universeByDate['2026-10-06'];

  if (!u5 || !u6) {
    throw new Error('TARGET_DATES must include 2026-10-05 and 2026-10-06 for the precondition check.');
  }

  function has(list, t) { return list.indexOf(t) >= 0; }

  var problems = [];

  if (!has(u5, 'WBD')) problems.push('2026-10-05 should include WBD');
  if (!has(u5, 'PSKY')) problems.push('2026-10-05 should include PSKY');
  if (!has(u5, 'CTVA')) problems.push('2026-10-05 should include CTVA');
  if (!has(u5, 'VYLR')) problems.push('2026-10-05 should include VYLR');
  if (has(u5, 'SKYD')) problems.push('2026-10-05 should NOT include SKYD');
  if (has(u5, 'TWLO')) problems.push('2026-10-05 should NOT include TWLO');

  if (has(u6, 'WBD')) problems.push('2026-10-06 should NOT include WBD');
  if (has(u6, 'PSKY')) problems.push('2026-10-06 should NOT include PSKY');
  if (has(u6, 'CTVA')) problems.push('2026-10-06 should NOT include CTVA');
  if (!has(u6, 'VYLR')) problems.push('2026-10-06 should include VYLR');
  if (!has(u6, 'SKYD')) problems.push('2026-10-06 should include SKYD');
  if (!has(u6, 'TWLO')) problems.push('2026-10-06 should include TWLO');

  if (problems.length > 0) {
    throw new Error(
      'index_membership_periods is not patched as expected -- apply the membership SQL first. ' +
        problems.join('; ')
    );
  }
}

/* ------------------------------------------------------------------ */
/* Derive afterwards                                                   */
/* ------------------------------------------------------------------ */

/**
 * Re-derive 2026-10-05 .. 2026-10-22 after the raw push.
 * This must include the dates that were already derived (10-16, 10-19, 10-20,
 * 10-22): they were computed while 10-05..10-15 were missing, so their SMA /
 * return / high-low windows spanned the gap.
 *
 * Each date's derive reads raw data only, so order does not matter.
 */
function deriveBackfilledDates() {
  return deriveBackfilledDates_(false);
}

/**
 * Same, but bypasses the quality gate. Use ONLY if the strict run fails solely
 * because a delisted name (WBD / PSKY on 2026-10-05) has no bar anywhere --
 * that date then derives with coverage_count < universe_count, which records
 * the gap honestly.
 */
function deriveBackfilledDatesAllowFail() {
  return deriveBackfilledDates_(true);
}

function deriveBackfilledDates_(allowFail) {
  var startTime = Date.now();
  var cfg = BACKFILL_RANGE_CFG;
  var all = [];

  for (var w = 0; w < cfg.DERIVE_WINDOWS.length; w++) {
    var win = cfg.DERIVE_WINDOWS[w];
    var path =
      '/jobs/derive/range?from=' + win.from + '&to=' + win.to +
      '&limit=10&stopOnFail=false' +
      (allowFail ? '&allowFailQuality=true' : '');

    var res = UrlFetchApp.fetch(SYS_CONFIG.CLOUDFLARE.BASE_URL + path, {
      method: 'post',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + getCloudflareIngestToken_() }
    });

    var body = parseJsonSafe_(res.getContentText(), {});

    all.push({
      window: win.from + '..' + win.to,
      http: res.getResponseCode(),
      success: body.success_count,
      failed: body.failure_count,
      results: (body.results || []).map(function(r) {
        return {
          date: r.date,
          ok: r.ok,
          quality: r.quality_status,
          error: r.error,
          missing: r.missing_samples,
          extra: r.extra_samples
        };
      }),
      rawError: body.ok === false && !body.results ? body.error : undefined
    });
  }

  Logger.log(JSON.stringify(all, null, 2));

  var failed = 0;
  all.forEach(function(x) { failed += Number(x.failed || 0); });

  writeSystemLog(
    cfg.LOG_MODULE,
    failed > 0 ? 'WARN' : 'INFO',
    getElapsedSeconds_(startTime),
    'Backfilled dates re-derived. AllowFail=' + allowFail + ', FailedDates=' + failed +
      '. Check Apps Script Logger for per-date results.'
  );

  return all;
}

/* ------------------------------------------------------------------ */
/* Operator helpers                                                    */
/* ------------------------------------------------------------------ */

function inspectBackfillRange() {
  var cfg = BACKFILL_RANGE_CFG;
  var stateText = PropertiesService.getScriptProperties().getProperty(cfg.STATE_KEY);

  var out = { state: parseJsonSafe_(stateText, null), counts: {}, notDone: [] };

  var queueSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cfg.QUEUE_SHEET);

  if (queueSheet && queueSheet.getLastRow() >= 2) {
    var data = queueSheet.getRange(2, 1, queueSheet.getLastRow() - 1, 3).getValues();

    data.forEach(function(r) {
      var s = String(r[1]);
      out.counts[s] = (out.counts[s] || 0) + 1;
      if (s !== 'DONE' && out.notDone.length < 40) {
        out.notDone.push(r[0] + ' [' + s + '] ' + r[2]);
      }
    });
  }

  Logger.log(JSON.stringify(out, null, 2));

  writeSystemLog(
    cfg.LOG_MODULE,
    'INFO',
    '0s',
    'Range backfill inspected. Check Apps Script Logger.'
  );
}

function retryBackfillRangeErrors() {
  var cfg = BACKFILL_RANGE_CFG;
  var props = PropertiesService.getScriptProperties();
  var state = parseJsonSafe_(props.getProperty(cfg.STATE_KEY), null);

  if (!state) throw new Error('No backfill state. Run startBackfillRange() first.');

  var queueSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cfg.QUEUE_SHEET);
  if (!queueSheet || queueSheet.getLastRow() < 2) throw new Error('Queue sheet is missing or empty.');

  var data = queueSheet.getRange(2, 1, queueSheet.getLastRow() - 1, 3).getValues();
  var reset = 0;

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][1]) === 'ERROR') {
      data[i][1] = 'PENDING';
      data[i][2] = '';
      reset++;
    }
  }

  queueSheet.getRange(2, 2, data.length, 2).setValues(data.map(function(r) { return [r[1], r[2]]; }));

  state.status = 'RUNNING';
  props.setProperty(cfg.STATE_KEY, JSON.stringify(state));
  installEveryMinutesTrigger_('backfillRangeWorker', cfg.WORKER_EVERY_MINUTES);

  logWarn_(cfg.LOG_MODULE, null, 'Reset ' + reset + ' ERROR tickers to PENDING and restarted the worker.');

  backfillRangeWorker();
}

function resetBackfillRange() {
  var cfg = BACKFILL_RANGE_CFG;

  PropertiesService.getScriptProperties().deleteProperty(cfg.STATE_KEY);
  deleteTriggersByHandler_('backfillRangeWorker');

  logWarn_(cfg.LOG_MODULE, null, 'Range backfill state reset and worker trigger cleared.');
}