/**
 * 99_Admin.gs
 * Manual admin helpers. Safe entry points only.
 */

function bootstrapBackendSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  getTickerSheet_(ss);
  getDbSheet_(ss);
  getBufferSheet_(ss);
  getSyncIndexSheet_(ss);
  getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.LOGS, LOG_HEADER);
  getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.BACKFILL_QUEUE, BACKFILL_QUEUE_HEADER);
  writeSystemLog('ADMIN', 'INFO', '0s', 'Backend sheets bootstrapped.');
}

function inspectAllActiveStates() {
  var props = PropertiesService.getScriptProperties();
  Logger.log(SYS_CONFIG.DAILY_SYNC.STATE_KEY + ' = ' + props.getProperty(SYS_CONFIG.DAILY_SYNC.STATE_KEY));
  Logger.log(SYS_CONFIG.BACKFILL.STATE_KEY + ' = ' + props.getProperty(SYS_CONFIG.BACKFILL.STATE_KEY));

  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    Logger.log('Trigger: ' + triggers[i].getHandlerFunction() + ' / ' + triggers[i].getEventType());
  }

  writeSystemLog('ADMIN', 'INFO', '0s', 'State inspected. Check Apps Script Logger.');
}

function hardResetWorkersOnly() {
  PropertiesService.getScriptProperties().deleteProperty(SYS_CONFIG.DAILY_SYNC.STATE_KEY);
  PropertiesService.getScriptProperties().deleteProperty(SYS_CONFIG.BACKFILL.STATE_KEY);
  clearAllKnownWorkerTriggers();
  writeSystemLog('ADMIN', 'WARN', '0s', 'Hard reset worker states only. Production start/ticker triggers were not removed.');
}

function inspectOhlcvCacheDateAgainstCurrentRegistry() {
  var targetDate = '2026-06-18';

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);
  var registrySheet = getRegistrySheet_(ss);

  var eligible = readEligibleTickerListFromRegistry_(registrySheet);
  var eligibleMap = {};
  eligible.forEach(function(t) {
    eligibleMap[normalizeTicker_(t)] = true;
  });

  var lastRow = dbSheet.getLastRow();
  var values = dbSheet.getRange(2, 1, lastRow - 1, OHLCV_HEADER.length).getValues();

  var presentMap = {};
  var extras = [];

  for (var i = 0; i < values.length; i++) {
    var ticker = normalizeTicker_(values[i][0]);
    var dateKey = normalizeDateKey_(values[i][1]);

    if (dateKey !== targetDate || !ticker) continue;

    presentMap[ticker] = true;

    if (!eligibleMap[ticker]) {
      extras.push(ticker);
    }
  }

  var missing = [];
  eligible.forEach(function(t) {
    var ticker = normalizeTicker_(t);
    if (!presentMap[ticker]) missing.push(ticker);
  });

  Logger.log(JSON.stringify({
    date: targetDate,
    expectedCurrentRegistryCount: eligible.length,
    presentCount: Object.keys(presentMap).length,
    extras: extras.sort(),
    missing: missing.sort()
  }, null, 2));
}

function adminDeleteBadRebalanceRows_20260618() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);

  var targetDateKey = '2026-06-18';
  var deleteTickers = {
    FLEX: true,
    MRVL: true
  };

  var lastRow = dbSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('OHLCV cache has no data rows.');
    return;
  }

  var values = dbSheet
    .getRange(2, 1, lastRow - 1, OHLCV_HEADER.length)
    .getValues();

  var rowsToDelete = [];

  for (var i = 0; i < values.length; i++) {
    var ticker = normalizeTicker_(values[i][0]);
    var dateKey = normalizeDateKey_(values[i][1]);

    if (dateKey === targetDateKey && deleteTickers[ticker]) {
      rowsToDelete.push(i + 2);
    }
  }

  // Delete bottom-up so row numbers remain valid.
  rowsToDelete.sort(function(a, b) {
    return b - a;
  });

  for (var r = 0; r < rowsToDelete.length; r++) {
    dbSheet.deleteRow(rowsToDelete[r]);
  }

  Logger.log(JSON.stringify({
    date: targetDateKey,
    deletedRows: rowsToDelete.length,
    deletedRowNumbers: rowsToDelete
  }, null, 2));

  writeSystemLog(
    'ADMIN',
    rowsToDelete.length === 2 ? 'INFO' : 'WARN',
    '0s',
    'Deleted bad rebalance OHLCV rows. Date=' +
      targetDateKey +
      ', Tickers=FLEX,MRVL' +
      ', DeletedRows=' +
      rowsToDelete.length
  );
}
