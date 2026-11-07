/**
 * 00_Config.gs
 * Global configuration for Breadth Backend.
 * Apps Script has one global namespace across files; keep names unique.
 */

const SYS_CONFIG = {
  SHEETS: {
    DB: 'daily_OHLCV_CACHE',
    BUFFER: 'SYS_TEMP_BUFFER',
    LOGS: 'SYS_LOGS',
    SYNC_INDEX: 'SYS_SYNC_INDEX',
    AUDIT_MISSING: 'AUDIT_MISSING_OHLCV'
  },

  SOURCES: {
    SP500_PRIMARY: 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv',
    SP500_BACKUP: 'https://datahub.io/core/s-and-p-500-companies/r/constituents.csv'
  },

  DAILY_SYNC: {
    STATE_KEY: 'QE_DAILY_SYNC_STATE_V3',
    BATCH_SIZE: 40,
    MAX_RUNTIME_MS: 4.5 * 60 * 1000,
    WORKER_EVERY_MINUTES: 5,
    PRODUCTION_START_HOUR: 11,
    LOG_MODULE: 'DAILY_OHLCV_SYNC'
  },

  GOOGLE_FINANCE: {
    BASE_SLEEP_MS: 3000,
    POLL_INTERVAL_MS: 1000,
    MAX_WAIT_MS: 12000,
    LOOKBACK_DAYS_FOR_LATEST_BAR: 10
  },

  TICKER_SYNC: {
    MIN_EXPECTED_COUNT: 490,
    LOG_MODULE: 'TICKER_SYNC'
  },

  CLOUDFLARE: {
    BASE_URL: "https://breadth-db-api.kamarski.workers.dev",
    BATCH_SIZE: 100,
    LOG_MODULE: "CF_SYNC"
  },
};

const LEGACY_WORKER_STATE_KEYS = {
  MISSING_BACKFILL: 'QE_MISSING_BACKFILL_STATE_V3',
  RANGE_BACKFILL: 'QE_BACKFILL_RANGE_STATE_V1',
  OHLCV_INCIDENT_RECOVERY: 'QE_OHLCV_INCIDENT_RECOVERY_NOV2026_V1'
};

const OHLCV_HEADER = ['Ticker', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume'];
const SYNC_INDEX_HEADER = ['Ticker', 'LastSyncedDate'];
const LOG_HEADER = ['Timestamp', 'Module', 'Level', 'Execution_Time', 'Message'];
