/**
 * 11_API.gs
 * Lightweight JSON API for frontend/manual use.
 */

function doGet(e) {
  if (!e || !e.parameter) {
    return toJsonOutput_({ status: 'error', message: 'Missing API parameters.' });
  }

  var action = String(e.parameter.action || '').trim();
  var ticker = normalizeTicker_(e.parameter.ticker);
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    if (action === 'getTickers') {
      var tickerSheet = getTickerSheet_(ss);
      var tickers = readTickerList_(tickerSheet);
      return toJsonOutput_({ status: 'success', count: tickers.length, tickers: tickers });
    }

    if (action === 'getQuotes') {
      if (!ticker) throw new Error('Missing required parameter: ticker');
      return toJsonOutput_(getQuotesForTicker_(ss, ticker));
    }

    if (action === 'health') {
      return toJsonOutput_({ status: 'success', app: 'Breadth Backend', time: nowIso_() });
    }

    throw new Error('Unknown API action: ' + action);
  } catch (error) {
    return toJsonOutput_({ status: 'error', message: String(error) });
  }
}

function getQuotesForTicker_(ss, ticker) {
  var dbSheet = getDbSheet_(ss);
  var lastRow = dbSheet.getLastRow();
  var results = [];

  if (lastRow < 2) {
    return { status: 'success', ticker: ticker, count: 0, data: [] };
  }

  var matches = dbSheet
    .getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(ticker)
    .matchEntireCell(true)
    .findAll();

  for (var i = 0; i < matches.length; i++) {
    var rowNum = matches[i].getRow();
    var row = dbSheet.getRange(rowNum, 1, 1, OHLCV_HEADER.length).getValues()[0];

    results.push({
      date: normalizeDateKey_(row[1]),
      open: row[2],
      high: row[3],
      low: row[4],
      close: row[5],
      volume: row[6]
    });
  }

  results.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

  return { status: 'success', ticker: ticker, count: results.length, data: results };
}
