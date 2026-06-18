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
