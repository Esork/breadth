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
    .getRange(scanStartRow, 1, scanRows, OHLCV_HEADER.length)
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
  var invalidRows = 0;

  for (var r = 0; r < values.length; r++) {
    var ticker = normalizeTicker_(values[r][0]);
    var rowDateKey = normalizeDateKey_(values[r][1]);
    if (!ticker || rowDateKey !== latestDateKey) continue;

    rawRows++;
    var row = values[r];
    var open = Number(row[2]), high = Number(row[3]), low = Number(row[4]);
    var close = Number(row[5]), volume = Number(row[6]);
    var valid = [open, high, low, close, volume].every(function(n) {
      return isFinite(n);
    }) && open > 0 && high > 0 && low > 0 && close > 0 && volume > 0 &&
      high >= Math.max(open, low, close) &&
      low <= Math.min(open, high, close);
    if (!valid) {
      invalidRows++;
      continue;
    }
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
      if (duplicateSamples.length < 10) duplicateSamples.push(key + ' x' + count);
    }
  });

  var missing = [];
  eligible.forEach(function(ticker) {
    ticker = normalizeTicker_(ticker);
    if (ticker && !presentTickers[ticker]) missing.push(ticker);
  });
  var extras = [];
  Object.keys(presentTickers).forEach(function(ticker) {
    if (!expectedMap[ticker]) extras.push(ticker);
  });
  missing.sort();
  extras.sort();

  var minimumRequiredCount = Math.ceil(expectedEligibleCount * 0.98);
  var validUniqueTickers = keys.length;
  // Extras are diagnostic only and must not inflate expected-universe coverage.
  var matchedExpectedTickers = expectedEligibleCount - missing.length;
  var coverageRate = expectedEligibleCount > 0
    ? matchedExpectedTickers / expectedEligibleCount
    : 0;
  var status = expectedEligibleCount > 0 &&
    matchedExpectedTickers >= minimumRequiredCount &&
    duplicateExtraRows === 0
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
    minimumRequiredCount: minimumRequiredCount,
    coverageRate: Number((coverageRate * 100).toFixed(2)),
    rawRows: rawRows,
    uniqueTickerDates: keys.length,
    matchedExpectedTickerDates: matchedExpectedTickers,
    invalidRows: invalidRows,
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
      ', MinimumRequired=' + minimumRequiredCount +
      ', InvalidRows=' + invalidRows +
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