/**
 * 03_Sheets.gs
 * Sheet creation and DB helpers.
 *
 * SYS_SYNC_INDEX is now the ticker registry.
 * SYS_TICKERS is deprecated.
 *
 * Design rule:
 * DB_OHLCV writes must be idempotent at the final write gate.
 * Cursor/state protection is not enough.
 */

var OHLCV_APPEND_MODE_RECENT_TAIL = 'RECENT_TAIL';
var OHLCV_APPEND_MODE_EXACT_SMALL_BATCH = 'EXACT_SMALL_BATCH';

var OHLCV_APPEND_DEFAULT_LOOKBACK_ROWS = 3000;
var OHLCV_APPEND_EXACT_MAX_ROWS = 50;

function getOrCreateSheet_(ss, sheetName, header) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);

  if (header && sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/**
 * Deprecated compatibility shim.
 * Do not use SYS_TICKERS as source of truth anymore.
 */
function getTickerSheet_(ss) {
  return getRegistrySheet_(ss);
}

function getDbSheet_(ss) {
  return getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.DB, OHLCV_HEADER);
}

function getBufferSheet_(ss) {
  return getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.BUFFER, null);
}

/**
 * Compatibility shim.
 * Actual implementation lives in 07_SyncIndex.gs.
 */
function getSyncIndexSheet_(ss) {
  return getRegistrySheet_(ss);
}

/**
 * Deprecated compatibility shim.
 * If old code calls readTickerList_(sheet), ignore passed sheet and read
 * eligible tickers from SYS_SYNC_INDEX instead.
 */
function readTickerList_(ignoredSheet) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var registrySheet = getRegistrySheet_(ss);
  return readEligibleTickerListFromRegistry_(registrySheet);
}

/**
 * Default OHLCV append entrypoint.
 *
 * Intended for daily sync:
 * - fast
 * - idempotent against incoming batch duplicates
 * - idempotent against recent rerun / timeout duplicates
 * - does NOT full-scan DB_OHLCV
 *
 * Backward compatible:
 * Existing callers expect a number, so this returns appendedRows.
 */
function appendOhlcvRows_(dbSheet, rows, options) {
  var result = appendOhlcvRowsDetailed_(dbSheet, rows, options);
  return result.appendedRows;
}

/**
 * Exact small-batch OHLCV append.
 *
 * Intended for:
 * - missing backfill
 * - one-off repair
 * - manual targeted retry
 *
 * Do not use this for normal 503/504 daily sync because it calls
 * dbHasTickerDate_ per prepared row.
 */
function appendOhlcvRowsExactSmallBatch_(dbSheet, rows) {
  var result = appendOhlcvRowsDetailed_(dbSheet, rows, {
    mode: OHLCV_APPEND_MODE_EXACT_SMALL_BATCH
  });

  return result.appendedRows;
}

/**
 * Detailed OHLCV append engine.
 *
 * modes:
 * - RECENT_TAIL:
 *   Scan only the last N DB rows. This is fast and catches the real daily
 *   failure mode: worker rerun / timeout appending the same recent batch again.
 *
 * - EXACT_SMALL_BATCH:
 *   Use dbHasTickerDate_ for each prepared row. This is slower but exact.
 *   Use only for small repair/backfill batches.
 */
function appendOhlcvRowsDetailed_(dbSheet, rows, options) {
  var opts = normalizeAppendOhlcvOptions_(options);
  var width = OHLCV_HEADER.length;

  var result = {
    mode: opts.mode,
    lookbackRows: opts.lookbackRows,
    inputRows: rows ? rows.length : 0,
    preparedRows: 0,
    incomingDuplicateRows: 0,
    existingDuplicateRows: 0,
    appendedRows: 0,
    skippedInvalidRows: 0
  };

  if (!rows || rows.length === 0) return result;

  var preparedResult = prepareOhlcvRowsForAppend_(rows, width);
  var prepared = preparedResult.prepared;

  result.preparedRows = prepared.length;
  result.incomingDuplicateRows = preparedResult.incomingDuplicateRows;
  result.skippedInvalidRows = preparedResult.skippedInvalidRows;

  if (prepared.length === 0) return result;

  if (
    opts.mode === OHLCV_APPEND_MODE_EXACT_SMALL_BATCH &&
    prepared.length > opts.exactMaxRows
  ) {
    throw new Error(
      'appendOhlcvRowsDetailed_ exact mode refused large batch. preparedRows=' +
        prepared.length +
        ', max=' +
        opts.exactMaxRows
    );
  }

  var existingKeys = {};

  if (opts.mode === OHLCV_APPEND_MODE_EXACT_SMALL_BATCH) {
    existingKeys = buildExactExistingKeySetForSmallBatch_(dbSheet, prepared);
  } else {
    existingKeys = buildRecentExistingOhlcvKeySet_(dbSheet, opts.lookbackRows);
  }

  var rowsToAppend = [];

  for (var i = 0; i < prepared.length; i++) {
    var item = prepared[i];

    if (existingKeys[item.key]) {
      result.existingDuplicateRows++;
      continue;
    }

    existingKeys[item.key] = true;
    rowsToAppend.push(item.row);
  }

  if (rowsToAppend.length > 0) {
    dbSheet
      .getRange(dbSheet.getLastRow() + 1, 1, rowsToAppend.length, width)
      .setValues(rowsToAppend);

    result.appendedRows = rowsToAppend.length;
  }

  if (
    result.existingDuplicateRows > 0 &&
    typeof logWarn_ === 'function'
  ) {
    logWarn_(
      'DB_OHLCV',
      null,
      'appendOhlcvRowsDetailed_ skipped existing duplicate rows=' +
        result.existingDuplicateRows +
        ', mode=' +
        result.mode
    );
  }

  if (
    result.incomingDuplicateRows > 0 &&
    typeof logWarn_ === 'function'
  ) {
    logWarn_(
      'DB_OHLCV',
      null,
      'appendOhlcvRowsDetailed_ skipped incoming duplicate rows=' +
        result.incomingDuplicateRows +
        ', mode=' +
        result.mode
    );
  }

  return result;
}

function normalizeAppendOhlcvOptions_(options) {
  options = options || {};

  var mode = options.mode || OHLCV_APPEND_MODE_RECENT_TAIL;

  if (
    mode !== OHLCV_APPEND_MODE_RECENT_TAIL &&
    mode !== OHLCV_APPEND_MODE_EXACT_SMALL_BATCH
  ) {
    throw new Error('Unknown OHLCV append mode: ' + mode);
  }

  return {
    mode: mode,
    lookbackRows: Number(options.lookbackRows) || OHLCV_APPEND_DEFAULT_LOOKBACK_ROWS,
    exactMaxRows: Number(options.exactMaxRows) || OHLCV_APPEND_EXACT_MAX_ROWS
  };
}

function prepareOhlcvRowsForAppend_(rows, width) {
  var prepared = [];
  var incomingSeen = {};
  var incomingDuplicateRows = 0;
  var skippedInvalidRows = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];

    if (!row || row.length < 2) {
      skippedInvalidRows++;
      continue;
    }

    var ticker = normalizeTicker_(row[0]);
    var dateKey = normalizeDateKey_(row[1]);

    if (!ticker || !dateKey) {
      skippedInvalidRows++;
      continue;
    }

    var key = ticker + '|' + dateKey;

    if (incomingSeen[key]) {
      incomingDuplicateRows++;
      continue;
    }

    incomingSeen[key] = true;

    var cleanRow = normalizeOhlcvRowWidth_(row, width);
    cleanRow[0] = ticker;

    prepared.push({
      key: key,
      ticker: ticker,
      dateKey: dateKey,
      row: cleanRow
    });
  }

  return {
    prepared: prepared,
    incomingDuplicateRows: incomingDuplicateRows,
    skippedInvalidRows: skippedInvalidRows
  };
}

function normalizeOhlcvRowWidth_(row, width) {
  var cleanRow = [];

  for (var i = 0; i < width; i++) {
    cleanRow.push(i < row.length ? row[i] : '');
  }

  return cleanRow;
}

/**
 * Fast duplicate guard for daily sync.
 *
 * Only scans the DB tail, not the whole DB.
 * This is specifically designed to catch rerun/timeout duplicates where the
 * duplicate rows are near the end of DB_OHLCV.
 */
function buildRecentExistingOhlcvKeySet_(dbSheet, lookbackRows) {
  var existingKeys = {};
  var lastRow = dbSheet.getLastRow();

  if (lastRow < 2) return existingKeys;

  var safeLookbackRows = Math.max(1, Number(lookbackRows) || OHLCV_APPEND_DEFAULT_LOOKBACK_ROWS);
  var startRow = Math.max(2, lastRow - safeLookbackRows + 1);
  var numRows = lastRow - startRow + 1;

  var recent = dbSheet.getRange(startRow, 1, numRows, 2).getValues();

  for (var i = 0; i < recent.length; i++) {
    var ticker = normalizeTicker_(recent[i][0]);
    var dateKey = normalizeDateKey_(recent[i][1]);

    if (!ticker || !dateKey) continue;

    existingKeys[ticker + '|' + dateKey] = true;
  }

  return existingKeys;
}

/**
 * Exact duplicate guard for small repair/backfill batches.
 *
 * This intentionally uses dbHasTickerDate_ because correctness matters more
 * than speed for small batches.
 */
function buildExactExistingKeySetForSmallBatch_(dbSheet, prepared) {
  var existingKeys = {};

  for (var i = 0; i < prepared.length; i++) {
    var item = prepared[i];

    if (dbHasTickerDate_(dbSheet, item.ticker, item.dateKey)) {
      existingKeys[item.key] = true;
    }
  }

  return existingKeys;
}

/**
 * Safe duplicate check for small batches only.
 * Do not call this for all 503/504 tickers repeatedly.
 */
function dbHasTickerDate_(dbSheet, ticker, dateKey) {
  var normalizedTicker = normalizeTicker_(ticker);
  var normalizedDateKey = normalizeDateKey_(dateKey);
  var lastRow = dbSheet.getLastRow();

  if (!normalizedTicker || !normalizedDateKey) return false;
  if (lastRow < 2) return false;

  var matches = dbSheet
    .getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(normalizedTicker)
    .matchEntireCell(true)
    .findAll();

  if (!matches || matches.length === 0) return false;

  for (var i = 0; i < matches.length; i++) {
    var rowNum = matches[i].getRow();
    var existingDateKey = normalizeDateKey_(dbSheet.getRange(rowNum, 2).getValue());

    if (existingDateKey === normalizedDateKey) {
      return true;
    }
  }

  return false;
}

function pruneOhlcvCacheToLatestDays_(dbSheet, keepDays) {
  var days = Number(keepDays) || 3;
  var lastRow = dbSheet.getLastRow();

  if (lastRow < 2) return {
    keptDates: [],
    rowsKept: 0,
    rowsRemoved: 0
  };

  var values = dbSheet
    .getRange(2, 1, lastRow - 1, OHLCV_HEADER.length)
    .getValues();

  var dateMap = {};

  for (var i = 0; i < values.length; i++) {
    var dateKey = normalizeDateKey_(values[i][1]);
    if (dateKey) dateMap[dateKey] = true;
  }

  var keptDates = Object.keys(dateMap).sort().reverse().slice(0, days);
  var keepMap = {};

  keptDates.forEach(function(dateKey) {
    keepMap[dateKey] = true;
  });

  var keptRows = [];

  for (var r = 0; r < values.length; r++) {
    var rowDateKey = normalizeDateKey_(values[r][1]);
    if (keepMap[rowDateKey]) {
      keptRows.push(values[r]);
    }
  }

  dbSheet.getRange(2, 1, lastRow - 1, OHLCV_HEADER.length).clearContent();

  if (keptRows.length > 0) {
    dbSheet.getRange(2, 1, keptRows.length, OHLCV_HEADER.length).setValues(keptRows);
  }

  var extraRows = dbSheet.getMaxRows() - (keptRows.length + 1);
  if (extraRows > 100) {
    dbSheet.deleteRows(keptRows.length + 2, extraRows);
  }

  return {
    keptDates: keptDates,
    rowsKept: keptRows.length,
    rowsRemoved: values.length - keptRows.length
  };
}