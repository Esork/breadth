/**
 * 05_GoogleFinance.gs
 * Sequential GOOGLEFINANCE buffer fetcher.
 * Must be called under script lock when used in sync/backfill workers.
 */

function fetchGoogleFinanceBarsForRange_(tempSheet, ticker, startDateKey, endDateKey) {
  tempSheet.clear();

  var startParts = String(startDateKey).split('-');
  var endParts = String(endDateKey).split('-');
  var gfTicker = convertTickerForGoogleFinance_(ticker);

  var formula =
    '=GOOGLEFINANCE("' + gfTicker + '","all",DATE(' +
    Number(startParts[0]) + ',' + Number(startParts[1]) + ',' + Number(startParts[2]) +
    '),DATE(' +
    Number(endParts[0]) + ',' + Number(endParts[1]) + ',' + Number(endParts[2]) +
    '),"daily")';

  tempSheet.getRange('A1').setFormula(formula);
  SpreadsheetApp.flush();

  waitForGoogleFinance_(tempSheet);

  var range = tempSheet.getDataRange();
  var values = range.getValues();
  var displayValues = range.getDisplayValues();

  validateGoogleFinanceResponse_(values, displayValues, ticker);

  var rows = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];

    if (
      row[0] &&
      typeof row[1] === 'number' &&
      typeof row[2] === 'number' &&
      typeof row[3] === 'number' &&
      typeof row[4] === 'number'
    ) {
      var barDate = new Date(row[0]);
      var dateKey = normalizeDateKey_(barDate);

      if (dateKey >= startDateKey && dateKey <= endDateKey) {
        rows.push({
          date: barDate,
          dateKey: dateKey,
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          volume: row[5]
        });
      }
    }
  }

  return rows;
}

function fetchGoogleFinanceLatestDailyBar_(tempSheet, ticker) {
  var endDate = getYesterdayLocal_();
  var startDate = addDays_(endDate, -SYS_CONFIG.GOOGLE_FINANCE.LOOKBACK_DAYS_FOR_LATEST_BAR);

  var startKey = normalizeDateKey_(startDate);
  var endKey = normalizeDateKey_(endDate);

  var rows = fetchGoogleFinanceBarsForRange_(tempSheet, ticker, startKey, endKey);
  if (!rows || rows.length === 0) {
    return { ok: false, message: 'no valid market rows' };
  }

  var lastRow = rows[rows.length - 1];
  return {
    ok: true,
    date: lastRow.date,
    dateKey: lastRow.dateKey,
    open: lastRow.open,
    high: lastRow.high,
    low: lastRow.low,
    close: lastRow.close,
    volume: lastRow.volume
  };
}

function waitForGoogleFinance_(tempSheet) {
  var waitedMs = 0;
  var cfg = SYS_CONFIG.GOOGLE_FINANCE;

  Utilities.sleep(cfg.BASE_SLEEP_MS);
  waitedMs += cfg.BASE_SLEEP_MS;

  while (waitedMs < cfg.MAX_WAIT_MS) {
    var firstDisplay = String(tempSheet.getRange('A1').getDisplayValue() || '');

    if (
      firstDisplay.indexOf('Loading') < 0 &&
      firstDisplay.indexOf('GOOGLEFINANCE') < 0
    ) {
      break;
    }

    Utilities.sleep(cfg.POLL_INTERVAL_MS);
    waitedMs += cfg.POLL_INTERVAL_MS;
    SpreadsheetApp.flush();
  }
}

function validateGoogleFinanceResponse_(values, displayValues, ticker) {
  if (!values || values.length === 0) {
    throw new Error(ticker + ': empty GoogleFinance response');
  }

  var firstCell = String((displayValues && displayValues[0] && displayValues[0][0]) || '');

  if (
    firstCell.indexOf('#N/A') >= 0 ||
    firstCell.indexOf('Loading') >= 0 ||
    firstCell.indexOf('GOOGLEFINANCE') >= 0 ||
    firstCell.indexOf('error') >= 0 ||
    firstCell.indexOf('Error') >= 0
  ) {
    throw new Error(ticker + ': GoogleFinance error: ' + firstCell);
  }

  if (values.length < 2) {
    throw new Error(ticker + ': no market rows');
  }
}
