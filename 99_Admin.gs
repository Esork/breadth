/**
 * 99_Admin.gs
 * Manual admin helpers. Safe entry points only.
 */

function bootstrapBackendSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  getRegistrySheet_(ss);
  getDbSheet_(ss);
  getBufferSheet_(ss);
  getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.LOGS, LOG_HEADER);
  writeSystemLog('ADMIN', 'INFO', '0s', 'Backend sheets bootstrapped.');
}

function inspectAllActiveStates() {
  var props = PropertiesService.getScriptProperties();
  [
    SYS_CONFIG.DAILY_SYNC.STATE_KEY,
    LEGACY_WORKER_STATE_KEYS.MISSING_BACKFILL,
    LEGACY_WORKER_STATE_KEYS.RANGE_BACKFILL,
    DAILY_LAST_HEALTH_PROP_KEY,
    CF_LAST_OHLCV_PUSH_PROP_KEY,
    PENDING_MEMBERSHIP_EVENTS_PROP_KEY
  ].forEach(function(key) { Logger.log(key + ' = ' + props.getProperty(key)); });
  var snapshot = buildTriggerSetupSnapshot_();
  Logger.log(JSON.stringify(snapshot, null, 2));
  writeSystemLog('ADMIN', 'INFO', '0s', 'States and triggers inspected. Check Apps Script Logger.');
}

function inspectOhlcvCacheDateAgainstCurrentRegistry(targetDate) {
  var dateKey = normalizeDateKey_(targetDate);
  if (!dateKey) throw new Error('Pass targetDate as YYYY-MM-DD.');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);
  var universePayload = fetchCloudflareJsonForAdmin_(
    '/api/universe?date=' + encodeURIComponent(dateKey)
  );
  var eligible = (universePayload.data || []).map(function(item) {
    return normalizeTicker_(typeof item === 'string' ? item : item.ticker);
  }).filter(Boolean);
  var eligibleMap = {};
  eligible.forEach(function(t) { eligibleMap[normalizeTicker_(t)] = true; });
  var lastRow = dbSheet.getLastRow();
  var values = lastRow < 2 ? [] : dbSheet.getRange(2, 1, lastRow - 1, OHLCV_HEADER.length).getValues();
  var presentMap = {}, extras = [];
  values.forEach(function(row) {
    var ticker = normalizeTicker_(row[0]);
    if (normalizeDateKey_(row[1]) !== dateKey || !ticker) return;
    presentMap[ticker] = true;
    if (!eligibleMap[ticker]) extras.push(ticker);
  });
  var missing = eligible.filter(function(t) { return !presentMap[normalizeTicker_(t)]; });
  var result = { date: dateKey, expectedEligibleCount: eligible.length,
    presentCount: Object.keys(presentMap).length, extras: extras.sort(), missing: missing.sort() };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function inspectPendingMembershipEvents() {
  var events = loadPendingMembershipEvents_();
  Logger.log(JSON.stringify(events, null, 2));

  writeSystemLog(
    SYS_CONFIG.CLOUDFLARE.LOG_MODULE,
    'INFO',
    '0s',
    'Pending membership events inspected. Count=' + events.length + '. Check Apps Script Logger.'
  );
}

function clearPendingMembershipEvents() {
  savePendingMembershipEvents_([]);
  Logger.log('Pending membership events cleared.');
}

function refreshSyncIndexFromDB() {
  var startTime = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dbSheet = getDbSheet_(ss);
  var registrySheet = getRegistrySheet_(ss);

  var lastRow = dbSheet.getLastRow();
  if (lastRow < 2) throw new Error('DB_OHLCV is empty.');

  var registryMap = loadRegistryMap_(registrySheet);

  var data = dbSheet
    .getRange(2, 1, lastRow - 1, 2)
    .getValues();

  for (var i = 0; i < data.length; i++) {
    var ticker = normalizeTicker_(data[i][0]);
    var dateKey = normalizeDateKey_(data[i][1]);

    if (!ticker || !dateKey) continue;

    if (!registryMap[ticker]) {
      registryMap[ticker] = {
        ticker: ticker,
        isCurrentSP500: false,
        isActive: true,
        source: 'db-rebuild'
      };
    }

    if (!registryMap[ticker].lastSyncedDate || dateKey > registryMap[ticker].lastSyncedDate) {
      registryMap[ticker].lastSyncedDate = dateKey;
    }

    registryMap[ticker].updatedAt = new Date();
  }

  saveRegistryMap_(registrySheet, registryMap);

  logInfo_(
    'SYNC_INDEX',
    startTime,
    'SYS_SYNC_INDEX rebuilt from DB_OHLCV. Registry tickers=' + Object.keys(registryMap).length
  );
}

function inspectLastDailyHealthGate() {
  var text = PropertiesService
    .getScriptProperties()
    .getProperty(DAILY_LAST_HEALTH_PROP_KEY);

  Logger.log(DAILY_LAST_HEALTH_PROP_KEY + ' = ' + text);

  writeSystemLog(
    SYS_CONFIG.DAILY_SYNC.LOG_MODULE,
    'INFO',
    '0s',
    'Last daily health gate inspected. Check Apps Script Logger.'
  );
}

function inspectDailySyncState() {
  var stateText = PropertiesService
    .getScriptProperties()
    .getProperty(SYS_CONFIG.DAILY_SYNC.STATE_KEY);

  Logger.log(SYS_CONFIG.DAILY_SYNC.STATE_KEY + ' = ' + stateText);

  writeSystemLog(
    SYS_CONFIG.DAILY_SYNC.LOG_MODULE,
    'INFO',
    '0s',
    'Daily sync state inspected. Check Apps Script Logger.'
  );
}

function resetDailySyncState() {
  PropertiesService
    .getScriptProperties()
    .deleteProperty(SYS_CONFIG.DAILY_SYNC.STATE_KEY);

  deleteTriggersByHandler_('dailySyncWorker');

  writeSystemLog(
    SYS_CONFIG.DAILY_SYNC.LOG_MODULE,
    'WARN',
    '0s',
    'Daily sync state reset and worker trigger cleared.'
  );
}

function createMissingAuditFormula(targetDateKeys) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet_(ss, SYS_CONFIG.SHEETS.AUDIT_MISSING, null);
  if (!targetDateKeys || targetDateKeys.length === 0) {
    throw new Error('targetDateKeys required.');
  }
  sheet.clear();

  var registryName = SYS_CONFIG.SHEETS.SYNC_INDEX;
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
    'Missing audit formula created for current eligible tickers. Dates=' +
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

/**
 * Legacy callbacks: remove stale triggers only; never run or clear old jobs.
 */
function stopLegacyWorkerTrigger_(handlerName) {
  var deleted = deleteTriggersByHandler_(handlerName);
  writeSystemLog('ADMIN', 'WARN', '0s',
    'Retired legacy worker trigger. Handler=' + handlerName + ', Deleted=' + deleted);
}
function backfillMissingWorker() { stopLegacyWorkerTrigger_('backfillMissingWorker'); }
function runMissingOnlyBackfillBatch() { stopLegacyWorkerTrigger_('runMissingOnlyBackfillBatch'); }
function backfillRangeWorker() { stopLegacyWorkerTrigger_('backfillRangeWorker'); }

function inspectTriggerSetup() {
  var result = buildTriggerSetupSnapshot_();

  Logger.log(JSON.stringify(result, null, 2));

  writeSystemLog(
    'TRIGGER_SETUP',
    'INFO',
    '0s',
    'Trigger setup inspected. ProductionTriggers=' +
      result.productionTriggers.length +
      ', WorkerTriggers=' +
      result.workerTriggers.length +
      ', OtherTriggers=' +
      result.otherTriggers.length +
      ', BlockingStates=' +
      result.blockingStates.length
  );

  return result;
}

function inspectLastCloudflareOhlcvPush() {
  var text = PropertiesService.getScriptProperties().getProperty(CF_LAST_OHLCV_PUSH_PROP_KEY);
  Logger.log(CF_LAST_OHLCV_PUSH_PROP_KEY + ' = ' + text);
  writeSystemLog(SYS_CONFIG.CLOUDFLARE.LOG_MODULE, 'INFO', '0s',
    'Last Cloudflare OHLCV push inspected. Check Apps Script Logger.');
}

function backfillV2_RunNextBatch() { stopLegacyWorkerTrigger_('backfillV2_RunNextBatch'); }
function continueBackfillOHLCV() { stopLegacyWorkerTrigger_('continueBackfillOHLCV'); }
function continueDailyIncrementalSync() { stopLegacyWorkerTrigger_('continueDailyIncrementalSync'); }
function cloudflareHistoricalOhlcvWorker() { stopLegacyWorkerTrigger_('cloudflareHistoricalOhlcvWorker'); }
function cloudflareOhlcvSyncWorker() { stopLegacyWorkerTrigger_('cloudflareOhlcvSyncWorker'); }

function fetchCloudflareJsonForAdmin_(path) {
  var response = UrlFetchApp.fetch(SYS_CONFIG.CLOUDFLARE.BASE_URL + path, {
    method: 'get', muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  var body = response.getContentText();
  var parsed = parseJsonSafe_(body, null);
  if (code < 200 || code >= 300 || !parsed) {
    throw new Error('Cloudflare GET failed. Path=' + path +
      ', HTTP=' + code + ', Body=' + body);
  }
  return parsed;
}
