/**
 * 99_Admin.gs
 * Manual admin helpers. Safe entry points only.
 */

function bootstrapBackendSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  getRegistrySheet_(ss);
  getDbSheet_(ss);
  getBufferSheet_(ss);
  getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.LOGS, LOG_HEADER);
  writeSystemLog('ADMIN', 'INFO', '0s', 'Backend sheets bootstrapped.');
}

function inspectAllActiveStates() {
  var props = PropertiesService.getScriptProperties();
  [
    SYS_CONFIG.DAILY_SYNC.STATE_KEY,
    LEGACY_WORKER_STATE_KEYS.MISSING_BACKFILL,
    LEGACY_WORKER_STATE_KEYS.RANGE_BACKFILL,
    DAILY_LAST_HEALTH_PROP_KEY,
    CF_LAST_OHLCV_PUSH_PROP_KEY,
    PENDING_MEMBERSHIP_EVENTS_PROP_KEY
  ].forEach(function(key) { Logger.log(key + ' = ' + props.getProperty(key)); });
  var snapshot = buildTriggerSetupSnapshot_();
  Logger.log(JSON.stringify(snapshot, null, 2));
  writeSystemLog('ADMIN', 'INFO', '0s', 'States and triggers inspected. Check Apps Script Logger.');
}

function inspectOhlcvCacheDateAgainstCurrentRegistry(targetDate) {
  var dateKey = normalizeDateKey_(targetDate);
  if (!dateKey) throw new Error('Pass targetDate as YYYY-MM-DD.');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);
  var registrySheet = getRegistrySheet_(ss);
  var eligible = readEligibleTickerListForOhlcvDate_(registrySheet, dateKey);
  var eligibleMap = {};
  eligible.forEach(function(t) { eligibleMap[normalizeTicker_(t)] = true; });
  var lastRow = dbSheet.getLastRow();
  var values = lastRow < 2 ? [] : dbSheet.getRange(2, 1, lastRow - 1, OHLCV_HEADER.length).getValues();
  var presentMap = {}, extras = [];
  values.forEach(function(row) {
    var ticker = normalizeTicker_(row[0]);
    if (normalizeDateKey_(row[1]) !== dateKey || !ticker) return;
    presentMap[ticker] = true;
    if (!eligibleMap[ticker]) extras.push(ticker);
  });
  var missing = eligible.filter(function(t) { return !presentMap[normalizeTicker_(t)]; });
  var result = { date: dateKey, expectedEligibleCount: eligible.length,
    presentCount: Object.keys(presentMap).length, extras: extras.sort(), missing: missing.sort() };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function inspectPendingMembershipEvents() {
  var events = loadPendingMembershipEvents_();
  Logger.log(JSON.stringify(events, null, 2));

  writeSystemLog(
    SYS_CONFIG.CLOUDFLARE.LOG_MODULE,
    'INFO',
    '0s',
    'Pending membership events inspected. Count=' + events.length + '. Check Apps Script Logger.'
  );
}

function clearPendingMembershipEvents() {
  savePendingMembershipEvents_([]);
  Logger.log('Pending membership events cleared.');
}

function refreshSyncIndexFromDB() {
  var startTime = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);
  var registrySheet = getRegistrySheet_(ss);

  var lastRow = dbSheet.getLastRow();
  if (lastRow < 2) throw new Error('DB_OHLCV is empty.');

  var registryMap = loadRegistryMap_(registrySheet);

  var data = dbSheet
    .getRange(2, 1, lastRow - 1, 2)
    .getValues();

  for (var i = 0; i < data.length; i++) {
    var ticker = normalizeTicker_(data[i][0]);
    var dateKey = normalizeDateKey_(data[i][1]);

    if (!ticker || !dateKey) continue;

    if (!registryMap[ticker]) {
      registryMap[ticker] = {
        ticker: ticker,
        isCurrentSP500: false,
        isActive: true,
        source: 'db-rebuild'
      };
    }

    if (!registryMap[ticker].lastSyncedDate || dateKey > registryMap[ticker].lastSyncedDate) {
      registryMap[ticker].lastSyncedDate = dateKey;
    }

    registryMap[ticker].updatedAt = new Date();
  }

  saveRegistryMap_(registrySheet, registryMap);

  logInfo_(
    'SYNC_INDEX',
    startTime,
    'SYS_SYNC_INDEX rebuilt from DB_OHLCV. Registry tickers=' + Object.keys(registryMap).length
  );
}

function inspectLastDailyHealthGate() {
  var text = PropertiesService
    .getScriptProperties()
    .getProperty(DAILY_LAST_HEALTH_PROP_KEY);

  Logger.log(DAILY_LAST_HEALTH_PROP_KEY + ' = ' + text);

  writeSystemLog(
    SYS_CONFIG.DAILY_SYNC.LOG_MODULE,
    'INFO',
    '0s',
    'Last daily health gate inspected. Check Apps Script Logger.'
  );
}

function inspectDailySyncState() {
  var stateText = PropertiesService
    .getScriptProperties()
    .getProperty(SYS_CONFIG.DAILY_SYNC.STATE_KEY);

  Logger.log(SYS_CONFIG.DAILY_SYNC.STATE_KEY + ' = ' + stateText);

  writeSystemLog(
    SYS_CONFIG.DAILY_SYNC.LOG_MODULE,
    'INFO',
    '0s',
    'Daily sync state inspected. Check Apps Script Logger.'
  );
}

function resetDailySyncState() {
  PropertiesService
    .getScriptProperties()
    .deleteProperty(SYS_CONFIG.DAILY_SYNC.STATE_KEY);

  deleteTriggersByHandler_('dailySyncWorker');

  writeSystemLog(
    SYS_CONFIG.DAILY_SYNC.LOG_MODULE,
    'WARN',
    '0s',
    'Daily sync state reset and worker trigger cleared.'
  );
}

function createMissingAuditFormula(targetDateKeys) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.AUDIT_MISSING, null);
  if (!targetDateKeys || targetDateKeys.length === 0) {
    throw new Error('targetDateKeys required.');
  }
  sheet.clear();

  var registryName = SYS_CONFIG.SHEETS.SYNC_INDEX;
  var dbName = SYS_CONFIG.SHEETS.DB;

  var blocks = [];

  for (var i = 0; i < targetDateKeys.length; i++) {
    var dateKey = normalizeDateKey_(targetDateKeys[i]);

    blocks.push(
      'IFNA(FILTER({' +
        registryName + '!A2:A,IF(' + registryName + '!A2:A<>"","' + dateKey + '",)' +
      '},' +
        registryName + '!A2:A<>"",' +
        registryName + '!H2:H=TRUE,' +
        registryName + '!I2:I=TRUE,' +
        'ISNA(MATCH(' +
          registryName + '!A2:A&"|' + dateKey + '",' +
          dbName + '!A:A&"|"&TEXT(' + dbName + '!B:B,"yyyy-mm-dd"),' +
          '0' +
        '))' +
      '),{"",""})'
    );
  }

  var formula =
    '={"Ticker","MissingDate";' +
      'QUERY({' + blocks.join(';') + '},' +
      '"select Col1, Col2 where Col1 is not null",' +
      '0)' +
    '}';

  sheet.getRange('A1').setFormula(formula);
  sheet.setFrozenRows(1);

  writeSystemLog(
    'AUDIT_OHLCV',
    'INFO',
    '0s',
    'Missing audit formula created for current eligible tickers. Dates=' +
      targetDateKeys.join(', ')
  );
}

function countAuditMissingRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SYS_CONFIG.SHEETS.AUDIT_MISSING);
  if (!sheet) throw new Error('Missing sheet: ' + SYS_CONFIG.SHEETS.AUDIT_MISSING);

  var count = Math.max(sheet.getLastRow() - 1, 0);

  writeSystemLog(
    'AUDIT_OHLCV',
    count === 0 ? 'INFO' : 'WARN',
    '0s',
    'Current formula audit missing rows=' + count
  );

  return count;
}

/**
 * Legacy callbacks: remove stale triggers only; never run or clear old jobs.
 */
function stopLegacyWorkerTrigger_(handlerName) {
  var deleted = deleteTriggersByHandler_(handlerName);
  writeSystemLog('ADMIN', 'WARN', '0s',
    'Retired legacy worker trigger. Handler=' + handlerName + ', Deleted=' + deleted);
}
function backfillMissingWorker() { stopLegacyWorkerTrigger_('backfillMissingWorker'); }
function runMissingOnlyBackfillBatch() { stopLegacyWorkerTrigger_('runMissingOnlyBackfillBatch'); }
function backfillRangeWorker() { stopLegacyWorkerTrigger_('backfillRangeWorker'); }

function inspectTriggerSetup() {
  var result = buildTriggerSetupSnapshot_();

  Logger.log(JSON.stringify(result, null, 2));

  writeSystemLog(
    'TRIGGER_SETUP',
    'INFO',
    '0s',
    'Trigger setup inspected. ProductionTriggers=' +
      result.productionTriggers.length +
      ', WorkerTriggers=' +
      result.workerTriggers.length +
      ', OtherTriggers=' +
      result.otherTriggers.length +
      ', BlockingStates=' +
      result.blockingStates.length
  );

  return result;
}

function inspectLastCloudflareOhlcvPush() {
  var text = PropertiesService.getScriptProperties().getProperty(CF_LAST_OHLCV_PUSH_PROP_KEY);
  Logger.log(CF_LAST_OHLCV_PUSH_PROP_KEY + ' = ' + text);
  writeSystemLog(SYS_CONFIG.CLOUDFLARE.LOG_MODULE, 'INFO', '0s',
    'Last Cloudflare OHLCV push inspected. Check Apps Script Logger.');
}

function backfillV2_RunNextBatch() { stopLegacyWorkerTrigger_('backfillV2_RunNextBatch'); }
function continueBackfillOHLCV() { stopLegacyWorkerTrigger_('continueBackfillOHLCV'); }
function continueDailyIncrementalSync() { stopLegacyWorkerTrigger_('continueDailyIncrementalSync'); }
function cloudflareHistoricalOhlcvWorker() { stopLegacyWorkerTrigger_('cloudflareHistoricalOhlcvWorker'); }
function cloudflareOhlcvSyncWorker() { stopLegacyWorkerTrigger_('cloudflareOhlcvSyncWorker'); }


/* ------------------------------------------------------------------
 * TEMPORARY INCIDENT RECOVERY — 2026-11-02 through 2026-11-05
 *
 * Scope is intentionally hard-coded. This module:
 * - never changes production sync cursors/state;
 * - never prunes or deletes cache rows;
 * - uses the existing daily_OHLCV_CACHE as its staging source;
 * - uses a dedicated Script Property + dedicated worker trigger;
 * - upserts complete date sets to Cloudflare and verifies before derive.
 *
 * Remove this block and the temporary config/trigger registration after
 * the incident is verified and the recovery PR is merged.
 * ------------------------------------------------------------------ */

var NOV2026_OHLCV_RECOVERY_DATES_ = [
  '2026-11-02',
  '2026-11-03',
  '2026-11-04',
  '2026-11-05'
];
var NOV2026_OHLCV_RECOVERY_STATE_KEY_ = 'QE_OHLCV_INCIDENT_RECOVERY_NOV2026_V1';
var NOV2026_OHLCV_RECOVERY_LAST_KEY_ = 'QE_OHLCV_INCIDENT_RECOVERY_NOV2026_LAST_V1';
var NOV2026_OHLCV_RECOVERY_BATCH_SIZE_ = 12;
var NOV2026_OHLCV_RECOVERY_MAX_ATTEMPTS_ = 3;

/**
 * Read-only preview. Run this first.
 * Logs cache coverage and Cloudflare's current quality result for each date.
 */
function previewNov2026OhlcvRecovery() {
  var plan = buildNov2026OhlcvRecoveryPlan_();
  Logger.log(JSON.stringify(plan, null, 2));
  return plan;
}

/**
 * Starts the isolated recovery worker. Run only after reviewing preview output.
 * The worker continues on a dedicated one-minute trigger; no manual batch
 * execution is required.
 */
function startNov2026OhlcvRecovery() {
  var props = PropertiesService.getScriptProperties();
  var existingState = props.getProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_);
  if (existingState) {
    throw new Error('Recovery state already exists. Inspect/resume it; do not start a second run.');
  }

  assertNov2026RecoveryCanStart_();
  var plan = buildNov2026OhlcvRecoveryPlan_();
  assertNov2026RecoveryPlanSafe_(plan);

  var state = {
    status: 'RUNNING',
    phase: 'FETCH',
    dates: NOV2026_OHLCV_RECOVERY_DATES_.slice(),
    tickers: plan.tickerUnion,
    cursor: 0,
    attempts: {},
    startedAt: new Date().toISOString(),
    lastError: null
  };

  props.setProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_, JSON.stringify(state));
  installEveryMinutesTrigger_('runNov2026OhlcvRecoveryWorker', 1);
  Logger.log('Recovery started. Tickers=' + state.tickers.length +
    ', dates=' + state.dates.join(', ') + '. Dedicated worker trigger installed.');
  return { started: true, tickerCount: state.tickers.length, dates: state.dates };
}

/** Dedicated trigger callback. Do not run production daily sync concurrently. */
function runNov2026OhlcvRecoveryWorker() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Recovery worker skipped: another script execution holds the lock.');
    return;
  }

  var startedAt = Date.now();
  try {
    var props = PropertiesService.getScriptProperties();
    var stateText = props.getProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_);
    if (!stateText) {
      deleteTriggersByHandler_('runNov2026OhlcvRecoveryWorker');
      Logger.log('No active recovery state. Dedicated trigger removed.');
      return;
    }

    var state = parseJsonSafe_(stateText, null);
    if (!state || state.status !== 'RUNNING') {
      deleteTriggersByHandler_('runNov2026OhlcvRecoveryWorker');
      Logger.log('Recovery is not RUNNING. Dedicated trigger removed.');
      return;
    }

    if (state.phase === 'FETCH') {
      runNov2026OhlcvRecoveryFetchBatch_(state, startedAt);
      if (state.cursor >= state.tickers.length) {
        state.phase = 'FINALIZE';
        props.setProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_, JSON.stringify(state));
      }
    }

    if (state.phase === 'FINALIZE') {
      var recoveryDone = finalizeNov2026OhlcvRecovery_(state);
      if (!recoveryDone) return;
      var summary = {
        status: 'DONE',
        dates: state.dates,
        tickerCount: state.tickers.length,
        startedAt: state.startedAt,
        finishedAt: new Date().toISOString()
      };
      props.setProperty(NOV2026_OHLCV_RECOVERY_LAST_KEY_, JSON.stringify(summary));
      props.deleteProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_);
      deleteTriggersByHandler_('runNov2026OhlcvRecoveryWorker');
      writeSystemLog('ADMIN_RECOVERY', 'INFO', getElapsedSeconds_(startedAt),
        'November 2026 OHLCV recovery completed. ' + JSON.stringify(summary));
      Logger.log(JSON.stringify(summary, null, 2));
    }
  } catch (err) {
    var propsOnError = PropertiesService.getScriptProperties();
    var text = propsOnError.getProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_);
    var failedState = parseJsonSafe_(text, {});
    failedState.status = 'FAILED';
    failedState.lastError = String(err && err.stack ? err.stack : err);
    failedState.failedAt = new Date().toISOString();
    propsOnError.setProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_, JSON.stringify(failedState));
    deleteTriggersByHandler_('runNov2026OhlcvRecoveryWorker');
    writeSystemLog('ADMIN_RECOVERY', 'ERROR', getElapsedSeconds_(startedAt),
      'November 2026 OHLCV recovery paused. ' + String(err));
    Logger.log('RECOVERY FAILED: ' + String(err && err.stack ? err.stack : err));
  } finally {
    lock.releaseLock();
  }
}

/** Resume a FAILED recovery after reviewing its lastError. Upserts are idempotent. */
function resumeNov2026OhlcvRecovery() {
  var props = PropertiesService.getScriptProperties();
  var text = props.getProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_);
  var state = parseJsonSafe_(text, null);
  if (!state || state.status !== 'FAILED') {
    throw new Error('No FAILED recovery state exists. Nothing to resume.');
  }
  state.status = 'RUNNING';
  state.lastError = null;
  state.failedAt = null;
  state.attempts = state.attempts || {};
  if (state.phase === 'FETCH' && state.cursor < state.tickers.length) {
    delete state.attempts[state.tickers[state.cursor]];
  }
  props.setProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_, JSON.stringify(state));
  installEveryMinutesTrigger_('runNov2026OhlcvRecoveryWorker', 1);
  Logger.log('Recovery resumed at phase=' + state.phase + ', cursor=' +
    (state.phase === 'FETCH' ? state.cursor + '/' + state.tickers.length :
      Number(state.dateCursor || 0) + '/' + state.dates.length));
}

/** Read-only post-run verification. Requires recovery to have completed. */
function verifyNov2026OhlcvRecovery() {
  var props = PropertiesService.getScriptProperties();
  var active = props.getProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_);
  if (active) throw new Error('Recovery is still active or paused. Inspect state before verification.');

  var plan = buildNov2026OhlcvRecoveryPlan_();
  var results = [];
  var allOk = true;

  plan.dates.forEach(function(item) {
    var dashboard = fetchNov2026CloudflareJson_('/api/dashboard?date=' + encodeURIComponent(item.date));
    var marketRows = dashboard.data && dashboard.data.market ? 1 : 0;
    var sectorRows = dashboard.data && dashboard.data.sectors ? dashboard.data.sectors.length : 0;
    var runs = dashboard.data && dashboard.data.calculation_runs ? dashboard.data.calculation_runs : [];
    var deriveDone = runs.some(function(run) {
      return run.job_type === 'DERIVE_DAILY_BREADTH' && run.status === 'DONE';
    });
    var localOk = item.localMissing === 0 && item.localInvalid === 0 &&
      item.localValid === item.localExpected;
    var d1Ok = item.d1Quality.status === 'OK' &&
      item.d1Quality.missing_count === 0 &&
      item.d1Quality.extra_count === 0 &&
      item.d1Quality.duplicate_extra_rows === 0;
    var derivedOk = marketRows === 1 && sectorRows > 0 && deriveDone;
    var ok = localOk && d1Ok && derivedOk;
    if (!ok) allOk = false;
    results.push({
      date: item.date,
      ok: ok,
      local: {
        expected: item.localExpected,
        valid: item.localValid,
        missing: item.localMissing,
        invalid: item.localInvalid,
        extras: item.localExtras
      },
      d1Quality: item.d1Quality,
      derived: { marketRows: marketRows, sectorRows: sectorRows, deriveDone: deriveDone }
    });
  });

  var ref = plan.referenceDate;
  var referenceOk = ref.localMissing === 0 && ref.localInvalid === 0 &&
    ref.localExtras === 0 && ref.localValid === ref.localExpected &&
    ref.d1Quality.status === 'OK';
  if (!referenceOk) allOk = false;

  var output = {
    ok: allOk,
    referenceDate: {
      date: ref.date,
      ok: referenceOk,
      local: {
        expected: ref.localExpected,
        valid: ref.localValid,
        missing: ref.localMissing,
        invalid: ref.localInvalid,
        extras: ref.localExtras
      },
      d1Quality: ref.d1Quality
    },
    lastRun: parseJsonSafe_(props.getProperty(NOV2026_OHLCV_RECOVERY_LAST_KEY_), null),
    results: results
  };
  Logger.log(JSON.stringify(output, null, 2));
  return output;
}

function assertNov2026RecoveryCanStart_() {
  var props = PropertiesService.getScriptProperties();
  var snapshot = buildTriggerSetupSnapshot_();
  if (snapshot.blockingStates.length > 0) {
    throw new Error('Refusing recovery while another worker state exists: ' +
      JSON.stringify(snapshot.blockingStates));
  }

  var conflictingWorkers = snapshot.workerTriggers.filter(function(item) {
    return item.handler !== 'runNov2026OhlcvRecoveryWorker';
  });
  if (conflictingWorkers.length > 0) {
    throw new Error('Refusing recovery while other worker triggers exist: ' +
      JSON.stringify(conflictingWorkers));
  }

  if (props.getProperty(NOV2026_OHLCV_RECOVERY_STATE_KEY_)) {
    throw new Error('Recovery state already exists.');
  }
}

function buildNov2026OhlcvRecoveryPlan_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);
  var registrySheet = getRegistrySheet_(ss);
  var lastRow = dbSheet.getLastRow();
  var values = lastRow < 2 ? [] :
    dbSheet.getRange(2, 1, lastRow - 1, OHLCV_HEADER.length).getValues();

  var cacheMap = {};
  var duplicateKeys = [];
  var cacheDateCounts = {};
  var eligibleByDate = {};
  var tickerUnion = {};
  var scannedDates = NOV2026_OHLCV_RECOVERY_DATES_.concat(['2026-11-06']);

  NOV2026_OHLCV_RECOVERY_DATES_.forEach(function(dateKey) {
    eligibleByDate[dateKey] = readEligibleTickerListForOhlcvDate_(registrySheet, dateKey);
    eligibleByDate[dateKey].forEach(function(ticker) {
      tickerUnion[normalizeTicker_(ticker)] = true;
    });
  });
  eligibleByDate['2026-11-06'] =
    readEligibleTickerListForOhlcvDate_(registrySheet, '2026-11-06');

  for (var i = 0; i < values.length; i++) {
    var ticker = normalizeTicker_(values[i][0]);
    var dateKey = normalizeDateKey_(values[i][1]);
    if (!ticker || scannedDates.indexOf(dateKey) < 0) continue;
    var key = ticker + '|' + dateKey;
    if (cacheMap[key]) {
      duplicateKeys.push(key);
      continue;
    }
    cacheMap[key] = { row: values[i], rowNumber: i + 2 };
    cacheDateCounts[dateKey] = (cacheDateCounts[dateKey] || 0) + 1;
  }

  function summarizeDate_(dateKey) {
    var eligible = eligibleByDate[dateKey];
    var missing = [];
    var invalid = [];
    var extras = [];
    var validCount = 0;
    var eligibleMap = {};

    eligible.forEach(function(ticker) {
      var normalized = normalizeTicker_(ticker);
      eligibleMap[normalized] = true;
      var record = cacheMap[normalized + '|' + dateKey];
      if (!record) missing.push(ticker);
      else if (!isValidNov2026OhlcvRow_(record.row)) invalid.push(ticker);
      else validCount++;
    });

    Object.keys(cacheMap).forEach(function(key) {
      var parts = key.split('|');
      if (parts[1] === dateKey && !eligibleMap[parts[0]]) extras.push(parts[0]);
    });

    extras.sort();
    return {
      date: dateKey,
      localExpected: eligible.length,
      localValid: validCount,
      localMissing: missing.length,
      localInvalid: invalid.length,
      localExtras: extras.length,
      missingSamples: missing.slice(0, 25),
      invalidSamples: invalid.slice(0, 25),
      extraSamples: extras.slice(0, 25)
    };
  }

  var dateReports = NOV2026_OHLCV_RECOVERY_DATES_.map(function(dateKey) {
    var report = summarizeDate_(dateKey);
    report.d1Quality = fetchNov2026CloudflareQuality_(dateKey);
    return report;
  });

  var referenceReport = summarizeDate_('2026-11-06');
  referenceReport.d1Quality = fetchNov2026CloudflareQuality_('2026-11-06');

  return {
    scope: NOV2026_OHLCV_RECOVERY_DATES_.slice(),
    referenceDate: referenceReport,
    cacheRowsByDate: cacheDateCounts,
    duplicateKeyCount: duplicateKeys.length,
    duplicateKeySamples: duplicateKeys.slice(0, 30),
    tickerUnion: Object.keys(tickerUnion).sort(),
    dates: dateReports,
    note: 'Every eligible ticker/date from 11/2 through 11/5 will be re-fetched from GoogleFinance, including existing 11/4 and 11/5 rows. 11/6 is checked as a reference and is never modified.'
  };
}

function assertNov2026RecoveryPlanSafe_(plan) {
  if (plan.duplicateKeyCount > 0) {
    throw new Error('Duplicate ticker/date keys exist in local cache. Resolve before recovery: ' +
      JSON.stringify(plan.duplicateKeySamples));
  }
  if (!plan.tickerUnion || plan.tickerUnion.length < 490 || plan.tickerUnion.length > 520) {
    throw new Error('Unexpected historical ticker union size: ' +
      (plan.tickerUnion ? plan.tickerUnion.length : 0));
  }
  plan.dates.forEach(function(item) {
    if (!item.localExpected || item.localExpected < 490 || item.localExpected > 520) {
      throw new Error('Unexpected local eligible count for ' + item.date + ': ' + item.localExpected);
    }
    if (!item.d1Quality || item.d1Quality.expected_count !== item.localExpected) {
      throw new Error('Local and D1 eligible universes disagree for ' + item.date +
        '. Local=' + item.localExpected + ', D1=' +
        (item.d1Quality ? item.d1Quality.expected_count : 'unavailable'));
    }
    if (Number(item.d1Quality.extra_count || 0) > 0 ||
        Number(item.d1Quality.duplicate_extra_rows || 0) > 0) {
      throw new Error('D1 already contains extra/duplicate raw rows for ' + item.date +
        '. Recovery will not delete existing D1 data: ' + JSON.stringify(item.d1Quality));
    }
  });

  var ref = plan.referenceDate;
  if (!ref || !ref.d1Quality || ref.d1Quality.status !== 'OK' ||
      ref.localMissing !== 0 || ref.localInvalid !== 0 || ref.localExtras !== 0 ||
      ref.localValid !== ref.localExpected ||
      ref.d1Quality.expected_count !== ref.localExpected) {
    throw new Error('11/6 reference data is not fully healthy locally and in D1: ' +
      JSON.stringify(ref));
  }
}

function runNov2026OhlcvRecoveryFetchBatch_(state, startedAt) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);
  var tempSheet = getBufferSheet_(ss);
  var registrySheet = getRegistrySheet_(ss);
  var eligibleMaps = {};

  state.dates.forEach(function(dateKey) {
    var map = {};
    readEligibleTickerListForOhlcvDate_(registrySheet, dateKey).forEach(function(t) {
      map[normalizeTicker_(t)] = true;
    });
    eligibleMaps[dateKey] = map;
  });

  var cache = readNov2026CacheMap_(dbSheet);
  var processed = 0;

  while (state.cursor < state.tickers.length &&
         processed < NOV2026_OHLCV_RECOVERY_BATCH_SIZE_ &&
         Date.now() - startedAt < 210000) {
    var ticker = normalizeTicker_(state.tickers[state.cursor]);
    var eligibleDates = state.dates.filter(function(dateKey) {
      return eligibleMaps[dateKey][ticker];
    });

    try {
      if (eligibleDates.length > 0) {
        // Re-fetch every in-scope bar, including existing 11/4 and 11/5 rows.
        // This validates the existing values against GoogleFinance, not just row counts.
        var bars = fetchGoogleFinanceBarsForRange_(tempSheet, ticker,
          state.dates[0], state.dates[state.dates.length - 1]);
        var barsByDate = {};
        bars.forEach(function(bar) { barsByDate[bar.dateKey] = bar; });

        var replacements = [];
        var appendRows = [];
        eligibleDates.forEach(function(dateKey) {
          var bar = barsByDate[dateKey];
          if (!bar) {
            throw new Error('GoogleFinance returned no bar for ' + ticker + ' on ' + dateKey);
          }
          var row = [ticker, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume];
          if (!isValidNov2026OhlcvRow_(row)) {
            throw new Error('Invalid GoogleFinance OHLCV values for ' + ticker + ' on ' + dateKey);
          }

          var key = ticker + '|' + dateKey;
          var existing = cache[key];
          if (existing) replacements.push({ rowNumber: existing.rowNumber, row: row, key: key });
          else appendRows.push({ row: row, key: key });
        });

        replacements.forEach(function(item) {
          dbSheet.getRange(item.rowNumber, 1, 1, OHLCV_HEADER.length).setValues([item.row]);
          cache[item.key] = { row: item.row, rowNumber: item.rowNumber };
        });

        if (appendRows.length > 0) {
          var firstRow = dbSheet.getLastRow() + 1;
          dbSheet.getRange(firstRow, 1, appendRows.length, OHLCV_HEADER.length)
            .setValues(appendRows.map(function(item) { return item.row; }));
          appendRows.forEach(function(item, index) {
            cache[item.key] = { row: item.row, rowNumber: firstRow + index };
          });
        }
      }

      delete state.attempts[ticker];
      state.cursor++;
      processed++;
      PropertiesService.getScriptProperties().setProperty(
        NOV2026_OHLCV_RECOVERY_STATE_KEY_, JSON.stringify(state));
    } catch (err) {
      state.attempts[ticker] = Number(state.attempts[ticker] || 0) + 1;
      state.lastError = ticker + ': ' + String(err);
      PropertiesService.getScriptProperties().setProperty(
        NOV2026_OHLCV_RECOVERY_STATE_KEY_, JSON.stringify(state));
      if (state.attempts[ticker] >= NOV2026_OHLCV_RECOVERY_MAX_ATTEMPTS_) {
        throw new Error('Retry limit reached for ' + ticker + '. ' + state.lastError);
      }
      Logger.log('Transient fetch failure; next trigger will retry ticker=' + ticker +
        ', attempt=' + state.attempts[ticker]);
      return;
    }
  }

  Logger.log('Recovery fetch progress: ' + state.cursor + '/' + state.tickers.length);
}

function readNov2026CacheMap_(dbSheet) {
  var lastRow = dbSheet.getLastRow();
  var values = lastRow < 2 ? [] :
    dbSheet.getRange(2, 1, lastRow - 1, OHLCV_HEADER.length).getValues();
  var map = {};

  for (var i = 0; i < values.length; i++) {
    var ticker = normalizeTicker_(values[i][0]);
    var dateKey = normalizeDateKey_(values[i][1]);
    if (!ticker || NOV2026_OHLCV_RECOVERY_DATES_.indexOf(dateKey) < 0) continue;
    var key = ticker + '|' + dateKey;
    if (map[key]) throw new Error('Duplicate cache key detected during recovery: ' + key);
    map[key] = { row: values[i], rowNumber: i + 2 };
  }
  return map;
}

function isValidNov2026OhlcvRow_(row) {
  if (!row || row.length < 7) return false;
  var open = Number(row[2]), high = Number(row[3]), low = Number(row[4]);
  var close = Number(row[5]), volume = Number(row[6]);
  if (![open, high, low, close, volume].every(function(n) { return isFinite(n); })) return false;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return false;
  if (high < Math.max(open, low, close)) return false;
  if (low > Math.min(open, high, close)) return false;
  return true;
}

function finalizeNov2026OhlcvRecovery_(state) {
  var dateIndex = Number(state.dateCursor || 0);
  if (dateIndex >= state.dates.length) return true;

  var dateKey = state.dates[dateIndex];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);
  var registrySheet = getRegistrySheet_(ss);
  var cache = readNov2026CacheMap_(dbSheet);
  var eligible = readEligibleTickerListForOhlcvDate_(registrySheet, dateKey);
  var rows = [];
  var missing = [];

  eligible.forEach(function(ticker) {
    var record = cache[normalizeTicker_(ticker) + '|' + dateKey];
    if (!record || !isValidNov2026OhlcvRow_(record.row)) missing.push(ticker);
    else rows.push(normalizeOhlcvRowForCloudflare_(record.row, dateKey));
  });

  if (missing.length > 0 || rows.length !== eligible.length) {
    throw new Error('Local cache is not complete for ' + dateKey +
      '. Expected=' + eligible.length + ', valid=' + rows.length +
      ', missing/invalid=' + missing.length + ', samples=' + missing.slice(0, 30).join(', '));
  }

  var post = postCloudflareInBatches_('/ingest/ohlcv', rows);
  if (post.failedBatches !== 0 || post.acceptedRows !== rows.length) {
    throw new Error('Cloudflare ingest count mismatch for ' + dateKey +
      ': ' + JSON.stringify(post));
  }

  var quality = fetchNov2026CloudflareQuality_(dateKey);
  if (quality.status !== 'OK' ||
      quality.raw_rows !== rows.length ||
      quality.unique_tickers !== rows.length ||
      quality.missing_count !== 0 ||
      quality.extra_count !== 0 ||
      quality.duplicate_extra_rows !== 0) {
    throw new Error('Cloudflare raw quality failed after ingest for ' +
      dateKey + ': ' + JSON.stringify(quality));
  }

  var derive = deriveOhlcvDateOnCloudflare_(dateKey, Date.now());
  if (!derive || !derive.ok || !derive.derived ||
      Number(derive.derived.market_breadth || 0) < 1 ||
      Number(derive.derived.sector_breadth || 0) < 1) {
    throw new Error('Cloudflare derive verification failed for ' +
      dateKey + ': ' + JSON.stringify(derive));
  }

  state.dateCursor = dateIndex + 1;
  PropertiesService.getScriptProperties().setProperty(
    NOV2026_OHLCV_RECOVERY_STATE_KEY_, JSON.stringify(state));
  Logger.log('Date recovered and derived: ' + dateKey +
    ', rawRows=' + quality.raw_rows +
    ', market=' + derive.derived.market_breadth +
    ', sectors=' + derive.derived.sector_breadth);
  return state.dateCursor >= state.dates.length;
}



function fetchNov2026CloudflareQuality_(dateKey) {
  var result = fetchNov2026CloudflareJson_('/api/quality/check?date=' + encodeURIComponent(dateKey));
  if (!result || result.ok !== true || !result.quality) {
    throw new Error('Cloudflare quality endpoint failed for ' + dateKey + ': ' + JSON.stringify(result));
  }
  return result.quality;
}

function fetchNov2026CloudflareJson_(path) {
  var response = UrlFetchApp.fetch(SYS_CONFIG.CLOUDFLARE.BASE_URL + path, {
    method: 'get',
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  var body = response.getContentText();
  var parsed = parseJsonSafe_(body, null);
  if (code < 200 || code >= 300 || !parsed) {
    throw new Error('Cloudflare GET failed. Path=' + path + ', HTTP=' + code + ', Body=' + body);
  }
  return parsed;
}
