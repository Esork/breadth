/**
 * 07_SyncIndex.gs
 * Single ticker registry + last synced daily bar per ticker.
 *
 * SYS_SYNC_INDEX is now the source of truth.
 * SYS_TICKERS is deprecated and should not be required anymore.
 */

function getRegistrySheet_(ss) {
  var sheet = ss.getSheetByName(SYS_CONFIG.REGISTRY_SHEET || 'SYS_SYNC_INDEX');

  if (!sheet) {
    sheet = ss.insertSheet(SYS_CONFIG.REGISTRY_SHEET || 'SYS_SYNC_INDEX');
  }

  ensureRegistryHeader_(sheet);
  return sheet;
}

function ensureRegistryHeader_(sheet) {
  var header = [
    'Ticker',
    'LastSyncedDate',
    'Name',
    'Sector',
    'Industry',
    'SubIndustry',
    'SectorETF',
    'IsCurrentSP500',
    'IsActive',
    'DateAdded',
    'DateRemoved',
    'UpdatedAt',
    'Source'
  ];

  var existing = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), header.length)).getValues()[0]
    : [];

  var needsHeader = sheet.getLastRow() === 0 || String(existing[0] || '').trim() !== 'Ticker';

  if (needsHeader) {
    sheet.clear();
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
    return;
  }

  // If old SYS_SYNC_INDEX only had Ticker / LastSyncedDate, expand header safely.
  for (var i = 0; i < header.length; i++) {
    if (String(existing[i] || '').trim() !== header[i]) {
      sheet.getRange(1, i + 1).setValue(header[i]);
    }
  }

  sheet.setFrozenRows(1);
}

function loadRegistryMap_(registrySheet) {
  ensureRegistryHeader_(registrySheet);

  var map = {};
  var lastRow = registrySheet.getLastRow();
  if (lastRow < 2) return map;

  var data = registrySheet
    .getRange(2, 1, lastRow - 1, 13)
    .getValues();

  for (var i = 0; i < data.length; i++) {
    var ticker = normalizeTicker_(data[i][0]);
    if (!ticker) continue;

    map[ticker] = {
      ticker: ticker,
      lastSyncedDate: normalizeDateKey_(data[i][1]),
      name: String(data[i][2] || '').trim(),
      sector: String(data[i][3] || '').trim(),
      industry: String(data[i][4] || '').trim(),
      subIndustry: String(data[i][5] || '').trim(),
      sectorEtf: String(data[i][6] || '').trim(),
      isCurrentSP500: normalizeBoolean_(data[i][7], true),
      isActive: normalizeBoolean_(data[i][8], true),
      dateAdded: normalizeDateKey_(data[i][9]),
      dateRemoved: normalizeDateKey_(data[i][10]),
      updatedAt: data[i][11],
      source: String(data[i][12] || '').trim()
    };
  }

  return map;
}

function saveRegistryMap_(registrySheet, registryMap) {
  ensureRegistryHeader_(registrySheet);

  var tickers = Object.keys(registryMap).sort();
  var rows = [];

  for (var i = 0; i < tickers.length; i++) {
    var item = registryMap[tickers[i]];

    rows.push([
      item.ticker,
      item.lastSyncedDate || '',
      item.name || '',
      item.sector || '',
      item.industry || '',
      item.subIndustry || '',
      item.sectorEtf || '',
      item.isCurrentSP500 === false ? false : true,
      item.isActive === false ? false : true,
      item.dateAdded || '',
      item.dateRemoved || '',
      item.updatedAt || new Date(),
      item.source || ''
    ]);
  }

  registrySheet.clear();
  registrySheet.getRange(1, 1, 1, REGISTRY_HEADER_().length).setValues([REGISTRY_HEADER_()]);
  registrySheet.setFrozenRows(1);

  if (rows.length > 0) {
    registrySheet.getRange(2, 1, rows.length, 13).setValues(rows);
  }
}

function REGISTRY_HEADER_() {
  return [
    'Ticker',
    'LastSyncedDate',
    'Name',
    'Sector',
    'Industry',
    'SubIndustry',
    'SectorETF',
    'IsCurrentSP500',
    'IsActive',
    'DateAdded',
    'DateRemoved',
    'UpdatedAt',
    'Source'
  ];
}

function normalizeBoolean_(value, defaultValue) {
  if (value === true) return true;
  if (value === false) return false;

  var text = String(value || '').trim().toUpperCase();

  if (text === 'TRUE' || text === 'YES' || text === '1') return true;
  if (text === 'FALSE' || text === 'NO' || text === '0') return false;

  return defaultValue;
}

function loadSyncIndexMap_(indexSheet) {
  var registryMap = loadRegistryMap_(indexSheet);
  var syncMap = {};

  var tickers = Object.keys(registryMap);
  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    syncMap[ticker] = registryMap[ticker].lastSyncedDate || '';
  }

  return syncMap;
}

function saveSyncIndexMap_(indexSheet, tickers, syncMap) {
  var registryMap = loadRegistryMap_(indexSheet);
  var now = new Date();

  for (var i = 0; i < tickers.length; i++) {
    var ticker = normalizeTicker_(tickers[i]);
    if (!ticker) continue;

    if (!registryMap[ticker]) {
      registryMap[ticker] = {
        ticker: ticker,
        isCurrentSP500: true,
        isActive: true,
        dateAdded: Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
        source: 'sync-index'
      };
    }

    registryMap[ticker].lastSyncedDate = syncMap[ticker] || registryMap[ticker].lastSyncedDate || '';
    registryMap[ticker].updatedAt = now;
  }

  saveRegistryMap_(indexSheet, registryMap);
}

function readEligibleTickerListFromRegistry_(registrySheet) {
  var registryMap = loadRegistryMap_(registrySheet);
  var tickers = Object.keys(registryMap).sort();
  var eligible = [];

  for (var i = 0; i < tickers.length; i++) {
    var item = registryMap[tickers[i]];

    if (item.isCurrentSP500 === true && item.isActive === true) {
      eligible.push(item.ticker);
    }
  }

  return eligible;
}

function isDateAlreadySynced_(lastSyncedDateKey, newDateKey) {
  if (!lastSyncedDateKey) return false;
  return String(lastSyncedDateKey) >= String(newDateKey);
}

/**
 * Heavy maintenance function. Run manually only after a major DB repair.
 * It scans DB_OHLCV once and rebuilds LastSyncedDate in SYS_SYNC_INDEX.
 */
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

var SP500_MEMBERSHIP_EVENTS = [
  {
    effectiveDate: '2026-06-22',
    add: ['MRVL', 'FLEX'],
    remove: ['POOL', 'CPB'],
    source: 'S&P Global 2026-06-05 rebalance'
  }
];

function getSp500MembershipEvents_() {
  return SP500_MEMBERSHIP_EVENTS || [];
}

/**
 * Returns the correct S&P 500 universe for a specific OHLCV date.
 *
 * Logic:
 * - Start from current SYS_SYNC_INDEX eligible universe.
 * - If an event effective date is AFTER target date, rewind that event:
 *   - remove future additions
 *   - restore future removals
 */
function readEligibleTickerListForOhlcvDate_(registrySheet, dateKey) {
  var targetDateKey = normalizeDateKey_(dateKey);
  if (!targetDateKey) {
    return readEligibleTickerListFromRegistry_(registrySheet);
  }

  var current = readEligibleTickerListFromRegistry_(registrySheet);
  var map = {};

  current.forEach(function(ticker) {
    ticker = normalizeTicker_(ticker);
    if (ticker) map[ticker] = true;
  });

  var events = getSp500MembershipEvents_();

  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    var effectiveDateKey = normalizeDateKey_(event.effectiveDate);

    if (!effectiveDateKey) continue;

    /**
     * If target OHLCV date is before the event effective date,
     * undo the event.
     */
    if (targetDateKey < effectiveDateKey) {
      (event.add || []).forEach(function(ticker) {
        ticker = normalizeTicker_(ticker);
        if (ticker) delete map[ticker];
      });

      (event.remove || []).forEach(function(ticker) {
        ticker = normalizeTicker_(ticker);
        if (ticker) map[ticker] = true;
      });
    }
  }

  return Object.keys(map).sort();
}

/**
 * Daily sync candidate list.
 *
 * This intentionally includes both current tickers and known transition tickers.
 * Later, after GOOGLEFINANCE tells us the actual OHLCV date, we filter each ticker
 * through readEligibleTickerListForOhlcvDate_().
 */
function readDailySyncCandidateTickerList_(registrySheet) {
  var map = {};

  readEligibleTickerListFromRegistry_(registrySheet).forEach(function(ticker) {
    ticker = normalizeTicker_(ticker);
    if (ticker) map[ticker] = true;
  });

  getSp500MembershipEvents_().forEach(function(event) {
    (event.add || []).forEach(function(ticker) {
      ticker = normalizeTicker_(ticker);
      if (ticker) map[ticker] = true;
    });

    (event.remove || []).forEach(function(ticker) {
      ticker = normalizeTicker_(ticker);
      if (ticker) map[ticker] = true;
    });
  });

  return Object.keys(map).sort();
}

function inspectDateAwareUniverseTest() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var registrySheet = getRegistrySheet_(ss);

  var dates = ['2026-06-18', '2026-06-22'];
  var output = {
    currentEligibleCount: readEligibleTickerListFromRegistry_(registrySheet).length,
    dailySyncCandidateCount: readDailySyncCandidateTickerList_(registrySheet).length,
    byDate: {}
  };

  dates.forEach(function(dateKey) {
    var list = readEligibleTickerListForOhlcvDate_(registrySheet, dateKey);
    var map = {};

    list.forEach(function(ticker) {
      map[ticker] = true;
    });

    output.byDate[dateKey] = {
      count: list.length,
      hasCPB: !!map.CPB,
      hasPOOL: !!map.POOL,
      hasMRVL: !!map.MRVL,
      hasFLEX: !!map.FLEX
    };
  });

  Logger.log(JSON.stringify(output, null, 2));
}