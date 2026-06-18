/**
 * 09_Audit.gs
 * OHLCV data health and missing-data audit.
 *
 * Design:
 * - Formula audit is used for missing-row queue generation.
 * - Script health inspector is used for no-new-sheet DB validation.
 * - Do not create random incident-specific audit sheets.
 */

function createMissingAuditFormula_Jun3_Jun4_2026() {
  createMissingAuditFormula(['2026-06-03', '2026-06-04']);
}

/**
 * Creates/refreshes AUDIT_MISSING_OHLCV.
 *
 * Important:
 * Missing audit must only use eligible tickers:
 * IsCurrentSP500 = TRUE
 * IsActive = TRUE
 */
function createMissingAuditFormula(targetDateKeys) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.AUDIT_MISSING, null);
  sheet.clear();

  if (!targetDateKeys || targetDateKeys.length === 0) {
    throw new Error('targetDateKeys required.');
  }

  var registryName = SYS_CONFIG.SHEETS.SYNC_INDEX || SYS_CONFIG.SHEETS.TICKERS;
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
    'Missing audit formula created for eligible tickers only. Dates=' +
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

function inspectLatestOhlcvDateHealth() {
  return inspectLatestOhlcvDateHealthFast_(2000);
}

function inspectLatestOhlcvDateHealthFast_(lookbackRows) {
  var startTime = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var dbSheet = getDbSheet_(ss);
  var registrySheet = getRegistrySheet_(ss);

  var eligibleTickers = readEligibleTickerListFromRegistry_(registrySheet);
  var eligibleMap = {};

  for (var e = 0; e < eligibleTickers.length; e++) {
    eligibleMap[normalizeTicker_(eligibleTickers[e])] = true;
  }

  var lastRow = dbSheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('DB_OHLCV has no data rows.');
  }

  var safeLookbackRows = Math.max(1000, Number(lookbackRows) || 5000);
  var startRow = Math.max(2, lastRow - safeLookbackRows + 1);
  var numRows = lastRow - startRow + 1;

  var values = dbSheet.getRange(startRow, 1, numRows, 2).getValues();

  var latestDateKey = '';

  for (var i = 0; i < values.length; i++) {
    var dateKey = normalizeDateKey_(values[i][1]);
    if (!dateKey) continue;
    if (!latestDateKey || dateKey > latestDateKey) latestDateKey = dateKey;
  }

  if (!latestDateKey) {
    throw new Error('No date found in DB_OHLCV tail. startRow=' + startRow + ', numRows=' + numRows);
  }

  var rawRows = 0;
  var keyCounts = {};
  var tickerSeen = {};
  var extraTickerMap = {};

  for (var j = 0; j < values.length; j++) {
    var ticker = normalizeTicker_(values[j][0]);
    var rowDateKey = normalizeDateKey_(values[j][1]);

    if (!ticker || rowDateKey !== latestDateKey) continue;

    rawRows++;

    var key = ticker + '|' + rowDateKey;
    keyCounts[key] = (keyCounts[key] || 0) + 1;
    tickerSeen[ticker] = true;

    if (!eligibleMap[ticker]) {
      extraTickerMap[ticker] = true;
    }
  }

  var duplicatePairCount = 0;
  var duplicateExtraRows = 0;
  var duplicateSamples = [];

  var keys = Object.keys(keyCounts);

  for (var k = 0; k < keys.length; k++) {
    var count = keyCounts[keys[k]];

    if (count > 1) {
      duplicatePairCount++;
      duplicateExtraRows += count - 1;

      if (duplicateSamples.length < 20) {
        duplicateSamples.push(keys[k] + ' x' + count);
      }
    }
  }

  var missingTickers = [];

  for (var m = 0; m < eligibleTickers.length; m++) {
    var eligibleTicker = normalizeTicker_(eligibleTickers[m]);

    if (!tickerSeen[eligibleTicker]) {
      missingTickers.push(eligibleTicker);
    }
  }

  var extraTickers = Object.keys(extraTickerMap).sort();

  var expectedEligibleCount = eligibleTickers.length;
  var uniqueTickerDates = keys.length;

  var isClean =
    rawRows === expectedEligibleCount &&
    uniqueTickerDates === expectedEligibleCount &&
    duplicateExtraRows === 0 &&
    missingTickers.length === 0 &&
    extraTickers.length === 0;

  var result = {
    date: latestDateKey,
    status: isClean ? 'OK' : 'FAIL',
    method: 'TAIL_SCAN',
    scannedRows: numRows,
    scanStartRow: startRow,
    scanEndRow: lastRow,
    expectedEligibleCount: expectedEligibleCount,
    rawRows: rawRows,
    uniqueTickerDates: uniqueTickerDates,
    duplicatePairCount: duplicatePairCount,
    duplicateExtraRows: duplicateExtraRows,
    missingCount: missingTickers.length,
    extraTickerCount: extraTickers.length,
    duplicateSamples: duplicateSamples,
    missingSamples: missingTickers.slice(0, 20),
    extraTickerSamples: extraTickers.slice(0, 20),
    elapsedSeconds: getElapsedSeconds_(startTime)
  };

  Logger.log(JSON.stringify(result, null, 2));

  writeSystemLog(
    'AUDIT_OHLCV',
    isClean ? 'INFO' : 'WARN',
    result.elapsedSeconds,
    'Latest OHLCV health ' +
      result.status +
      '. Date=' +
      latestDateKey +
      ', Method=TAIL_SCAN' +
      ', ScannedRows=' +
      numRows +
      ', Expected=' +
      expectedEligibleCount +
      ', RawRows=' +
      rawRows +
      ', Unique=' +
      uniqueTickerDates +
      ', Duplicates=' +
      duplicateExtraRows +
      ', Missing=' +
      missingTickers.length +
      ', Extra=' +
      extraTickers.length
  );

  return result;
}