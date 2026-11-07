/**
 * 04_Triggers.gs
 * Trigger management.
 *
 * Design:
 * - Production triggers should only be installed when worker states are clean.
 * - Repair/backfill worker triggers must not overlap production daily sync.
 * - Trigger install should be idempotent: delete old trigger first, then create one.
 */

var PRODUCTION_TICKER_SYNC_HOUR = 11;
var PRODUCTION_DAILY_SYNC_HOUR = 12;

function deleteTriggersByHandler_(handlerName) {
  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;

  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(triggers[i]);
      deleted++;
    }
  }

  return deleted;
}

function installEveryMinutesTrigger_(handlerName, minutes) {
  var safeMinutes = Number(minutes) || 5;

  deleteTriggersByHandler_(handlerName);

  ScriptApp
    .newTrigger(handlerName)
    .timeBased()
    .everyMinutes(safeMinutes)
    .create();

  writeSystemLog(
    'TRIGGER_SETUP',
    'INFO',
    '0s',
    'Installed worker trigger: ' + handlerName + ' every ' + safeMinutes + ' minutes.'
  );
}

function getKnownWorkerTriggerHandlers_() {
  return [
    'dailySyncWorker',
    'backfillMissingWorker',
    'backfillRangeWorker',

    // Legacy / emergency-era handlers.
    'runMissingOnlyBackfillBatch',
    'backfillV2_RunNextBatch',
    'continueBackfillOHLCV',
    'continueDailyIncrementalSync',

    // Future Cloudflare worker names. Safe to include before they exist.
    'cloudflareHistoricalOhlcvWorker',
    'cloudflareOhlcvSyncWorker',
    'runNov2026OhlcvRecoveryWorker'
  ];
}

function getProductionTriggerHandlers_() {
  return [
    'syncSP500TickersList',
    'startDailySyncNow',

    // Backward-compatible old production entrypoint.
    'dailyIncrementalSync'
  ];
}

function clearAllKnownWorkerTriggers() {
  var handlers = getKnownWorkerTriggerHandlers_();
  var count = 0;

  handlers.forEach(function(handler) {
    count += deleteTriggersByHandler_(handler);
  });

  writeSystemLog(
    'TRIGGER_SETUP',
    'WARN',
    '0s',
    'Cleared known worker/debug triggers. Deleted=' + count
  );

  return count;
}

function clearProductionTriggers() {
  var handlers = getProductionTriggerHandlers_();
  var count = 0;

  handlers.forEach(function(handler) {
    count += deleteTriggersByHandler_(handler);
  });

  writeSystemLog(
    'TRIGGER_SETUP',
    'WARN',
    '0s',
    'Cleared production triggers. Deleted=' + count
  );

  return count;
}

/**
 * Strict production install.
 *
 * This refuses to install production triggers if any worker state exists.
 * If a stale worker state is intentionally safe to clear, run the relevant
 * reset function first:
 *
 * - inspectAllActiveStates() in 99_Admin.gs; clear only the specific stale state
 */
function installProductionTriggers() {
  assertNoActiveWorkerStatesForProduction_();

  var clearedWorkers = clearAllKnownWorkerTriggers();
  var clearedProduction = clearProductionTriggers();

  ScriptApp
    .newTrigger('syncSP500TickersList')
    .timeBased()
    .everyDays(1)
    .atHour(PRODUCTION_TICKER_SYNC_HOUR)
    .create();

  ScriptApp
    .newTrigger('startDailySyncNow')
    .timeBased()
    .everyDays(1)
    .atHour(PRODUCTION_DAILY_SYNC_HOUR)
    .create();

  writeSystemLog(
    'TRIGGER_SETUP',
    'INFO',
    '0s',
    'Installed production triggers. ' +
      'syncSP500TickersList daily ' +
      PRODUCTION_TICKER_SYNC_HOUR +
      ':00; startDailySyncNow daily ' +
      PRODUCTION_DAILY_SYNC_HOUR +
      ':00. ClearedWorkers=' +
      clearedWorkers +
      ', ClearedProduction=' +
      clearedProduction
  );
}

/**
 * Public inspection helper.
 * Use before installing production triggers.
 */
function assertNoActiveWorkerStatesForProduction_() {
  var snapshot = buildTriggerSetupSnapshot_();

  if (snapshot.blockingStates.length > 0) {
    throw new Error(
      'Refusing to install production triggers because worker state exists: ' +
        JSON.stringify(snapshot.blockingStates)
    );
  }
}

function buildTriggerSetupSnapshot_() {
  var triggers = ScriptApp.getProjectTriggers();
  var productionHandlers = mapArrayToSet_(getProductionTriggerHandlers_());
  var workerHandlers = mapArrayToSet_(getKnownWorkerTriggerHandlers_());

  var productionTriggers = [];
  var workerTriggers = [];
  var otherTriggers = [];

  for (var i = 0; i < triggers.length; i++) {
    var handler = triggers[i].getHandlerFunction();
    var item = {
      handler: handler,
      eventType: String(triggers[i].getEventType()),
      source: String(triggers[i].getTriggerSource())
    };

    if (productionHandlers[handler]) {
      productionTriggers.push(item);
    } else if (workerHandlers[handler]) {
      workerTriggers.push(item);
    } else {
      otherTriggers.push(item);
    }
  }

  return {
    productionTriggers: productionTriggers,
    workerTriggers: workerTriggers,
    otherTriggers: otherTriggers,
    blockingStates: getBlockingWorkerStatesForProduction_()
  };
}

function getBlockingWorkerStatesForProduction_() {
  var props = PropertiesService.getScriptProperties();
  var states = [];

  var dailyStateText = props.getProperty(SYS_CONFIG.DAILY_SYNC.STATE_KEY);
  if (dailyStateText) {
    states.push({
      key: SYS_CONFIG.DAILY_SYNC.STATE_KEY,
      state: parseJsonSafe_(dailyStateText, dailyStateText)
    });
  }

  Object.keys(LEGACY_WORKER_STATE_KEYS).forEach(function(name) {
    var key = LEGACY_WORKER_STATE_KEYS[name];
    var stateText = props.getProperty(key);
    if (stateText) states.push({ key: key, state: parseJsonSafe_(stateText, stateText) });
  });

  return states;
}

function mapArrayToSet_(arr) {
  var map = {};

  for (var i = 0; i < arr.length; i++) {
    map[arr[i]] = true;
  }

  return map;
}