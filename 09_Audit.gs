/**
 * 09_Audit.gs
 * OHLCV data health and missing-data audit.
 *
 * Design:
 * - Formula audit is used for missing-row queue generation.
 * - Script health inspector is used for no-new-sheet cache validation.
 * - Do not create random incident-specific audit sheets.
 */


/**
 * Creates/refreshes AUDIT_MISSING_OHLCV.
 *
 * Important:
 * Missing audit currently uses current eligible tickers:
 * IsCurrentSP500 = TRUE
 * IsActive = TRUE
 *
 * For rebalance-transition dates, prefer script health inspector / date-aware
 * helpers instead of relying on this formula audit alone.
 */
function inspectLatestOhlcvDateHealth() {
  return inspectLatestOhlcvDateHealthFast_(2000);
}

function inspectLatestOhlcvDateHealthFast_(lookbackRows) {
  var startTime = Date.now();
  var module = 'AUDIT_OHLCV';

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);
  var registrySheet = getRegistrySheet_(ss);

  var lastRow = dbSheet.getLastRow();

  if (lastRow < 2) {
    var emptyResult = {
      date: null,
      status: 'EMPTY',
      method: 'TAIL_SCAN_DATE_AWARE',
      scannedRows: 0,
      expectedEligibleCount: 0,
      rawRows: 0,
      uniqueTickerDates: 0,
      duplicatePairCount: 0,
      duplicateExtraRows: 0,
      missingCount: 0,
      extraTickerCount: 0,
      duplicateSamples: [],
      missingSamples: [],
      extraTickerSamples: [],
      elapsedSeconds: getElapsedSeconds_(startTime)
    };

    writeSystemLog(
      module,
      'WARN',
      getElapsedSeconds_(startTime),
      'OHLCV health check found empty cache.'
    );

    return emptyResult;
  }

  var scanRows = Math.min(Number(lookbackRows) || 2000, lastRow - 1);
  var scanStartRow = lastRow - scanRows + 1;

  var values = dbSheet
    .getRange(scanStartRow, 1, scanRows, 2)
    .getValues();

  var latestDateKey = null;

  for (var i = 0; i < values.length; i++) {
    var dateKey = normalizeDateKey_(values[i][1]);
    if (dateKey && (!latestDateKey || dateKey > latestDateKey)) {
      latestDateKey = dateKey;
    }
  }

  if (!latestDateKey) {
    throw new Error('Could not detect latest OHLCV date from cache tail.');
  }

  var eligible = readEligibleTickerListForOhlcvDate_(registrySheet, latestDateKey);
  var expectedMap = {};

  eligible.forEach(function(ticker) {
    ticker = normalizeTicker_(ticker);
    if (ticker) expectedMap[ticker] = true;
  });

  var expectedEligibleCount = eligible.length;

  var pairCounts = {};
  var presentTickers = {};
  var rawRows = 0;

  for (var r = 0; r < values.length; r++) {
    var ticker = normalizeTicker_(values[r][0]);
    var rowDateKey = normalizeDateKey_(values[r][1]);

    if (!ticker || rowDateKey !== latestDateKey) continue;

    rawRows++;
    presentTickers[ticker] = true;

    var key = ticker + '|' + rowDateKey;
    pairCounts[key] = (pairCounts[key] || 0) + 1;
  }

  var keys = Object.keys(pairCounts);
  var duplicatePairCount = 0;
  var duplicateExtraRows = 0;
  var duplicateSamples = [];

  keys.forEach(function(key) {
    var count = pairCounts[key];

    if (count > 1) {
      duplicatePairCount++;
      duplicateExtraRows += count - 1;

      if (duplicateSamples.length < 10) {
        duplicateSamples.push(key + ' x' + count);
      }
    }
  });

  var missing = [];
  eligible.forEach(function(ticker) {
    ticker = normalizeTicker_(ticker);
    if (ticker && !presentTickers[ticker]) {
      missing.push(ticker);
    }
  });

  var extras = [];
  Object.keys(presentTickers).forEach(function(ticker) {
    if (!expectedMap[ticker]) {
      extras.push(ticker);
    }
  });

  missing.sort();
  extras.sort();

  var status =
    rawRows === expectedEligibleCount &&
    keys.length === expectedEligibleCount &&
    duplicateExtraRows === 0 &&
    missing.length === 0 &&
    extras.length === 0
      ? 'OK'
      : 'FAIL';

  var result = {
    date: latestDateKey,
    status: status,
    method: 'TAIL_SCAN_DATE_AWARE',
    scannedRows: scanRows,
    scanStartRow: scanStartRow,
    scanEndRow: lastRow,
    expectedEligibleCount: expectedEligibleCount,
    rawRows: rawRows,
    uniqueTickerDates: keys.length,
    duplicatePairCount: duplicatePairCount,
    duplicateExtraRows: duplicateExtraRows,
    missingCount: missing.length,
    extraTickerCount: extras.length,
    duplicateSamples: duplicateSamples,
    missingSamples: missing.slice(0, 20),
    extraTickerSamples: extras.slice(0, 20),
    elapsedSeconds: getElapsedSeconds_(startTime)
  };

  writeSystemLog(
    module,
    status === 'OK' ? 'INFO' : 'WARN',
    getElapsedSeconds_(startTime),
    'Latest OHLCV health ' +
      status +
      '. Date=' +
      latestDateKey +
      ', Method=TAIL_SCAN_DATE_AWARE' +
      ', ScannedRows=' +
      scanRows +
      ', Expected=' +
      expectedEligibleCount +
      ', RawRows=' +
      rawRows +
      ', Unique=' +
      keys.length +
      ', Duplicates=' +
      duplicateExtraRows +
      ', Missing=' +
      missing.length +
      ', Extra=' +
      extras.length +
      (extras.length ? ', ExtraSamples=' + extras.slice(0, 10).join(',') : '') +
      (missing.length ? ', MissingSamples=' + missing.slice(0, 10).join(',') : '')
  );

  return result;
}