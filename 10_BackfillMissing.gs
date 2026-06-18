/**
 * 10_BackfillMissing.gs
 * Missing-only backfill using AUDIT_MISSING_OHLCV -> static SYS_BACKFILL_QUEUE.
 * This avoids Script timeout from scanning DB_OHLCV.
 */

function resetMissingOnlyBackfillFromAudit() {
  var startTime = Date.now();
  var module = SYS_CONFIG.BACKFILL.LOG_MODULE;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var auditSheet = ss.getSheetByName(SYS_CONFIG.SHEETS.AUDIT_MISSING);

  if (!auditSheet || auditSheet.getLastRow() < 2) {
    throw new Error('Audit sheet is empty. Run createMissingAuditFormula_* and wait for formula result first.');
  }

  var data = auditSheet
    .getRange(2, 1, auditSheet.getLastRow() - 1, 2)
    .getDisplayValues();

  var rows = [];

  for (var i = 0; i < data.length; i++) {
    var ticker = normalizeTicker_(data[i][0]);
    var dateKey = normalizeDateKey_(data[i][1]);
    if (ticker && dateKey) rows.push([ticker, dateKey, BACKFILL_STATUS.PENDING, '', '']);
  }

  var queueSheet = getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.BACKFILL_QUEUE, BACKFILL_QUEUE_HEADER);
  queueSheet.clear();
  queueSheet.appendRow(BACKFILL_QUEUE_HEADER);
  queueSheet.setFrozenRows(1);

  if (rows.length > 0) {
    queueSheet.getRange(2, 1, rows.length, BACKFILL_QUEUE_HEADER.length).setValues(rows);
  }

  PropertiesService.getScriptProperties().setProperty(
    SYS_CONFIG.BACKFILL.STATE_KEY,
    JSON.stringify({
      status: 'RUNNING',
      totalRows: rows.length,
      insertedCount: 0,
      duplicateCount: 0,
      skipCount: 0,
      failureCount: 0,
      startedAt: nowIso_()
    })
  );

  logWarn_(module, startTime, 'Backfill queue reset from audit. Missing rows=' + rows.length + ', approx tickers=' + Math.ceil(rows.length / 2));
}

function installMissingOnlyBackfillTrigger() {
  installEveryMinutesTrigger_('backfillMissingWorker', SYS_CONFIG.BACKFILL.WORKER_EVERY_MINUTES);
  writeSystemLog(SYS_CONFIG.BACKFILL.LOG_MODULE, 'INFO', '0s', 'Installed missing-only backfill worker every ' + SYS_CONFIG.BACKFILL.WORKER_EVERY_MINUTES + ' minutes.');
}

function clearMissingOnlyBackfillTriggers() {
  var deleted = deleteTriggersByHandler_('backfillMissingWorker');
  writeSystemLog(SYS_CONFIG.BACKFILL.LOG_MODULE, 'WARN', '0s', 'Cleared missing-only backfill triggers. Deleted=' + deleted);
}

function backfillMissingWorker() {
  var startTime = Date.now();
  var module = SYS_CONFIG.BACKFILL.LOG_MODULE;
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    logWarn_(module, startTime, 'Could not get lock. Worker skipped safely.');
    return;
  }

  try {
    runBackfillMissingBatch_();
  } catch (err) {
    logError_(module, startTime, String(err));
  } finally {
    lock.releaseLock();
  }
}

function runBackfillMissingBatch_() {
  var startTime = Date.now();
  var module = SYS_CONFIG.BACKFILL.LOG_MODULE;
  var props = PropertiesService.getScriptProperties();
  var state = parseJsonSafe_(props.getProperty(SYS_CONFIG.BACKFILL.STATE_KEY), null);

  if (!state || state.status !== 'RUNNING') {
    logInfo_(module, null, 'No active missing backfill state. Worker idle.');
    deleteTriggersByHandler_('backfillMissingWorker');
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var queueSheet = getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.BACKFILL_QUEUE, BACKFILL_QUEUE_HEADER);
  var dbSheet = getDbSheet_(ss);
  var tempSheet = getBufferSheet_(ss);

  var pendingJobs = getPendingBackfillJobs_(queueSheet, SYS_CONFIG.BACKFILL.BATCH_TICKERS);

  if (pendingJobs.tickers.length === 0) {
    finishBackfillMissing_(state, startTime);
    return;
  }

  logInfo_(
    module,
    null,
    'Processing missing tickers count=' +
      pendingJobs.tickers.length +
      ', pending rows in batch=' +
      pendingJobs.rowCount
  );

  for (var i = 0; i < pendingJobs.tickers.length; i++) {
    var ticker = pendingJobs.tickers[i];
    var job = pendingJobs.byTicker[ticker];
    var wantedDateKeys = Object.keys(job.dateRows).sort();
    var processedDateKeys = {};

    try {
      var rows = fetchGoogleFinanceBarsForRange_(
        tempSheet,
        ticker,
        minDateKey_(wantedDateKeys),
        maxDateKey_(wantedDateKeys)
      );

      var foundMap = {};

      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var rowDateKey = normalizeDateKey_(row.dateKey);

        if (!job.dateRows[rowDateKey]) {
          continue;
        }

        foundMap[rowDateKey] = true;

        if (dbHasTickerDate_(dbSheet, ticker, rowDateKey)) {
          state.duplicateCount++;
          processedDateKeys[rowDateKey] = true;

          markQueueRows_(
            queueSheet,
            job.dateRows[rowDateKey],
            BACKFILL_STATUS.DUPLICATE,
            'Already exists in DB'
          );

          props.setProperty(
            SYS_CONFIG.BACKFILL.STATE_KEY,
            JSON.stringify(state)
          );

          continue;
        }

        // Critical rule:
        // exact DB append must succeed BEFORE queue is marked DONE.
        var appended = appendOhlcvRowsExactSmallBatch_(dbSheet, [[
          ticker,
          row.date,
          row.open,
          row.high,
          row.low,
          row.close,
          row.volume
        ]]);

        if (appended === 1) {
          state.insertedCount++;
          processedDateKeys[rowDateKey] = true;

          markQueueRows_(
            queueSheet,
            job.dateRows[rowDateKey],
            BACKFILL_STATUS.DONE,
            'Inserted into DB'
          );

        } else if (dbHasTickerDate_(dbSheet, ticker, rowDateKey)) {
          // Guarded append may return 0 if another worker / prior run already inserted it.
          state.duplicateCount++;
          processedDateKeys[rowDateKey] = true;

          markQueueRows_(
            queueSheet,
            job.dateRows[rowDateKey],
            BACKFILL_STATUS.DUPLICATE,
            'Already exists in DB after guarded append'
          );

        } else {
          state.failureCount++;
          processedDateKeys[rowDateKey] = true;

          markQueueRows_(
            queueSheet,
            job.dateRows[rowDateKey],
            BACKFILL_STATUS.FAILED,
            'appendOhlcvRowsExactSmallBatch_ returned 0 and DB still missing row'
          );
        }

        props.setProperty(
          SYS_CONFIG.BACKFILL.STATE_KEY,
          JSON.stringify(state)
        );
      }

      for (var d = 0; d < wantedDateKeys.length; d++) {
        var dateKey = wantedDateKeys[d];

        if (!foundMap[dateKey] && !processedDateKeys[dateKey]) {
          state.skipCount++;
          processedDateKeys[dateKey] = true;

          markQueueRows_(
            queueSheet,
            job.dateRows[dateKey],
            BACKFILL_STATUS.SKIPPED,
            'GoogleFinance returned no row for date'
          );

          props.setProperty(
            SYS_CONFIG.BACKFILL.STATE_KEY,
            JSON.stringify(state)
          );
        }
      }

    } catch (err) {
      for (var f = 0; f < wantedDateKeys.length; f++) {
        var failedDateKey = wantedDateKeys[f];

        if (processedDateKeys[failedDateKey]) {
          continue;
        }

        state.failureCount++;

        markQueueRows_(
          queueSheet,
          job.dateRows[failedDateKey],
          BACKFILL_STATUS.FAILED,
          String(err).slice(0, 250)
        );
      }

      props.setProperty(
        SYS_CONFIG.BACKFILL.STATE_KEY,
        JSON.stringify(state)
      );

      logError_(module, null, ticker + ': ' + String(err));
    }

    if (Date.now() - startTime > SYS_CONFIG.DAILY_SYNC.MAX_RUNTIME_MS) {
      logWarn_(
        module,
        startTime,
        'Runtime guard hit after safe commit. Worker will continue next run.'
      );
      break;
    }
  }

  props.setProperty(
    SYS_CONFIG.BACKFILL.STATE_KEY,
    JSON.stringify(state)
  );

  logInfo_(
    module,
    startTime,
    'Batch committed safely. Inserted=' +
      state.insertedCount +
      ', Duplicates=' +
      state.duplicateCount +
      ', Skipped=' +
      state.skipCount +
      ', Failed=' +
      state.failureCount
  );
}

function getPendingBackfillJobs_(queueSheet, maxTickers) {
  var lastRow = queueSheet.getLastRow();
  var result = { tickers: [], byTicker: {}, rowCount: 0 };
  if (lastRow < 2) return result;

  var values = queueSheet
    .getRange(2, 1, lastRow - 1, BACKFILL_QUEUE_HEADER.length)
    .getDisplayValues();

  for (var i = 0; i < values.length; i++) {
    var rowNumber = i + 2;
    var ticker = normalizeTicker_(values[i][0]);
    var dateKey = normalizeDateKey_(values[i][1]);
    var status = values[i][2];

    if (!ticker || !dateKey) continue;
    if (!isBackfillStatusPending_(status)) continue;

    if (!result.byTicker[ticker]) {
      if (result.tickers.length >= maxTickers) continue;

      result.byTicker[ticker] = { dateRows: {} };
      result.tickers.push(ticker);
    }

    if (!result.byTicker[ticker].dateRows[dateKey]) {
      result.byTicker[ticker].dateRows[dateKey] = [];
    }

    result.byTicker[ticker].dateRows[dateKey].push(rowNumber);
    result.rowCount++;
  }

  return result;
}

function isBackfillStatusPending_(status) {
  var s = String(status || '').trim().toUpperCase();
  var pending = String(BACKFILL_STATUS.PENDING || '').trim().toUpperCase();

  return (
    s === '' ||
    s === 'PENDING' ||
    (pending && s === pending)
  );
}

function markQueueRows_(queueSheet, rowNumbers, status, message) {
  if (!rowNumbers || rowNumbers.length === 0) return;

  var now = new Date();
  for (var i = 0; i < rowNumbers.length; i++) {
    queueSheet.getRange(rowNumbers[i], 3, 1, 3).setValues([[status, message || '', now]]);
  }
}

function finishBackfillMissing_(state, startTime) {
  PropertiesService.getScriptProperties().deleteProperty(SYS_CONFIG.BACKFILL.STATE_KEY);
  deleteTriggersByHandler_('backfillMissingWorker');

  writeSystemLog(
    SYS_CONFIG.BACKFILL.LOG_MODULE,
    state.failureCount > 0 || state.skipCount > 0 ? 'WARN' : 'INFO',
    getElapsedSeconds_(startTime),
    'Missing-only backfill finished. Inserted=' + state.insertedCount +
      ', Duplicates=' + state.duplicateCount +
      ', Skipped=' + state.skipCount +
      ', Failed=' + state.failureCount
  );
}

function inspectMissingBackfillState() {
  var stateText = PropertiesService.getScriptProperties().getProperty(SYS_CONFIG.BACKFILL.STATE_KEY);
  Logger.log(SYS_CONFIG.BACKFILL.STATE_KEY + ' = ' + stateText);
  writeSystemLog(SYS_CONFIG.BACKFILL.LOG_MODULE, 'INFO', '0s', 'Missing backfill state inspected. Check Apps Script Logger.');
}

/* Backward-compatible wrappers from the emergency patch period. */
function resetMissingOnlyBackfill_Jun3_Jun4_FAST() {
  resetMissingOnlyBackfillFromAudit();
}

function runMissingOnlyBackfillBatch() {
  backfillMissingWorker();
}
