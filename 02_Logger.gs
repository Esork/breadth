/**
 * 02_Logger.gs
 */

var SYS_LOG_RETENTION_DAYS = 5;

function writeSystemLog(moduleName, level, executionTime, message) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.LOGS, LOG_HEADER);

    // Newest log always goes to row 2. Row 1 is header.
    logSheet.insertRowAfter(1);

    logSheet.getRange(2, 1, 1, LOG_HEADER.length).setValues([[
      new Date(),
      moduleName,
      '[' + level + ']',
      executionTime,
      String(message)
    ]]);
    logSheet.getRange(2, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    trimLogSheet_(logSheet);

  } catch (e) {
    Logger.log('writeSystemLog Error: ' + String(e));
  }
}

function logInfo_(moduleName, startTimeMs, message) {
  writeSystemLog(
    moduleName,
    'INFO',
    startTimeMs ? getElapsedSeconds_(startTimeMs) : '0s',
    message
  );
}

function logWarn_(moduleName, startTimeMs, message) {
  writeSystemLog(
    moduleName,
    'WARN',
    startTimeMs ? getElapsedSeconds_(startTimeMs) : '0s',
    message
  );
}

function logError_(moduleName, startTimeMs, message) {
  writeSystemLog(
    moduleName,
    'ERROR',
    startTimeMs ? getElapsedSeconds_(startTimeMs) : '0s',
    message
  );
}

function trimLogSheet_(logSheet) {
  return trimSystemLogsOlderThanDays_(logSheet, SYS_LOG_RETENTION_DAYS);
}

function trimSystemLogsOlderThanDays_(logSheet, retentionDays) {
  var days = Number(retentionDays) || 5;
  var cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) return 0;

  var timestamps = logSheet
    .getRange(2, 1, lastRow - 1, 1)
    .getValues();

  var firstOldRow = null;
  var oldRowCount = 0;

  /**
   * Because newest logs are now at the top, old logs should be grouped
   * at the bottom. Scan from bottom upward and delete one contiguous block.
   */
  for (var i = timestamps.length - 1; i >= 0; i--) {
    var value = timestamps[i][0];
    var date = value instanceof Date ? value : new Date(value);

    if (date && !isNaN(date.getTime()) && date < cutoff) {
      firstOldRow = i + 2;
      oldRowCount++;
    } else {
      break;
    }
  }

  if (firstOldRow && oldRowCount > 0) {
    logSheet.deleteRows(firstOldRow, oldRowCount);
  }

  return oldRowCount;
}