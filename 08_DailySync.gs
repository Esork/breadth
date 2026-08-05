/**
 * 08_DailySync.gs
 * Robust daily sync with recurring worker trigger.
 *
 * Reads a date-aware candidate universe:
 * - Current S&P 500 eligible tickers
 * - Plus known transition tickers from membership events
 *
 * Each fetched OHLCV row is validated against the correct S&P 500 universe
 * for that row's actual OHLCV date.
 */

var DAILY_LAST_HEALTH_PROP_KEY = 'QE_DAILY_LAST_HEALTH_V1';

function startDailySyncNow() {
  var startTime = Date.now();
  var module = SYS_CONFIG.DAILY_SYNC.LOG_MODULE;
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var registrySheet = getRegistrySheet_(ss);
  var tickers = readDailySyncCandidateTickerList_(registrySheet);

  if (tickers.length === 0) {
    logWarn_(module, startTime, 'Daily sync candidate ticker list is empty. Daily sync not started.');
    return;
  }

  var runDateKey = normalizeDateKey_(new Date());

  var state = {
    status: 'RUNNING',
    runDateKey: runDateKey,
    cursor: 0,
    total: tickers.length,
    successCount: 0,
    duplicateCount: 0,
    excludedCount: 0,
    skipCount: 0,
    failureCount: 0,
    startedAt: nowIso_()
  };

  PropertiesService.getScriptProperties().setProperty(
    SYS_CONFIG.DAILY_SYNC.STATE_KEY,
    JSON.stringify(state)
  );

  installEveryMinutesTrigger_(
    'dailySyncWorker',
    SYS_CONFIG.DAILY_SYNC.WORKER_EVERY_MINUTES
  );

  logInfo_(
    module,
    startTime,
    'Daily sync state initialized from date-aware candidate universe. Total candidates=' +
      tickers.length +
      ', worker every ' +
      SYS_CONFIG.DAILY_SYNC.WORKER_EVERY_MINUTES +
      ' minutes.'
  );

  dailySyncWorker();
}

function dailySyncWorker() {
  var startTime = Date.now();
  var module = SYS_CONFIG.DAILY_SYNC.LOG_MODULE;
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    logWarn_(module, startTime, 'Could not get lock. Worker skipped safely.');
    return;
  }

  try {
    runDailySyncBatch_();

  } catch (err) {
    logError_(module, startTime, String(err));

  } finally {
    lock.releaseLock();
  }
}

function runDailySyncBatch_() {
  var startTime = Date.now();
  var module = SYS_CONFIG.DAILY_SYNC.LOG_MODULE;
  var props = PropertiesService.getScriptProperties();

  var state = parseJsonSafe_(
    props.getProperty(SYS_CONFIG.DAILY_SYNC.STATE_KEY),
    null
  );

  if (!state || state.status !== 'RUNNING') {
    logInfo_(module, null, 'No active daily sync state. Worker idle.');
    deleteTriggersByHandler_('dailySyncWorker');
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var registrySheet = getRegistrySheet_(ss);
  var dbSheet = getDbSheet_(ss);
  var tempSheet = getBufferSheet_(ss);

  var tickers = readDailySyncCandidateTickerList_(registrySheet);
  var syncMap = loadSyncIndexMap_(registrySheet);

  var startIndex = Number(state.cursor) || 0;
  var endIndex = Math.min(
    startIndex + SYS_CONFIG.DAILY_SYNC.BATCH_SIZE,
    tickers.length
  );

  var writeItems = [];
  var skipped = [];
  var failed = [];
  var duplicates = [];
  var excluded = [];
  var eligibilityCache = {};

  var localDuplicate = 0;
  var localSkip = 0;
  var localFailure = 0;
  var localExcluded = 0;

  var processedCursor = startIndex;

  logInfo_(
    module,
    null,
    'Running daily batch ' +
      (startIndex + 1) +
      ' to ' +
      endIndex +
      ' of ' +
      tickers.length
  );

  for (var i = startIndex; i < endIndex; i++) {
    var ticker = normalizeTicker_(tickers[i]);

    try {
      var result = fetchGoogleFinanceLatestDailyBar_(tempSheet, ticker);

      if (!result.ok) {
        localSkip++;
        skipped.push(ticker + ': ' + result.message);

      } else if (!isTickerEligibleForOhlcvDateCached_(registrySheet, ticker, result.dateKey, eligibilityCache)) {
        localExcluded++;
        excluded.push(ticker + '(' + result.dateKey + ')');

      } else if (isDateAlreadySynced_(syncMap[ticker] || '', result.dateKey)) {
        localDuplicate++;
        duplicates.push(ticker + '(' + result.dateKey + ')');

      } else {
        writeItems.push({
          ticker: ticker,
          dateKey: result.dateKey,
          row: [
            ticker,
            result.date,
            result.open,
            result.high,
            result.low,
            result.close,
            result.volume
          ]
        });
      }

    } catch (err) {
      localFailure++;
      failed.push(ticker + ': ' + String(err));
    }

    processedCursor = i + 1;

    if (Date.now() - startTime > SYS_CONFIG.DAILY_SYNC.MAX_RUNTIME_MS) {
      logWarn_(
        module,
        startTime,
        'Runtime guard hit before commit. Pending cursor=' +
          processedCursor +
          '/' +
          tickers.length
      );
      break;
    }
  }

  var writeBuffer = [];
  for (var w = 0; w < writeItems.length; w++) {
    writeBuffer.push(writeItems[w].row);
  }

  var appendResult = appendOhlcvRowsDetailed_(dbSheet, writeBuffer, {
    mode: OHLCV_APPEND_MODE_RECENT_TAIL
  });

  var dbCoveredRows =
    appendResult.appendedRows +
    appendResult.existingDuplicateRows +
    appendResult.incomingDuplicateRows;

  if (appendResult.skippedInvalidRows > 0) {
    throw new Error(
      'Daily sync append rejected invalid OHLCV rows. skippedInvalidRows=' +
        appendResult.skippedInvalidRows
    );
  }

  if (dbCoveredRows !== writeItems.length) {
    throw new Error(
      'Daily sync DB coverage mismatch. writeItems=' +
        writeItems.length +
        ', dbCoveredRows=' +
        dbCoveredRows +
        ', appendResult=' +
        JSON.stringify(appendResult)
    );
  }

  for (var u = 0; u < writeItems.length; u++) {
    syncMap[writeItems[u].ticker] = writeItems[u].dateKey;
  }

  saveSyncIndexMap_(registrySheet, tickers, syncMap);

  state.cursor = processedCursor;
  state.successCount += appendResult.appendedRows;
  state.duplicateCount +=
    localDuplicate +
    appendResult.existingDuplicateRows +
    appendResult.incomingDuplicateRows;
  state.excludedCount = Number(state.excludedCount || 0) + localExcluded;
  state.skipCount += localSkip;
  state.failureCount += localFailure;

  props.setProperty(
    SYS_CONFIG.DAILY_SYNC.STATE_KEY,
    JSON.stringify(state)
  );

  if (skipped.length > 0) {
    logWarn_(module, null, 'Skipped: ' + skipped.slice(0, 20).join(' | '));
  }

  if (failed.length > 0) {
    logError_(module, null, 'Failed: ' + failed.slice(0, 20).join(' | '));
  }

  if (excluded.length > 0) {
    logInfo_(
      module,
      null,
      'Excluded by date-aware universe count=' +
        excluded.length +
        '. Examples=' +
        excluded.slice(0, 10).join(', ')
    );
  }

  if (
    appendResult.existingDuplicateRows > 0 ||
    appendResult.incomingDuplicateRows > 0
  ) {
    logWarn_(
      module,
      null,
      'Duplicate skipped by DB append guard. Existing=' +
        appendResult.existingDuplicateRows +
        ', Incoming=' +
        appendResult.incomingDuplicateRows
    );
  }

  if (state.cursor < tickers.length) {
    logInfo_(
      module,
      startTime,
      'Batch committed. Cursor=' +
        state.cursor +
        '/' +
        tickers.length +
        ', Success=' +
        state.successCount +
        ', Duplicates=' +
        state.duplicateCount +
        ', Excluded=' +
        Number(state.excludedCount || 0) +
        ', Skip=' +
        state.skipCount +
        ', Failed=' +
        state.failureCount
    );
    return;
  }

  finishDailySyncWithHealthGate_(state, tickers.length, startTime);
}

function finishDailySyncWithHealthGate_(state, totalTickers, startTime) {
  var module = SYS_CONFIG.DAILY_SYNC.LOG_MODULE;
  var props = PropertiesService.getScriptProperties();

  var excludedCount = Number(state.excludedCount || 0);
  var covered = state.successCount + state.duplicateCount + excludedCount;
  var coverageRate = totalTickers > 0
    ? (covered / totalTickers * 100).toFixed(2)
    : '0.00';

  var healthResult = null;
  var healthOk = false;

  var cloudflarePushOk = false;
  var cloudflarePushError = null;

  var cloudflareDeriveOk = false;
  var cloudflareDeriveError = null;
  var cloudflareDeriveResult = null;

  var cachePruneOk = false;
  var cachePruneResult = null;
  var cachePruneError = null;

  try {
    healthResult = inspectLatestOhlcvDateHealth();
    healthOk = healthResult && healthResult.status === 'OK';

  } catch (err) {
    healthResult = {
      status: 'ERROR',
      message: String(err)
    };
    healthOk = false;
  }

  if (healthOk) {
    try {
      pushLatestCleanOhlcvDateToCloudflare();
      cloudflarePushOk = true;

    } catch (errPush) {
      cloudflarePushOk = false;
      cloudflarePushError = String(errPush);

      writeSystemLog(
        SYS_CONFIG.CLOUDFLARE.LOG_MODULE,
        'ERROR',
        getElapsedSeconds_(startTime),
        'Daily sync Cloudflare push failed after health OK. Error=' +
        cloudflarePushError
      );
    }

    if (cloudflarePushOk) {
      try {
        var deriveDateKey = normalizeDateKey_(healthResult.date);
        cloudflareDeriveResult = deriveOhlcvDateOnCloudflare_(deriveDateKey, startTime);
        cloudflareDeriveOk = true;

      } catch (errDerive) {
        cloudflareDeriveOk = false;
        cloudflareDeriveError = String(errDerive);

        writeSystemLog(
          SYS_CONFIG.CLOUDFLARE.LOG_MODULE,
          'ERROR',
          getElapsedSeconds_(startTime),
          'Daily sync Cloudflare derive failed after push OK. Error=' +
          cloudflareDeriveError
        );
      }
    }

    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var dbSheet = getDbSheet_(ss);

      cachePruneResult = pruneOhlcvCacheToLatestDays_(dbSheet, 3);
      cachePruneOk = true;

    } catch (errPrune) {
      cachePruneOk = false;
      cachePruneError = String(errPrune);

      writeSystemLog(
        module,
        'ERROR',
        getElapsedSeconds_(startTime),
        'Daily sync OHLCV cache prune failed. Error=' +
          cachePruneError
      );
    }
  }

  var healthPayload = {
    finishedAt: nowIso_(),
    cloudflarePushAllowed: healthOk,
    cloudflarePushOk: cloudflarePushOk,
    cloudflarePushError: cloudflarePushError,
    cloudflareDeriveOk: cloudflareDeriveOk,
    cloudflareDeriveError: cloudflareDeriveError,
    cloudflareDeriveResult: cloudflareDeriveResult,
    cachePruneOk: cachePruneOk,
    cachePrune: cachePruneResult,
    cachePruneError: cachePruneError,
    total: totalTickers,
    success: state.successCount,
    duplicates: state.duplicateCount,
    excluded: excludedCount,
    skip: state.skipCount,
    failed: state.failureCount,
    coverageRate: coverageRate,
    health: healthResult
  };

  props.setProperty(
    DAILY_LAST_HEALTH_PROP_KEY,
    JSON.stringify(healthPayload)
  );

  props.deleteProperty(SYS_CONFIG.DAILY_SYNC.STATE_KEY);
  deleteTriggersByHandler_('dailySyncWorker');

  writeSystemLog(
    module,
    healthOk && cloudflarePushOk && cloudflareDeriveOk && cachePruneOk ? 'INFO' : 'ERROR',
    getElapsedSeconds_(startTime),
    'Daily sync finished. Total=' +
      totalTickers +
      ', Success=' +
      state.successCount +
      ', Duplicates=' +
      state.duplicateCount +
      ', Excluded=' +
      excludedCount +
      ', Skip=' +
      state.skipCount +
      ', Failed=' +
      state.failureCount +
      ', CoverageRate=' +
      coverageRate +
      '%' +
      ', Health=' +
      healthResult.status +
      ', CloudflarePushAllowed=' +
      healthOk +
      ', CloudflarePushOk=' +
      cloudflarePushOk +
      ', CloudflareDeriveOk=' +
      cloudflareDeriveOk +
      ', CachePruneOk=' +
      cachePruneOk
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

/* Backward-compatible wrapper. */
function dailyIncrementalSync() {
  startDailySyncNow();
}

function isTickerEligibleForOhlcvDateCached_(registrySheet, ticker, dateKey, cache) {
  var normalizedTicker = normalizeTicker_(ticker);
  var normalizedDateKey = normalizeDateKey_(dateKey);

  if (!normalizedTicker || !normalizedDateKey) return false;

  cache = cache || {};

  if (!cache[normalizedDateKey]) {
    var eligible = readEligibleTickerListForOhlcvDate_(registrySheet, normalizedDateKey);
    var map = {};

    eligible.forEach(function(item) {
      item = normalizeTicker_(item);
      if (item) map[item] = true;
    });

    cache[normalizedDateKey] = map;
  }

  return !!cache[normalizedDateKey][normalizedTicker];
}