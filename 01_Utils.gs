/**
 * 01_Utils.gs
 * Small pure helpers. No sheet I/O here except where explicitly named.
 */

function nowIso_() {
  return new Date().toISOString();
}

function getElapsedSeconds_(startTimeMs) {
  return ((Date.now() - startTimeMs) / 1000).toFixed(2) + 's';
}

function getTz_() {
  return Session.getScriptTimeZone();
}

function normalizeTicker_(ticker) {
  return String(ticker || '').trim().toUpperCase();
}

function normalizeDateKey_(dateValue) {
  if (!dateValue) return '';
  if (dateValue instanceof Date) {
    return Utilities.formatDate(dateValue, getTz_(), 'yyyy-MM-dd');
  }

  var text = String(dateValue).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  var parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, getTz_(), 'yyyy-MM-dd');
  }

  return text;
}

function dateKeyToDate_(dateKey) {
  var parts = String(dateKey).split('-');
  if (parts.length !== 3) throw new Error('Invalid dateKey: ' + dateKey);
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function addDays_(date, days) {
  var d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getYesterdayLocal_() {
  return addDays_(new Date(), -1);
}

function toJsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseJsonSafe_(text, fallbackValue) {
  if (!text) return fallbackValue;
  try {
    return JSON.parse(text);
  } catch (e) {
    return fallbackValue;
  }
}

function uniqueSorted_(values) {
  var map = {};
  values.forEach(function(v) {
    var key = String(v || '').trim();
    if (key) map[key] = true;
  });
  return Object.keys(map).sort();
}

function minDateKey_(dateKeys) {
  return dateKeys.slice().sort()[0];
}

function maxDateKey_(dateKeys) {
  var sorted = dateKeys.slice().sort();
  return sorted[sorted.length - 1];
}

function convertTickerForGoogleFinance_(ticker) {
  var value = normalizeTicker_(ticker);
  if (value === 'BRK-B') return 'BRK.B';
  if (value === 'BF-B') return 'BF.B';
  return value;
}
