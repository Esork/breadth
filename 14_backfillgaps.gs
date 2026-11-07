/**
 * 14_BackfillGaps.gs
 *
 * ONE-OFF companion to 13_BackfillRange.gs (delete both together once the
 * 2026-10 recovery is verified). Depends on helpers defined there:
 * BACKFILL_RANGE_CFG, backfillDailySyncIsRunning_().
 *
 * After the range backfill, a handful of (ticker, date) pairs were still
 * missing from D1 raw, which keeps the quality gate on FAIL for those dates:
 *   - SKYD on every backfilled date except 10-05
 *   - ECHO on 10-09 / 10-12 / 10-21
 *   - eight names on 10-09 (CB CHD CMI CNP CPAY CRH CRL ECHO)
 *
 * This tool asks the Worker what is missing RIGHT NOW (same check the gate
 * runs), re-fetches just those tickers with a tight date window, tries
 * alternative GOOGLEFINANCE spellings, and reports what each attempt returned.
 *
 *   fillBackfillGapsDryRun()  fetch + report only. Writes NOTHING to D1.
 *   fillBackfillGaps()        same, then pushes the bars it found.
 *   previewGapDerive()        lists the dates that would be derived with holes.
 *   deriveGapDatesAllowFail() derives only the still-failing dates, and only if
 *                             every missing ticker is in ACCEPTED_MISSING.
 *
 *   inspectSheetCacheDates()          read-only: what the Sheet cache still holds.
 *   previewSheetCachePush_20261023()  what pushing 10-23 from the Sheet would do.
 *   pushSheetCacheDate_20261023()     pushes 10-23 from the Sheet cache to D1.
 *   previewRecover_20261028()         fetch what 10-28 is short of; pushes NOTHING.
 *   recover_20261028()                push 10-28 to D1 (Sheet rows + re-fetched tickers).
 *   rederiveDependentDates()          strict (re-)derive of REDERIVE_AFTER: 10-28, 10-29, 10-30.
 *
 * RESULT OF THE 2026-10-26 DRY RUN: Google returned no bar for any of the
 * missing pairs under any symbol spelling (SKYD, ECHO, and eight names on
 * 10-09), so fillBackfillGaps() has nothing to push.
 *
 * RECOMMENDED ORDER (each step only after the daily sync has finished):
 *   Done in the first round (10-06..10-23): the sheet push of 10-23, then
 *   previewGapDerive() / deriveGapDatesAllowFail().
 *
 *   2026-10-28 round:
 *   1. inspectSheetCacheDates()     is 10-28 still in the Sheet? which tickers are short?
 *   2. previewRecover_20261028()    then recover_20261028()
 *   3. rederiveDependentDates()     LAST: derives 10-28, recomputes 10-29 and 10-30
 *
 * The Sheet cache keeps only the latest 3 dates, so step 2 has a deadline: the
 * daily run that first sees a 4th newer date prunes 10-28 -- 2026-11-03 (Tue),
 * when the run collects the 11-02 bar. After that the whole day has to be
 * re-fetched from GOOGLEFINANCE with startBackfillRange(). Re-run the dry run first if time has passed -- Google's
 * data does change.
 *
 * "Borrowing" (SKYD <- PSKY): PSKY became SKYD on 2026-10-06, same security.
 * The dry run always PRINTS what the old symbol returns so you can judge
 * continuity, but those bars are only USED when BORROW_ENABLED is true.
 * Default is false on purpose: a stale or frozen old-symbol series would put
 * wrong prices into D1.
 */

var BACKFILL_GAPS_CFG = {
  LOG_MODULE: 'BACKFILL_RANGE',

  // Extra GOOGLEFINANCE spellings tried (in order) after the plain ticker.
  SYMBOL_VARIANTS: { SKYD: ['NYSE:SKYD'] },

  // Same security under its previous symbol. Previewed always, used only if enabled.
  BORROW_FROM: { SKYD: ['NASDAQ:PSKY', 'PSKY'] },
  BORROW_ENABLED: false,

  // Fetch a little wider than the missing dates; tight windows behave
  // differently from the 18-day range used by the first pass.
  PAD_DAYS: 4,

  MAX_RUNTIME_MS: 5 * 60 * 1000,

  // Tickers whose bars are CONFIRMED unobtainable for the dates in question:
  // the 2026-10-26 dry run showed Google returns no row for them under any
  // symbol spelling (and the old PSKY series ends 10-05). deriveGapDatesAllowFail()
  // may derive a date with holes ONLY if every missing ticker on that date is
  // listed here -- so a NEW, unexpected gap can never be papered over by it.
  ACCEPTED_MISSING: ['SKYD', 'ECHO', 'CB', 'CHD', 'CMI', 'CNP', 'CPAY', 'CRH', 'CRL'],
  MAX_ACCEPTED_MISSING_PER_DATE: 12,

  // Dates outside the original range backfill that need handling too.
  // 2026-10-23: the daily pipeline collected it into the Sheet cache but never
  // pushed it to D1 -- one ticker had no bar, so the health gate failed on every
  // run that tried to process it. The Sheet cache keeps only the latest 3 dates,
  // so it must be pushed before the daily run that prunes it.
  EXTRA_DATES: ['2026-10-23', '2026-10-28'],

  // 2026-10-28: five tickers (GL GLW GM GNRC IBKR) threw errors during the daily
  // fetch -- "Failed", not "no data" -- so the health gate failed and nothing was
  // pushed. 10-29 and 10-30 then went in normally, leaving 10-28 as a hole.
  // Recovered by recoverSheetDate_(): the Sheet's 498 rows + a fresh Google fetch
  // for the missing five. Refused if more than this many tickers need re-fetching,
  // because that would mean the Sheet copy is not what we think it is.
  MAX_RECOVER_FROM_GOOGLE: 25,

  // Dates to (re-)derive STRICTLY after the gaps are fixed. Indicators use
  // ROW_NUMBER() per ticker (not calendar days), so one missing day shifts every
  // later window: while 10-28 was absent, 10-29's "1d" return was measured
  // against 10-27 and its 5d return one session too far back. So: 10-28 itself
  // (first derive), plus 10-29 and 10-30 (recompute with complete history).
  REDERIVE_AFTER: ['2026-10-28', '2026-10-29', '2026-10-30']
};

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function fillBackfillGapsDryRun() {
  return runBackfillGapFill_(true);
}

function fillBackfillGaps() {
  return runBackfillGapFill_(false);
}

function runBackfillGapFill_(dryRun) {
  var startTime = Date.now();
  var cfg = BACKFILL_GAPS_CFG;
  var module = cfg.LOG_MODULE;

  if (backfillDailySyncIsRunning_()) {
    throw new Error(
      'Daily sync is RUNNING right now (it shares this spreadsheet, the script lock and the ' +
        'GOOGLEFINANCE buffer sheet). Wait until inspectDailySyncState() shows no state, then run again.'
    );
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Could not get the script lock (another worker is busy). Try again in a few minutes.');
  }

  var result;

  try {
    result = backfillGapFillLocked_(dryRun, startTime);
  } finally {
    lock.releaseLock();
  }

  var unresolvedTickers = Object.keys(result.unresolved);
  var unresolvedPairs = 0;
  unresolvedTickers.forEach(function(t) { unresolvedPairs += result.unresolved[t].length; });

  writeSystemLog(
    module,
    unresolvedPairs > 0 ? 'WARN' : 'INFO',
    getElapsedSeconds_(startTime),
    'Gap fill (' + (dryRun ? 'DRY RUN, nothing pushed' : 'PUSHED') + '). ' +
      'GapPairs=' + result.gapPairs +
      ', Found=' + result.foundPairs +
      ', Unresolved=' + unresolvedPairs +
      (unresolvedPairs > 0
        ? ' [' + unresolvedTickers.map(function(t) {
            return t + ':' + result.unresolved[t].map(function(d) { return d.slice(5); }).join('/');
          }).join(' ') + ']'
        : '') +
      (result.incomplete ? ', INCOMPLETE (runtime guard hit - run again)' : '')
  );

  return result;
}

/* ------------------------------------------------------------------ */
/* Sheet cache: what is still there, and pushing one day from it       */
/* ------------------------------------------------------------------ */

/** Dates this tool works on: the range backfill dates plus EXTRA_DATES, ascending. */
function backfillGapDates_() {
  return BACKFILL_RANGE_CFG.TARGET_DATES
    .concat(BACKFILL_GAPS_CFG.EXTRA_DATES)
    .slice()
    .sort();
}

/**
 * Read-only. For every date still held in the Sheet's OHLCV cache: row count,
 * and which tickers of the CURRENT registry are missing or extra. The cache
 * keeps only the latest 3 dates (the daily run prunes it after a successful
 * push), so this shows what can still be pushed from the Sheet before it is gone.
 */
function inspectSheetCacheDates() {
  var summary = summarizeCacheDates_(readSheetCacheRows_(), readCurrentEligibleTickers_());

  Logger.log(JSON.stringify(summary, null, 2));

  var dates = Object.keys(summary);

  writeSystemLog(
    BACKFILL_GAPS_CFG.LOG_MODULE,
    'INFO',
    '0s',
    'Sheet cache dates: ' + dates.map(function(d) {
      var s = summary[d];
      return d + ' rows=' + s.rows + (s.missing.length ? ' missing=[' + s.missing.join('/') + ']' : '');
    }).join(' | ')
  );

  return summary;
}

/** Shows what pushing 10-23 from the Sheet cache would do. Pushes nothing. */
function previewSheetCachePush_20261023() {
  return pushSheetCacheDate_('2026-10-23', true);
}

/**
 * Push 2026-10-23 from the Sheet cache to D1. Allowed only if every missing
 * ticker is in ACCEPTED_MISSING, there are no extras and no duplicate rows.
 * Run previewSheetCachePush_20261023() first.
 */
function pushSheetCacheDate_20261023() {
  return pushSheetCacheDate_('2026-10-23', false);
}

function pushSheetCacheDate_(dateKey, previewOnly) {
  var startTime = Date.now();
  var cfg = BACKFILL_GAPS_CFG;
  var module = cfg.LOG_MODULE;

  if (backfillDailySyncIsRunning_()) {
    throw new Error(
      'Daily sync is RUNNING right now. Wait until inspectDailySyncState() shows no state, then run again.'
    );
  }

  var summary = summarizeCacheDates_(readSheetCacheRows_(), readCurrentEligibleTickers_());
  var s = summary[dateKey];

  if (!s) {
    throw new Error(
      'The Sheet cache has no rows for ' + dateKey + '. It keeps only the latest 3 dates and currently holds: ' +
        (Object.keys(summary).join(', ') || '(nothing)') +
        '. If it has been pruned, the day has to be re-fetched from GOOGLEFINANCE instead.'
    );
  }

  var accepted = {};
  cfg.ACCEPTED_MISSING.forEach(function(t) { accepted[t] = true; });

  var problems = [];
  var unaccepted = s.missing.filter(function(t) { return !accepted[t]; });

  if (s.extras.length > 0) problems.push('unexpected extra ticker(s): ' + s.extras.join('/'));
  if (unaccepted.length > 0) problems.push('missing ticker(s) not in ACCEPTED_MISSING: ' + unaccepted.join('/'));
  if (s.missing.length > cfg.MAX_ACCEPTED_MISSING_PER_DATE) {
    problems.push(s.missing.length + ' missing exceeds limit ' + cfg.MAX_ACCEPTED_MISSING_PER_DATE);
  }
  if (s.duplicates > 0) problems.push(s.duplicates + ' duplicate row(s) in the cache');

  Logger.log(JSON.stringify({
    mode: previewOnly ? 'PREVIEW' : 'PUSH',
    date: dateKey,
    analysis: s,
    problems: problems
  }));

  if (problems.length > 0) {
    throw new Error('Refusing to push ' + dateKey + ' from the Sheet cache: ' + problems.join('; '));
  }

  if (previewOnly) {
    writeSystemLog(
      module,
      'INFO',
      getElapsedSeconds_(startTime),
      'Sheet cache push PREVIEW. Date=' + dateKey + ', Rows=' + s.rows +
        ', Missing=[' + s.missing.join('/') + '] (all in ACCEPTED_MISSING)'
    );
    return s;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Could not get the script lock (another worker is busy). Try again in a few minutes.');
  }

  var payload;

  try {
    // No health argument on purpose: the health gate is exactly what refused
    // this day (one ticker short). The ACCEPTED_MISSING checks above replace it.
    payload = pushOhlcvDateFromTailToCloudflare_(dateKey, 3000);
  } finally {
    lock.releaseLock();
  }

  if (Number(payload.rows) !== s.rows || Number(payload.acceptedRows) !== s.rows) {
    throw new Error(
      'Push count mismatch for ' + dateKey + '. SheetRows=' + s.rows +
        ', Pushed=' + payload.rows + ', Accepted=' + payload.acceptedRows
    );
  }

  writeSystemLog(
    module,
    'INFO',
    getElapsedSeconds_(startTime),
    'Pushed ' + dateKey + ' from the Sheet cache. Rows=' + s.rows +
      ', Accepted=' + payload.acceptedRows + ', Missing=[' + s.missing.join('/') + ']'
  );

  return payload;
}

function readSheetCacheRows_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);
  var lastRow = dbSheet.getLastRow();

  if (lastRow < 2) return [];

  var values = dbSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var out = [];

  for (var i = 0; i < values.length; i++) {
    var t = normalizeTicker_(values[i][0]);
    var d = normalizeDateKey_(values[i][1]);
    if (t && d) out.push({ ticker: t, date: d });
  }

  return out;
}

function readCurrentEligibleTickers_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var registrySheet = getRegistrySheet_(ss);

  return readEligibleTickerListFromRegistry_(registrySheet)
    .map(function(t) { return normalizeTicker_(t); })
    .filter(function(t) { return !!t; });
}

/**
 * Pure: per date, row count, duplicates, and which tickers of the given
 * eligible list are missing or extra. Compared against the CURRENT registry,
 * which is the right universe for the latest few dates the cache holds.
 */
function summarizeCacheDates_(rows, eligible) {
  var eligibleMap = {};
  eligible.forEach(function(t) { eligibleMap[t] = true; });

  var byDate = {};

  rows.forEach(function(r) {
    if (!byDate[r.date]) byDate[r.date] = { present: {}, rowCount: 0 };
    byDate[r.date].present[r.ticker] = true;
    byDate[r.date].rowCount++;
  });

  var out = {};

  Object.keys(byDate).sort().forEach(function(d) {
    var present = byDate[d].present;
    var uniqueCount = Object.keys(present).length;

    out[d] = {
      rows: byDate[d].rowCount,
      uniqueTickers: uniqueCount,
      duplicates: byDate[d].rowCount - uniqueCount,
      expected: eligible.length,
      missing: eligible.filter(function(t) { return !present[t]; }).sort(),
      extras: Object.keys(present).filter(function(t) { return !eligibleMap[t]; }).sort()
    };
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* Recover one day: Sheet cache rows + a fresh fetch for what is short */
/* ------------------------------------------------------------------ */

/** What recovering 2026-10-28 would do. Fetches from Google, pushes NOTHING. */
function previewRecover_20261028() {
  return recoverSheetDate_('2026-10-28', true);
}

/** Recover 2026-10-28 into D1. Run previewRecover_20261028() first. */
function recover_20261028() {
  return recoverSheetDate_('2026-10-28', false);
}

/**
 * For a day the daily run collected into the Sheet but never pushed because a
 * few tickers FAILED (threw errors, as opposed to Google having no bar):
 *   1. take the rows the Sheet cache holds for that date,
 *   2. ask the Worker which tickers the quality gate expects that day,
 *   3. re-fetch only the missing ones from Google for exactly that date,
 *   4. push the combined set straight to D1.
 *
 * Nothing is written to the Sheet. Rows for tickers outside that day's
 * universe are dropped. If anything is STILL missing afterwards it must be in
 * ACCEPTED_MISSING (and few); otherwise the push is refused.
 *
 * Unlike a rerun of startDailySyncNow(), this does not depend on what Google
 * calls the "latest" bar, so it has no time-of-day deadline -- only the
 * Sheet cache's, which keeps just the latest 3 dates.
 */
function recoverSheetDate_(dateKey, previewOnly) {
  var startTime = Date.now();
  var cfg = BACKFILL_GAPS_CFG;
  var module = cfg.LOG_MODULE;

  if (backfillDailySyncIsRunning_()) {
    throw new Error(
      'Daily sync is RUNNING right now. Wait until inspectDailySyncState() shows no state, then run again.'
    );
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Could not get the script lock (another worker is busy). Try again in a few minutes.');
  }

  var result;

  try {
    result = recoverSheetDateLocked_(dateKey, previewOnly, startTime);
  } finally {
    lock.releaseLock();
  }

  return result;
}

function recoverSheetDateLocked_(dateKey, previewOnly, startTime) {
  var cfg = BACKFILL_GAPS_CFG;
  var module = cfg.LOG_MODULE;

  var universe = fetchBackfillUniverseByDate_([dateKey])[dateKey];

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);

  // Already normalized payload objects { ticker, date, open, high, low, close, volume, source }.
  // Throws if the Sheet holds duplicate ticker+date rows.
  var sheetRows = readOhlcvRowsFromTailByDate_(dbSheet, dateKey, 3000);

  if (sheetRows.length === 0) {
    throw new Error(
      'The Sheet cache has no rows for ' + dateKey + ' (it keeps only the latest 3 dates, so it has ' +
        'probably been pruned). Run inspectSheetCacheDates() to see what it holds. If it is gone, the whole ' +
        'day has to be re-fetched from GOOGLEFINANCE with startBackfillRange().'
    );
  }

  var plan = planRecoverDate_(universe, sheetRows);

  if (plan.missing.length > cfg.MAX_RECOVER_FROM_GOOGLE) {
    throw new Error(
      plan.missing.length + ' tickers are missing from the Sheet copy of ' + dateKey +
        ' (limit ' + cfg.MAX_RECOVER_FROM_GOOGLE + '). That is not a few failed fetches; investigate before pushing.'
    );
  }

  var tempSheet = getBufferSheet_(ss);
  var startKey = backfillShiftDateKey_(dateKey, -cfg.PAD_DAYS);
  var endKey = backfillShiftDateKey_(dateKey, cfg.PAD_DAYS);

  var recovered = [];     // normalized payload rows
  var recoveredClose = {};
  var attempts = {};
  var incomplete = false;

  for (var i = 0; i < plan.missing.length; i++) {
    var ticker = plan.missing[i];
    var symbols = [ticker].concat(cfg.SYMBOL_VARIANTS[ticker] || []);
    var found = false;
    attempts[ticker] = [];

    for (var s = 0; s < symbols.length && !found; s++) {
      if (Date.now() - startTime > cfg.MAX_RUNTIME_MS) { incomplete = true; break; }

      var attempt = tryFetchGapSymbol_(tempSheet, symbols[s], startKey, endKey);
      var match = attempt.ok ? matchGapBars_([dateKey], attempt.bars) : { found: [], remaining: [dateKey] };

      attempts[ticker].push(
        symbols[s] + ': ' + (attempt.ok ? (match.found.length ? 'got ' + dateKey : 'no bar for ' + dateKey) : attempt.message)
      );

      if (match.found.length > 0) {
        var bar = match.found[0].bar;

        recovered.push(
          normalizeOhlcvRowForCloudflare_([ticker, dateKey, bar.open, bar.high, bar.low, bar.close, bar.volume], dateKey)
        );
        recoveredClose[ticker] = bar.close;
        found = true;
      }
    }

    if (incomplete) break;
  }

  var stillMissing = plan.missing.filter(function(t) { return recoveredClose[t] === undefined; });

  var accepted = {};
  cfg.ACCEPTED_MISSING.forEach(function(t) { accepted[t] = true; });

  var problems = [];
  var unaccepted = stillMissing.filter(function(t) { return !accepted[t]; });

  if (incomplete) problems.push('runtime guard hit before every missing ticker was tried - run again');
  if (unaccepted.length > 0) problems.push('still missing and not in ACCEPTED_MISSING: ' + unaccepted.join('/'));
  if (stillMissing.length > cfg.MAX_ACCEPTED_MISSING_PER_DATE) {
    problems.push(stillMissing.length + ' still missing exceeds limit ' + cfg.MAX_ACCEPTED_MISSING_PER_DATE);
  }

  var payload = plan.keep.concat(recovered);

  Logger.log(JSON.stringify({
    mode: previewOnly ? 'PREVIEW' : 'PUSH',
    date: dateKey,
    universe: universe.length,
    sheetRows: sheetRows.length,
    keptFromSheet: plan.keep.length,
    droppedNotInUniverse: plan.dropped,
    missingFromSheet: plan.missing,
    recovered: recoveredClose,
    attempts: attempts,
    stillMissing: stillMissing,
    wouldPush: payload.length,
    problems: problems
  }));

  if (previewOnly) {
    writeSystemLog(
      module,
      problems.length > 0 ? 'WARN' : 'INFO',
      getElapsedSeconds_(startTime),
      'Recover PREVIEW ' + dateKey + '. Universe=' + universe.length + ', FromSheet=' + plan.keep.length +
        ', Recovered=' + recovered.length + '/' + plan.missing.length +
        ', WouldPush=' + payload.length +
        (stillMissing.length > 0 ? ', StillMissing=[' + stillMissing.join('/') + ']' : '') +
        (problems.length > 0 ? ' | PROBLEMS: ' + problems.join('; ') : '')
    );

    return { universe: universe.length, fromSheet: plan.keep.length, recovered: recoveredClose, stillMissing: stillMissing, wouldPush: payload.length, problems: problems };
  }

  if (problems.length > 0) {
    throw new Error('Refusing to push ' + dateKey + ': ' + problems.join('; '));
  }

  var pushed = postCloudflareInBatches_('/ingest/ohlcv', payload, { throwOnFailure: true });

  if (Number(pushed.acceptedRows) !== payload.length) {
    throw new Error(
      'Cloudflare accepted row mismatch. Date=' + dateKey +
        ', Expected=' + payload.length + ', Accepted=' + pushed.acceptedRows
    );
  }

  writeSystemLog(
    module,
    'INFO',
    getElapsedSeconds_(startTime),
    'Recovered ' + dateKey + ' into D1. Rows=' + payload.length + ' (FromSheet=' + plan.keep.length +
      ', Refetched=' + recovered.length + ')' +
      (stillMissing.length > 0 ? ', StillMissing=[' + stillMissing.join('/') + ']' : ', Complete=true')
  );

  return pushed;
}

/**
 * Pure: split the Sheet rows into those the day's universe expects (keep) and
 * those it does not (dropped), and list the universe tickers with no row
 * (missing). universe is an array of ticker strings.
 */
function planRecoverDate_(universe, sheetRows) {
  var universeMap = {};
  universe.forEach(function(t) { universeMap[t] = true; });

  var keep = [];
  var dropped = [];
  var present = {};

  sheetRows.forEach(function(r) {
    if (universeMap[r.ticker]) {
      keep.push(r);
      present[r.ticker] = true;
    } else {
      dropped.push(r.ticker);
    }
  });

  var missing = universe.filter(function(t) { return !present[t]; }).sort();

  return { keep: keep, dropped: dropped.sort(), missing: missing };
}

/* ------------------------------------------------------------------ */
/* Re-derive dates whose windows were computed while gaps existed      */
/* ------------------------------------------------------------------ */

/**
 * STRICT (no allowFailQuality) derive of REDERIVE_AFTER dates. Run this LAST,
 * after the gap day has been pushed, so every row-number window sees the
 * complete history. Dates that were never derived get their first derive;
 * dates already derived are recomputed (INSERT OR REPLACE).
 */
function rederiveDependentDates() {
  var startTime = Date.now();
  var cfg = BACKFILL_GAPS_CFG;

  if (backfillDailySyncIsRunning_()) {
    throw new Error(
      'Daily sync is RUNNING right now. Wait until inspectDailySyncState() shows no state, then run again.'
    );
  }

  var results = [];

  for (var i = 0; i < cfg.REDERIVE_AFTER.length; i++) {
    var d = cfg.REDERIVE_AFTER[i];

    var res = UrlFetchApp.fetch(
      SYS_CONFIG.CLOUDFLARE.BASE_URL +
        '/jobs/derive/range?from=' + d + '&to=' + d + '&limit=1&stopOnFail=false',
      {
        method: 'post',
        muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + getCloudflareIngestToken_() }
      }
    );

    var body = parseJsonSafe_(res.getContentText(), {});
    var r = (body.results && body.results[0]) || {};

    results.push({
      date: d,
      http: res.getResponseCode(),
      ok: r.ok === true,
      quality: r.quality_status,
      derived: r.derived,
      error: r.error || (r.ok === true ? undefined : body.error)
    });
  }

  Logger.log(JSON.stringify(results));

  var failed = results.filter(function(x) { return !x.ok; });

  writeSystemLog(
    cfg.LOG_MODULE,
    failed.length > 0 ? 'WARN' : 'INFO',
    getElapsedSeconds_(startTime),
    'Dependent dates re-derived (strict). Done=' + (results.length - failed.length) + '/' + results.length +
      (failed.length > 0
        ? ', Failed=[' + failed.map(function(x) { return x.date.slice(5) + ':' + (x.error || 'unknown'); }).join(' ') + ']'
        : '')
  );

  return results;
}

/* ------------------------------------------------------------------ */
/* Derive the dates whose holes cannot be filled                       */
/* ------------------------------------------------------------------ */

/** Shows which dates WOULD be derived and with what coverage. Derives nothing. */
function previewGapDerive() {
  return deriveGapDatesAllowFail_(true);
}

/**
 * For every backfilled date that is STILL failing the quality gate, derive it
 * with allowFailQuality=true -- but only if every missing ticker on that date is
 * in ACCEPTED_MISSING (and the count is small). Dates that already pass are
 * skipped, so unlike deriveBackfilledDatesAllowFail() this does not redo the
 * expensive derive for dates that are already fine.
 *
 * The derived rows record the gap honestly: coverage_count < universe_count,
 * and ohlcv_quality_daily keeps status FAIL with the missing tickers listed.
 */
function deriveGapDatesAllowFail() {
  return deriveGapDatesAllowFail_(false);
}

function deriveGapDatesAllowFail_(previewOnly) {
  var startTime = Date.now();
  var cfg = BACKFILL_GAPS_CFG;
  var module = cfg.LOG_MODULE;
  var dates = backfillGapDates_();

  if (backfillDailySyncIsRunning_()) {
    throw new Error(
      'Daily sync is RUNNING right now. Wait until inspectDailySyncState() shows no state, then run again.'
    );
  }

  var gapInfo = findBackfillGaps_(dates);

  if (gapInfo.extras.length > 0) {
    throw new Error(
      'Unexpected EXTRA tickers present (' + gapInfo.extras.join(', ') +
        '). That is not a missing-data situation; investigate before deriving.'
    );
  }

  var accepted = {};
  cfg.ACCEPTED_MISSING.forEach(function(t) { accepted[t] = true; });

  // Invert ticker -> dates into date -> tickers.
  var missingByDate = {};
  Object.keys(gapInfo.gaps).forEach(function(t) {
    gapInfo.gaps[t].forEach(function(d) {
      if (!missingByDate[d]) missingByDate[d] = [];
      missingByDate[d].push(t);
    });
  });

  var plan = planGapDerive_(dates, gapInfo.perDate, missingByDate, accepted, cfg.MAX_ACCEPTED_MISSING_PER_DATE);

  Logger.log(JSON.stringify({ mode: previewOnly ? 'PREVIEW' : 'DERIVE', plan: plan }));

  if (plan.refused.length > 0) {
    throw new Error(
      'Refusing to derive with holes: ' +
        plan.refused.map(function(r) { return r.date + ' (' + r.reason + ')'; }).join('; ')
    );
  }

  if (previewOnly || plan.toDerive.length === 0) {
    writeSystemLog(
      module,
      'INFO',
      getElapsedSeconds_(startTime),
      (previewOnly ? 'Gap derive PREVIEW. ' : 'Gap derive: nothing to do. ') +
        'WouldDerive=' + plan.toDerive.length +
        (plan.toDerive.length > 0
          ? ' [' + plan.toDerive.map(function(x) { return x.date.slice(5) + ':-' + x.missing.length; }).join(' ') + ']'
          : '') +
        ', AlreadyOK=' + plan.alreadyOk.length
    );
    return plan;
  }

  var results = [];

  for (var i = 0; i < plan.toDerive.length; i++) {
    var d = plan.toDerive[i].date;

    var res = UrlFetchApp.fetch(
      SYS_CONFIG.CLOUDFLARE.BASE_URL +
        '/jobs/derive/range?from=' + d + '&to=' + d +
        '&limit=1&stopOnFail=false&allowFailQuality=true',
      {
        method: 'post',
        muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + getCloudflareIngestToken_() }
      }
    );

    var body = parseJsonSafe_(res.getContentText(), {});
    var r = (body.results && body.results[0]) || {};

    results.push({
      date: d,
      http: res.getResponseCode(),
      ok: r.ok === true,
      quality: r.quality_status,
      derived: r.derived,
      error: r.error || (r.ok === true ? undefined : body.error)
    });
  }

  Logger.log(JSON.stringify(results));

  var failed = results.filter(function(x) { return !x.ok; });

  writeSystemLog(
    module,
    failed.length > 0 ? 'WARN' : 'INFO',
    getElapsedSeconds_(startTime),
    'Gap derive (allowFailQuality). Derived=' + (results.length - failed.length) + '/' + results.length +
      (failed.length > 0
        ? ', Failed=[' + failed.map(function(x) { return x.date.slice(5); }).join(' ') + ']'
        : '')
  );

  return { plan: plan, results: results };
}

/**
 * Pure: decide which dates get derived, which are already fine, and which are
 * refused (a missing ticker outside the accepted list, or too many missing).
 */
function planGapDerive_(dates, perDate, missingByDate, accepted, maxMissing) {
  var toDerive = [];
  var alreadyOk = [];
  var refused = [];

  for (var i = 0; i < dates.length; i++) {
    var d = dates[i];
    var info = perDate[d];
    var missing = (missingByDate[d] || []).slice().sort();

    if (info && info.noRaw) {
      refused.push({
        date: d,
        reason: 'no raw rows in D1 yet - push that day first (see pushSheetCacheDate_20261023)'
      });
      continue;
    }

    if (info && info.status === 'OK' && missing.length === 0) {
      alreadyOk.push(d);
      continue;
    }

    var unaccepted = missing.filter(function(t) { return !accepted[t]; });

    if (unaccepted.length > 0) {
      refused.push({ date: d, reason: 'unaccepted missing ticker(s): ' + unaccepted.join('/') });
      continue;
    }

    if (missing.length > maxMissing) {
      refused.push({ date: d, reason: missing.length + ' missing exceeds limit ' + maxMissing });
      continue;
    }

    var expected = info ? Number(info.expected) : 0;

    toDerive.push({
      date: d,
      missing: missing,
      coverage: expected > 0 ? Math.round(((expected - missing.length) / expected) * 1000) / 10 : null
    });
  }

  return { toDerive: toDerive, alreadyOk: alreadyOk, refused: refused };
}

/* ------------------------------------------------------------------ */
/* Core                                                                */
/* ------------------------------------------------------------------ */

function backfillGapFillLocked_(dryRun, startTime) {
  var cfg = BACKFILL_GAPS_CFG;
  var dates = backfillGapDates_();

  var gapInfo = findBackfillGaps_(dates);
  var gapTickers = Object.keys(gapInfo.gaps).sort();

  var gapPairs = 0;
  gapTickers.forEach(function(t) { gapPairs += gapInfo.gaps[t].length; });

  Logger.log(JSON.stringify({
    mode: dryRun ? 'DRY_RUN' : 'PUSH',
    perDate: gapInfo.perDate,
    gaps: gapInfo.gaps,
    unexpectedExtras: gapInfo.extras
  }));

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tempSheet = getBufferSheet_(ss);

  var foundRows = [];                 // { ticker, date, row, source }
  var unresolved = {};                // ticker -> [dates]
  var incomplete = false;

  for (var g = 0; g < gapTickers.length; g++) {
    var ticker = gapTickers[g];
    var missingDates = gapInfo.gaps[ticker];

    var startKey = backfillShiftDateKey_(missingDates[0], -cfg.PAD_DAYS);
    var endKey = backfillShiftDateKey_(missingDates[missingDates.length - 1], cfg.PAD_DAYS);

    var remaining = missingDates.slice();
    var entry = { ticker: ticker, missing: missingDates, attempts: [], borrowPreview: [] };

    var symbols = [ticker].concat(cfg.SYMBOL_VARIANTS[ticker] || []);

    for (var s = 0; s < symbols.length && remaining.length > 0; s++) {
      if (Date.now() - startTime > cfg.MAX_RUNTIME_MS) { incomplete = true; break; }

      var attempt = tryFetchGapSymbol_(tempSheet, symbols[s], startKey, endKey);
      var match = attempt.ok ? matchGapBars_(remaining, attempt.bars) : { found: [], remaining: remaining };

      entry.attempts.push({
        symbol: symbols[s],
        ok: attempt.ok,
        message: attempt.ok ? undefined : attempt.message,
        returned: attempt.ok ? compactBarMap_(attempt.bars) : undefined,
        filled: match.found.map(function(f) { return f.date; })
      });

      match.found.forEach(function(f) {
        foundRows.push({
          ticker: ticker,
          date: f.date,
          row: [ticker, f.date, f.bar.open, f.bar.high, f.bar.low, f.bar.close, f.bar.volume],
          source: symbols[s]
        });
      });

      remaining = match.remaining;
    }

    var borrowSymbols = cfg.BORROW_FROM[ticker] || [];

    for (var b = 0; b < borrowSymbols.length && remaining.length > 0; b++) {
      if (Date.now() - startTime > cfg.MAX_RUNTIME_MS) { incomplete = true; break; }

      var borrowAttempt = tryFetchGapSymbol_(tempSheet, borrowSymbols[b], startKey, endKey);
      var borrowMatch = borrowAttempt.ok
        ? matchGapBars_(remaining, borrowAttempt.bars)
        : { found: [], remaining: remaining };

      entry.borrowPreview.push({
        symbol: borrowSymbols[b],
        ok: borrowAttempt.ok,
        message: borrowAttempt.ok ? undefined : borrowAttempt.message,
        returned: borrowAttempt.ok ? compactBarMap_(borrowAttempt.bars) : undefined,
        wouldFill: borrowMatch.found.map(function(f) { return f.date; }),
        used: cfg.BORROW_ENABLED
      });

      if (cfg.BORROW_ENABLED) {
        borrowMatch.found.forEach(function(f) {
          foundRows.push({
            ticker: ticker,
            date: f.date,
            row: [ticker, f.date, f.bar.open, f.bar.high, f.bar.low, f.bar.close, f.bar.volume],
            source: 'borrowed:' + borrowSymbols[b]
          });
        });
        remaining = borrowMatch.remaining;
      }
    }

    if (remaining.length > 0) unresolved[ticker] = remaining;
    entry.stillMissing = remaining;

    // One line per ticker keeps each Logger entry small enough not to be truncated.
    Logger.log(JSON.stringify(entry));

    if (incomplete) break;
  }

  if (!dryRun && foundRows.length > 0) {
    pushGapRowsByDate_(foundRows);
  }

  return {
    dryRun: dryRun,
    gapPairs: gapPairs,
    foundPairs: foundRows.length,
    unresolved: unresolved,
    incomplete: incomplete
  };
}

function pushGapRowsByDate_(foundRows) {
  var byDate = {};

  foundRows.forEach(function(f) {
    if (!byDate[f.date]) byDate[f.date] = [];
    byDate[f.date].push(normalizeOhlcvRowForCloudflare_(f.row, f.date));
  });

  Object.keys(byDate).sort().forEach(function(d) {
    var rows = byDate[d];
    var result = postCloudflareInBatches_('/ingest/ohlcv', rows, { throwOnFailure: true });

    if (Number(result.acceptedRows) !== rows.length) {
      throw new Error(
        'Cloudflare accepted row mismatch. Date=' + d +
          ', Expected=' + rows.length + ', Accepted=' + result.acceptedRows
      );
    }
  });
}

/* ------------------------------------------------------------------ */
/* What is missing right now                                           */
/* ------------------------------------------------------------------ */

function findBackfillGaps_(dates) {
  assertCloudflareConfig_();

  var gaps = {};
  var extras = [];
  var perDate = {};

  for (var i = 0; i < dates.length; i++) {
    var d = dates[i];

    var fetched = fetchBackfillQualityForDate_(d);
    var q = fetched.q;

    // A date with no raw rows in D1 at all is not a "gap": the whole day is
    // absent, and the quality check would list every ticker as missing.
    if (Number(q.raw_rows || 0) === 0) {
      perDate[d] = {
        source: fetched.source,
        status: q.status,
        expected: q.expected_count,
        rawRows: 0,
        missing: Number(q.missing_count || 0),
        extra: 0,
        noRaw: true
      };
      continue;
    }

    var missing = q.missing_samples || [];

    // The Worker caps samples at 50. If that ever truncates, we would silently
    // under-fill, so stop instead.
    if (Number(q.missing_count || 0) > missing.length) {
      throw new Error(
        'Missing list truncated for ' + d + ' (missing_count=' + q.missing_count +
          ', listed=' + missing.length + '). This is not a small-gap situation; investigate first.'
      );
    }

    missing.forEach(function(t) {
      var tk = normalizeTicker_(t);
      if (!gaps[tk]) gaps[tk] = [];
      gaps[tk].push(d);
    });

    (q.extra_samples || []).forEach(function(t) {
      extras.push(d + ':' + normalizeTicker_(t));
    });

    perDate[d] = {
      source: fetched.source,
      status: q.status,
      expected: q.expected_count,
      rawRows: q.raw_rows,
      missing: Number(q.missing_count || 0),
      extra: Number(q.extra_count || 0)
    };
  }

  return { gaps: gaps, extras: extras, perDate: perDate };
}

/**
 * Preferred: the live read-only check (recomputed from current raw data).
 * Fallback: the quality row the last derive run stored in D1 -- a plain SELECT,
 * and identical to live as long as raw has not changed since that derive run.
 *
 * Why the fallback exists: every Worker route does `return handleX(...)` without
 * await, so any error inside a handler bypasses the router's try/catch and
 * surfaces as an opaque Cloudflare "error code: 1101" instead of a JSON error.
 * A transient D1 hiccup on the live route should not stop this tool.
 */
function fetchBackfillQualityForDate_(d) {
  var base = SYS_CONFIG.CLOUDFLARE.BASE_URL;
  var enc = encodeURIComponent(d);

  var live = tryHttpJsonWithRetry_(base + '/api/quality/check?date=' + enc, 3);

  if (live.ok && live.body && live.body.quality) {
    return { source: 'live', q: live.body.quality };
  }

  var stored = tryHttpJsonWithRetry_(base + '/api/data-quality?date=' + enc, 2);

  if (stored.ok && stored.body && stored.body.data) {
    var row = stored.body.data;

    return {
      source: 'stored',
      q: {
        status: row.status,
        expected_count: row.expected_count,
        raw_rows: row.raw_rows,
        missing_count: row.missing_count,
        extra_count: row.extra_count,
        missing_samples: parseJsonSafe_(row.missing_samples_json, []),
        extra_samples: parseJsonSafe_(row.extra_samples_json, [])
      }
    };
  }

  throw new Error(
    'Could not get quality for ' + d + '. Live check: ' + live.message +
      ' | Stored row: ' + (stored.ok ? 'no stored quality row for this date' : stored.message)
  );
}

/** GET + JSON parse. Retries network errors and 5xx; gives up at once on 4xx. */
function tryHttpJsonWithRetry_(url, attempts) {
  var last = 'no attempt made';

  for (var i = 1; i <= attempts; i++) {
    try {
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var code = res.getResponseCode();
      var text = res.getContentText();

      if (code === 200) {
        var body = parseJsonSafe_(text, null);
        if (body) return { ok: true, body: body };
        last = 'HTTP 200 but response was not JSON';
      } else {
        last = 'HTTP ' + code + ' ' + String(text).slice(0, 80);
        if (code >= 400 && code < 500) break; // a client error will not fix itself
      }

    } catch (err) {
      last = String(err && err.message ? err.message : err).slice(0, 120);
    }

    if (i < attempts) Utilities.sleep(1500 * i);
  }

  return { ok: false, message: last };
}

/* ------------------------------------------------------------------ */
/* Fetch + pure helpers                                                */
/* ------------------------------------------------------------------ */

function tryFetchGapSymbol_(tempSheet, symbol, startKey, endKey) {
  try {
    var bars = fetchGoogleFinanceBarsForRange_(tempSheet, symbol, startKey, endKey);
    return { ok: true, bars: bars };

  } catch (err) {
    return { ok: false, message: String(err && err.message ? err.message : err).slice(0, 160) };
  }
}

/** { 'YYYY-MM-DD': close } for compact logging / human review. */
function compactBarMap_(bars) {
  var out = {};
  for (var i = 0; i < bars.length; i++) {
    out[bars[i].dateKey] = bars[i].close;
  }
  return out;
}

/** Pure: shift a 'YYYY-MM-DD' key by N days, timezone-safe. */
function backfillShiftDateKey_(key, days) {
  var p = String(key).split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + days));
  return d.toISOString().slice(0, 10);
}

/**
 * Pure: split the missing dates into those a fetched bar series covers and
 * those it does not. A bar only counts if its close is a positive number.
 */
function matchGapBars_(missingDates, bars) {
  var byDate = {};

  for (var i = 0; i < bars.length; i++) {
    var bar = bars[i];
    if (typeof bar.close === 'number' && bar.close > 0) {
      byDate[bar.dateKey] = bar;
    }
  }

  var found = [];
  var remaining = [];

  for (var j = 0; j < missingDates.length; j++) {
    var d = missingDates[j];
    if (byDate[d]) {
      found.push({ date: d, bar: byDate[d] });
    } else {
      remaining.push(d);
    }
  }

  return { found: found, remaining: remaining };
}