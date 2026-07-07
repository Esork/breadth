/**
 * 06_TickerSync.gs
 *
 * Sync S&P 500 ticker registry into SYS_SYNC_INDEX.
 * SYS_TICKERS is deprecated.
 */

var PENDING_MEMBERSHIP_EVENTS_PROP_KEY = 'QE_PENDING_MEMBERSHIP_EVENTS_V1';
var MAX_MEMBERSHIP_EVENTS_PER_SYNC_ = 25;

function syncSP500TickersList() {
  return syncSP500TickerRegistry();
}

function syncSP500TickerRegistry() {
  var startTime = Date.now();
  var module = SYS_CONFIG.TICKER_SYNC.LOG_MODULE;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var registrySheet = getRegistrySheet_(ss);

  logInfo_(module, null, 'Starting S&P 500 ticker registry sync.');

  var sources = [
    { name: 'PRIMARY', url: SYS_CONFIG.SOURCES.SP500_PRIMARY },
    { name: 'BACKUP', url: SYS_CONFIG.SOURCES.SP500_BACKUP }
  ];

  var csvText = null;
  var sourceUsed = null;

  for (var s = 0; s < sources.length; s++) {
    try {
      var response = UrlFetchApp.fetch(sources[s].url, {
        muteHttpExceptions: true
      });

      if (response.getResponseCode() !== 200) {
        throw new Error('HTTP ' + response.getResponseCode());
      }

      csvText = response.getContentText();
      sourceUsed = sources[s].name;
      break;

    } catch (err) {
      logWarn_(module, startTime, sources[s].name + ' failed: ' + err.message);
    }
  }

  if (!csvText) {
    logError_(module, startTime, 'All ticker registry sources failed.');
    return;
  }

  try {
    var parsed = parseSP500ConstituentCsv_(csvText);

    if (parsed.length < SYS_CONFIG.TICKER_SYNC.MIN_EXPECTED_COUNT) {
      throw new Error('Circuit breaker: only ' + parsed.length + ' tickers fetched.');
    }

    var registryMap = loadRegistryMap_(registrySheet);
    var now = new Date();
    var todayKey = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');

    // --- Snapshot BEFORE any mutation. Used later to detect ADD/REMOVE
    // membership events by diffing "before" vs "after" isCurrentSP500 state.
    // Doing it this way (rather than checking dateAdded/dateRemoved === todayKey)
    // means re-running this function multiple times on the same day will NOT
    // re-fire duplicate events, since the second run's "before" snapshot already
    // reflects the first run's changes.
    var wasCurrentBefore_ = {};
    var snapshotTickers = Object.keys(registryMap);
    for (var sIdx = 0; sIdx < snapshotTickers.length; sIdx++) {
      wasCurrentBefore_[snapshotTickers[sIdx]] =
        registryMap[snapshotTickers[sIdx]].isCurrentSP500 === true;
    }

    // Mark all existing registry tickers as not current first.
    var existingTickers = Object.keys(registryMap);
    for (var e = 0; e < existingTickers.length; e++) {
      registryMap[existingTickers[e]].isCurrentSP500 = false;
      registryMap[existingTickers[e]].updatedAt = now;
    }

    var newCount = 0;
    var currentCount = 0;

    for (var i = 0; i < parsed.length; i++) {
      var item = parsed[i];
      var ticker = item.ticker;
      if (!ticker) continue;

      if (!registryMap[ticker]) {
        registryMap[ticker] = {
          ticker: ticker,
          lastSyncedDate: '',
          dateAdded: todayKey,
          isActive: true
        };
        newCount++;
      }

      registryMap[ticker].name = item.name || registryMap[ticker].name || '';
      registryMap[ticker].sector = item.sector || registryMap[ticker].sector || '';
      registryMap[ticker].industry = item.industry || registryMap[ticker].industry || '';
      registryMap[ticker].subIndustry = item.subIndustry || registryMap[ticker].subIndustry || '';
      registryMap[ticker].sectorEtf = mapSectorToEtf_(registryMap[ticker].sector);

      registryMap[ticker].isCurrentSP500 = true;
      registryMap[ticker].isActive = registryMap[ticker].isActive === false ? false : true;
      registryMap[ticker].dateRemoved = '';
      registryMap[ticker].updatedAt = now;
      registryMap[ticker].source = sourceUsed;

      currentCount++;
    }

    // Set DateRemoved for names no longer in S&P 500.
    existingTickers = Object.keys(registryMap);
    for (var j = 0; j < existingTickers.length; j++) {
      var oldTicker = existingTickers[j];
      var row = registryMap[oldTicker];

      if (row.isCurrentSP500 === false && !row.dateRemoved) {
        row.dateRemoved = todayKey;
      }
    }

    // --- Diff snapshot vs current state to build membership change events.
    var membershipEvents = [];
    var allTickersAfter = Object.keys(registryMap);

    for (var m = 0; m < allTickersAfter.length; m++) {
      var tk = allTickersAfter[m];
      var isNowCurrent = registryMap[tk].isCurrentSP500 === true;
      var wasCurrent = wasCurrentBefore_[tk] === true;

      if (isNowCurrent && !wasCurrent) {
        membershipEvents.push({
          ticker: tk,
          action: 'ADD',
          effective_date: todayKey,
          source: 'auto_ticker_sync:' + sourceUsed,
          notes: 'Auto-detected by syncSP500TickerRegistry on ' + todayKey
        });
      } else if (!isNowCurrent && wasCurrent) {
        membershipEvents.push({
          ticker: tk,
          action: 'REMOVE',
          effective_date: todayKey,
          source: 'auto_ticker_sync:' + sourceUsed,
          notes: 'Auto-detected by syncSP500TickerRegistry on ' + todayKey
        });
      }
    }

    saveRegistryMap_(registrySheet, registryMap);

    logInfo_(
      module,
      startTime,
      'Ticker registry sync successful from ' +
        sourceUsed +
        '. CurrentSP500=' +
        currentCount +
        ', New=' +
        newCount +
        ', RegistryTotal=' +
        Object.keys(registryMap).length +
        ', MembershipEventsDetected=' +
        membershipEvents.length
    );

    if (membershipEvents.length > 0) {
      logInfo_(
        module,
        startTime,
        'Membership changes detected: ' +
          membershipEvents
            .map(function(ev) { return ev.action + ':' + ev.ticker; })
            .join(', ')
      );
    }

    // Cloudflare push is best-effort and self-contained: it will never throw
    // back into this function, and never blocks the Sheet-side sync above.
    pushMembershipDiffToCloudflare_(membershipEvents, startTime);

  } catch (err) {
    logError_(module, startTime, err.message);
  }
}

function parseSP500ConstituentCsv_(csvText) {
  var csv = Utilities.parseCsv(csvText);

  if (!csv || csv.length < 2) {
    throw new Error('Empty or invalid CSV.');
  }

  var header = csv[0].map(function(v) {
    return String(v || '').trim().toLowerCase();
  });

  var symbolIndex = findHeaderIndex_(header, ['symbol', 'ticker']);
  var nameIndex = findHeaderIndex_(header, ['security', 'name', 'company']);
  var sectorIndex = findHeaderIndex_(header, ['gics sector', 'sector']);
  var industryIndex = findHeaderIndex_(header, ['gics sub-industry', 'sub-industry', 'industry']);
  var subIndustryIndex = findHeaderIndex_(header, ['gics sub-industry', 'sub-industry']);

  if (symbolIndex === -1) {
    throw new Error('Cannot find Symbol column.');
  }

  var seen = {};
  var rows = [];

  for (var i = 1; i < csv.length; i++) {
    var ticker = normalizeTicker_(csv[i][symbolIndex]).replace(/\./g, '-');

    if (!ticker || ticker.length > 8 || seen[ticker]) {
      continue;
    }

    seen[ticker] = true;

    var name = nameIndex >= 0 ? String(csv[i][nameIndex] || '').trim() : '';
    var sector = sectorIndex >= 0 ? String(csv[i][sectorIndex] || '').trim() : '';
    var industry = industryIndex >= 0 ? String(csv[i][industryIndex] || '').trim() : '';
    var subIndustry = subIndustryIndex >= 0 ? String(csv[i][subIndustryIndex] || '').trim() : industry;

    rows.push({
      ticker: ticker,
      name: name,
      sector: normalizeSectorName_(sector),
      industry: industry,
      subIndustry: subIndustry
    });
  }

  return rows.sort(function(a, b) {
    return a.ticker > b.ticker ? 1 : a.ticker < b.ticker ? -1 : 0;
  });
}

function findHeaderIndex_(header, candidates) {
  for (var c = 0; c < candidates.length; c++) {
    var needle = String(candidates[c]).toLowerCase();

    for (var i = 0; i < header.length; i++) {
      if (header[i] === needle) {
        return i;
      }
    }
  }

  return -1;
}

function normalizeSectorName_(sector) {
  var value = String(sector || '').trim();

  if (value === 'Information Technology') return 'Technology';
  if (value === 'Communication Services') return 'Communication Services';
  if (value === 'Consumer Discretionary') return 'Consumer Discretionary';
  if (value === 'Consumer Staples') return 'Consumer Staples';

  return value;
}

function mapSectorToEtf_(sector) {
  var value = String(sector || '').trim();

  var map = {
    'Technology': 'XLK',
    'Information Technology': 'XLK',
    'Communication Services': 'XLC',
    'Consumer Discretionary': 'XLY',
    'Consumer Staples': 'XLP',
    'Energy': 'XLE',
    'Financials': 'XLF',
    'Health Care': 'XLV',
    'Healthcare': 'XLV',
    'Industrials': 'XLI',
    'Materials': 'XLB',
    'Real Estate': 'XLRE',
    'Utilities': 'XLU'
  };

  return map[value] || '';
}

/**
 * --- Membership diff push (new) ---
 *
 * Pushes ADD/REMOVE membership events to Cloudflare's /ingest/membership.
 * Design goals:
 * - Never throw back into syncSP500TickerRegistry(). All failures are caught
 *   and logged; the Sheet-side sync must succeed regardless of Cloudflare's
 *   availability.
 * - Never silently lose an event. Anything not confirmed successful is
 *   persisted to Script Properties and retried on the next run.
 * - Refuse to auto-push suspiciously large diffs (likely a bad data source),
 *   requiring manual review instead of mass-corrupting index_membership_periods.
 */
function pushMembershipDiffToCloudflare_(newEvents, startTime) {
  var module = SYS_CONFIG.CLOUDFLARE.LOG_MODULE;

  var pending = loadPendingMembershipEvents_();
  var merged = pending.concat(newEvents || []);

  // Dedupe by ticker+action+effective_date so retries don't pile up duplicates.
  var dedupMap = {};
  for (var i = 0; i < merged.length; i++) {
    var ev = merged[i];
    if (!ev || !ev.ticker || !ev.action || !ev.effective_date) continue;
    var key = ev.ticker + '|' + ev.action + '|' + ev.effective_date;
    dedupMap[key] = ev;
  }

  var events = Object.keys(dedupMap).map(function(k) { return dedupMap[k]; });

  if (events.length === 0) {
    return;
  }

  if (events.length > MAX_MEMBERSHIP_EVENTS_PER_SYNC_) {
    savePendingMembershipEvents_(events);
    logError_(
      module,
      startTime,
      'Membership diff too large (' + events.length +
        ' events) - refusing to auto-push. Possible bad data source. ' +
        'Review Script Property ' + PENDING_MEMBERSHIP_EVENTS_PROP_KEY + ' manually, ' +
        'then call clearPendingMembershipEvents() once resolved.'
    );
    return;
  }

  var response;
  try {
    assertCloudflareConfig_();

    response = UrlFetchApp.fetch(
      SYS_CONFIG.CLOUDFLARE.BASE_URL + '/ingest/membership',
      {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        payload: JSON.stringify({ data: events }),
        headers: {
          Authorization: 'Bearer ' + getCloudflareIngestToken_()
        }
      }
    );
  } catch (err) {
    savePendingMembershipEvents_(events);
    logError_(
      module,
      startTime,
      'Membership push threw before HTTP response (network/config issue): ' +
        err.message + '. Kept pending for next run (' + events.length + ' events).'
    );
    return;
  }

  var code = response.getResponseCode();
  var text = response.getContentText();
  var parsed = parseJsonSafe_(text, null);

  if (code < 200 || code >= 300 || !parsed || parsed.ok === false) {
    savePendingMembershipEvents_(events);
    logError_(
      module,
      startTime,
      'Membership push HTTP failure. HTTP=' + code + ', Body=' + text +
        '. Kept pending for next run (' + events.length + ' events).'
    );
    return;
  }

  // Default to "keep everything pending" unless we can positively confirm
  // per-row success from a well-formed results[] array. Safer to retry an
  // already-applied idempotent event than to silently drop a failed one.
  var stillPending = events;

  if (Array.isArray(parsed.results)) {
    stillPending = [];
    for (var r = 0; r < parsed.results.length; r++) {
      var rowResult = parsed.results[r];
      if (rowResult && rowResult.ok === false) {
        for (var e = 0; e < events.length; e++) {
          if (events[e].ticker === rowResult.ticker && events[e].action === rowResult.action) {
            stillPending.push(events[e]);
            break;
          }
        }
      }
    }
  }

  savePendingMembershipEvents_(stillPending);

  logInfo_(
    module,
    startTime,
    'Membership diff pushed to Cloudflare. Sent=' + events.length +
      ', Applied=' + Number(parsed.applied || 0) +
      ', Skipped=' + Number(parsed.skipped || 0) +
      ', Failed=' + Number(parsed.failed || 0) +
      (stillPending.length > 0 ? ' (StillPendingRetry=' + stillPending.length + ')' : '')
  );
}

function loadPendingMembershipEvents_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PENDING_MEMBERSHIP_EVENTS_PROP_KEY);
  if (!raw) return [];

  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function savePendingMembershipEvents_(events) {
  var props = PropertiesService.getScriptProperties();

  if (!events || events.length === 0) {
    props.deleteProperty(PENDING_MEMBERSHIP_EVENTS_PROP_KEY);
  } else {
    props.setProperty(PENDING_MEMBERSHIP_EVENTS_PROP_KEY, JSON.stringify(events));
  }
}

/**
 * Manual inspection helper. Run this from the Apps Script editor if you
 * ever suspect membership events are stuck (e.g. after the circuit breaker
 * fires, or after repeated push failures).
 */
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

/**
 * Manual escape hatch. Only call this after you've reviewed
 * inspectPendingMembershipEvents() output and either handled the events
 * manually (e.g. via direct SQL, like we did for CAG/HONA) or confirmed
 * they're stale/no-longer-relevant.
 */
function clearPendingMembershipEvents() {
  savePendingMembershipEvents_([]);
  Logger.log('Pending membership events cleared.');
}