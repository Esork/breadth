/**
 * 12_CloudflareSync.gs
 * Push Google Sheet registry / OHLCV data into Cloudflare Worker + D1.
 *
 * Design:
 * - Never push OHLCV unless source date health is OK.
 * - POST failures must throw, not silently continue.
 * - Historical migration should use row cursor, not date full-scans.
 */

var CF_LAST_OHLCV_PUSH_PROP_KEY = 'QE_CF_LAST_OHLCV_PUSH_V1';

function getCloudflareIngestToken_() {
  var token = PropertiesService
    .getScriptProperties()
    .getProperty('CF_INGEST_TOKEN');

  token = String(token || '').trim();

  if (!token) {
    throw new Error(
      'Missing Script Property CF_INGEST_TOKEN. Add it in Apps Script Project Settings.'
    );
  }

  if (token === 'CHANGE_ME_LATER') {
    throw new Error('CF_INGEST_TOKEN is still CHANGE_ME_LATER.');
  }

  return token;
}

/**
 * Public smoke-test entrypoint.
 *
 * This should be the first OHLCV push:
 * - runs latest DB health gate
 * - only pushes if health is OK
 * - reads latest date from DB tail, not full DB
 */
function pushLatestCleanOhlcvDateToCloudflare() {
  var health = inspectLatestOhlcvDateHealth();

  if (!health || health.status !== 'OK') {
    throw new Error(
      'Refusing Cloudflare OHLCV push because latest health is not OK: ' +
        JSON.stringify(health)
    );
  }

  return pushOhlcvDateFromTailToCloudflare_(
    health.date,
    Math.max(Number(health.scannedRows) || 2000, 2000),
    health
  );
}

/**
 * Tail-based OHLCV date push.
 *
 * Safe for latest/recent dates only.
 * Historical migration should NOT use this repeatedly because historical dates
 * are not guaranteed to be in the DB tail.
 */
function pushOhlcvDateFromTailToCloudflare_(dateKey, lookbackRows, healthResult) {
  var startTime = Date.now();
  var module = SYS_CONFIG.CLOUDFLARE.LOG_MODULE;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);

  var normalizedDateKey = normalizeDateKey_(dateKey);
  if (!normalizedDateKey) throw new Error('dateKey required.');

  var rows = readOhlcvRowsFromTailByDate_(
    dbSheet,
    normalizedDateKey,
    lookbackRows || 2000
  );

  if (healthResult) {
    if (rows.length !== Number(healthResult.rawRows)) {
      throw new Error(
        'Tail read row count mismatch. Date=' +
          normalizedDateKey +
          ', healthRawRows=' +
          healthResult.rawRows +
          ', rowsRead=' +
          rows.length
      );
    }

    if (healthResult.status !== 'OK') {
      throw new Error(
        'Refusing OHLCV push because health is not OK. ' +
          JSON.stringify(healthResult)
      );
    }
  }

  if (rows.length === 0) {
    throw new Error('No OHLCV rows found in DB tail for date=' + normalizedDateKey);
  }

  var result = postCloudflareInBatches_('/ingest/ohlcv', rows, {
    throwOnFailure: true
  });

  var payload = {
    pushedAt: new Date().toISOString(),
    date: normalizedDateKey,
    rows: rows.length,
    acceptedRows: result.acceptedRows,
    insertedRows: result.insertedRows,
    totalBatches: result.totalBatches,
    health: healthResult || null
  };

  PropertiesService
    .getScriptProperties()
    .setProperty(CF_LAST_OHLCV_PUSH_PROP_KEY, JSON.stringify(payload));

  logInfo_(
    module,
    startTime,
    'OHLCV date pushed to Cloudflare. Date=' +
      normalizedDateKey +
      ', Rows=' +
      rows.length +
      ', Accepted=' +
      result.acceptedRows +
      ', Inserted=' +
      result.insertedRows +
      ', Batches=' +
      result.totalBatches
  );

  return payload;
}

function readOhlcvRowsFromTailByDate_(dbSheet, targetDateKey, lookbackRows) {
  var dateKey = normalizeDateKey_(targetDateKey);
  var lastRow = dbSheet.getLastRow();

  if (lastRow < 2) return [];

  var safeLookbackRows = Math.max(1000, Number(lookbackRows) || 2000);
  var startRow = Math.max(2, lastRow - safeLookbackRows + 1);
  var numRows = lastRow - startRow + 1;

  var values = dbSheet
    .getRange(startRow, 1, numRows, OHLCV_HEADER.length)
    .getValues();

  var rows = [];
  var seen = {};
  var duplicateKeys = [];

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var ticker = normalizeTicker_(row[0]);
    var rowDateKey = normalizeDateKey_(row[1]);

    if (!ticker || rowDateKey !== dateKey) continue;

    var key = ticker + '|' + rowDateKey;

    if (seen[key]) {
      duplicateKeys.push(key);
      continue;
    }

    seen[key] = true;
    rows.push(normalizeOhlcvRowForCloudflare_(row, rowDateKey));
  }

  if (duplicateKeys.length > 0) {
    throw new Error(
      'Duplicate OHLCV keys found while reading tail for Cloudflare push. Date=' +
        dateKey +
        ', DuplicateSamples=' +
        duplicateKeys.slice(0, 20).join(', ')
    );
  }

  return rows;
}

function normalizeOhlcvRowForCloudflare_(row, dateKey) {
  var ticker = normalizeTicker_(row[0]);
  var normalizedDateKey = normalizeDateKey_(dateKey || row[1]);

  if (!ticker || !normalizedDateKey) {
    throw new Error('Invalid OHLCV row key: ' + JSON.stringify(row));
  }

  return {
    ticker: ticker,
    date: normalizedDateKey,
    open: toNullableNumber_(row[2]),
    high: toNullableNumber_(row[3]),
    low: toNullableNumber_(row[4]),
    close: toNullableNumber_(row[5]),
    volume: toNullableInteger_(row[6]),
    source: 'GOOGLEFINANCE'
  };
}

function toNullableNumber_(value) {
  if (value === '' || value === null || typeof value === 'undefined') return null;

  var n = Number(value);
  if (!isFinite(n)) return null;

  return n;
}

function toNullableInteger_(value) {
  if (value === '' || value === null || typeof value === 'undefined') return null;

  var n = Number(value);
  if (!isFinite(n)) return null;

  return Math.round(n);
}

/**
 * Strict Cloudflare batch POST helper.
 *
 * Important:
 * Failed batch defaults to throw.
 * Historical migration must never silently continue after a failed batch,
 * because cursor advancement depends on confirmed POST success.
 */
function postCloudflareInBatches_(path, rows, options) {
  assertCloudflareConfig_();
  var ingestToken = getCloudflareIngestToken_();
  var opts = options || {};
  var throwOnFailure = opts.throwOnFailure !== false;

  var batchSize = SYS_CONFIG.CLOUDFLARE.BATCH_SIZE || 100;
  var acceptedRows = 0;
  var insertedRows = 0;
  var failedBatches = 0;
  var totalBatches = 0;
  var responses = [];

  if (!rows || rows.length === 0) {
    return {
      acceptedRows: 0,
      insertedRows: 0,
      failedBatches: 0,
      totalBatches: 0,
      responses: []
    };
  }

  for (var i = 0; i < rows.length; i += batchSize) {
    var batch = rows.slice(i, i + batchSize);
    totalBatches++;

    var response = UrlFetchApp.fetch(
      SYS_CONFIG.CLOUDFLARE.BASE_URL + path,
      {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        payload: JSON.stringify({
          data: batch
        }),
        headers: {
          Authorization: 'Bearer ' + getCloudflareIngestToken_()
        }
      }
    );

    var code = response.getResponseCode();
    var text = response.getContentText();
    var parsed = parseJsonSafe_(text, {});

    if (code < 200 || code >= 300 || parsed.ok === false) {
      failedBatches++;

      var message =
        'Cloudflare POST failed. Path=' +
        path +
        ', HTTP=' +
        code +
        ', Body=' +
        text;

      writeSystemLog(
        SYS_CONFIG.CLOUDFLARE.LOG_MODULE,
        'ERROR',
        '0s',
        message
      );

      if (throwOnFailure) {
        throw new Error(message);
      }

      continue;
    }

    var accepted = Number(parsed.received || parsed.accepted || batch.length);
    var inserted = Number(parsed.inserted || 0);

    acceptedRows += accepted;
    insertedRows += inserted;

    if (responses.length < 5) {
      responses.push({
        httpCode: code,
        accepted: accepted,
        inserted: inserted,
        body: text.slice(0, 500)
      });
    }
  }

  return {
    acceptedRows: acceptedRows,
    insertedRows: insertedRows,
    failedBatches: failedBatches,
    totalBatches: totalBatches,
    responses: responses
  };
}

function assertCloudflareConfig_() {
  if (!SYS_CONFIG.CLOUDFLARE) {
    throw new Error('Missing SYS_CONFIG.CLOUDFLARE');
  }

  if (!SYS_CONFIG.CLOUDFLARE.BASE_URL) {
    throw new Error('Missing SYS_CONFIG.CLOUDFLARE.BASE_URL');
  }

  getCloudflareIngestToken_();
}

function deriveOhlcvDateOnCloudflare_(dateKey, startTime) {
  var module = SYS_CONFIG.CLOUDFLARE.LOG_MODULE;
  var normalizedDateKey = normalizeDateKey_(dateKey);

  if (!normalizedDateKey) {
    throw new Error('Invalid derive date: ' + dateKey);
  }

  var path = '/jobs/derive/date?date=' + encodeURIComponent(normalizedDateKey);

  var response = UrlFetchApp.fetch(
    SYS_CONFIG.CLOUDFLARE.BASE_URL + path,
    {
      method: 'post',
      muteHttpExceptions: true,
      headers: {
        Authorization: 'Bearer ' + getCloudflareIngestToken_()
      }
    }
  );

  var code = response.getResponseCode();
  var text = response.getContentText();
  var parsed = parseJsonSafe_(text, {});

  if (code < 200 || code >= 300 || !parsed.ok) {
    writeSystemLog(
      module,
      'ERROR',
      getElapsedSeconds_(startTime || Date.now()),
      'Cloudflare derive failed. Date=' +
        normalizedDateKey +
        ', HTTP=' +
        code +
        ', Body=' +
        text
    );

    throw new Error(
      'Cloudflare derive failed. Date=' +
        normalizedDateKey +
        ', HTTP=' +
        code +
        ', Body=' +
        text
    );
  }

  writeSystemLog(
    module,
    'INFO',
    getElapsedSeconds_(startTime || Date.now()),
    'Cloudflare derive completed. Date=' +
      normalizedDateKey +
      ', RowsWritten=' +
      Number(parsed.rows_written || 0) +
      ', TickerIndicators=' +
      Number(parsed.derived && parsed.derived.ticker_indicators || 0) +
      ', MarketBreadth=' +
      Number(parsed.derived && parsed.derived.market_breadth || 0) +
      ', SectorBreadth=' +
      Number(parsed.derived && parsed.derived.sector_breadth || 0)
  );

  return parsed;
}
