/**
 * 06_TickerSync.gs
 *
 * Sync S&P 500 ticker registry into SYS_SYNC_INDEX.
 * SYS_TICKERS is deprecated.
 */

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
        Object.keys(registryMap).length
    );

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