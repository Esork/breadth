const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const INDEX_CODE = "SP500";

const LEGACY_OHLCV_TABLE = "ohlcv_daily";
const DUAL_WRITE_LEGACY_OHLCV = true;

const OHLCV_BUCKETS = [
  {
    table: "ohlcv_daily_2024_2027",
    start: "2024-01-01",
    end: "2028-01-01"
  }
];

const TICKER_INDICATORS_TABLE = "ticker_indicators_daily_2024_2027";
const MARKET_BREADTH_TABLE = "market_breadth_daily";
const SECTOR_BREADTH_TABLE = "sector_breadth_daily";

const DEFAULT_DERIVE_RANGE_LIMIT = 5;
const MAX_DERIVE_RANGE_LIMIT = 10;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (requiresWriteAuth(path)) {
      const authHeader = request.headers.get("Authorization");

      if (!env.INGEST_TOKEN || authHeader !== `Bearer ${env.INGEST_TOKEN}`) {
        return json(
          { ok: false, error: "Unauthorized" },
          CORS_HEADERS,
          401
        );
      }
    }

    try {
      if (path === "/health" && request.method === "GET") {
        return json({
          ok: true,
          service: "breadth-db-api",
          mode: "bucket-aware-read-api-v8",
          time: new Date().toISOString(),
          ohlcv_buckets: OHLCV_BUCKETS.map((bucket) => ({
            table: bucket.table,
            start: bucket.start,
            end: bucket.end
          })),
          legacy_dual_write: DUAL_WRITE_LEGACY_OHLCV,
          derived_tables: {
            ticker_indicators: TICKER_INDICATORS_TABLE,
            market_breadth: MARKET_BREADTH_TABLE,
            sector_breadth: SECTOR_BREADTH_TABLE
          }
        }, CORS_HEADERS);
      }

      if ((path === "/tickers" || path === "/api/tickers") && request.method === "GET") {
        return handleGetTickers(env);
      }

      if ((path === "/ohlcv" || path === "/api/ohlcv") && request.method === "GET") {
        return handleGetOhlcv(url, env);
      }

      if ((path === "/latest" || path === "/api/latest") && request.method === "GET") {
        return handleGetLatest(env);
      }

      if ((path === "/latest-summary" || path === "/api/latest-summary") && request.method === "GET") {
        return handleGetLatestSummary(env);
      }

      if ((path === "/api/universe" || path === "/universe") && request.method === "GET") {
        return handleGetUniverse(url, env);
      }

      if (path === "/api/quality/check" && request.method === "GET") {
        return handleReadOnlyQualityCheck(url, env);
      }

      if (path === "/api/data-quality/latest" && request.method === "GET") {
        return handleGetLatestStoredQuality(env);
      }

      if (path === "/api/data-quality" && request.method === "GET") {
        return handleGetStoredQualityByDate(url, env);
      }

      if (path === "/api/dashboard/latest" && request.method === "GET") {
        return handleGetDashboardLatest(env);
      }

      if (path === "/api/dashboard" && request.method === "GET") {
        return handleGetDashboardByDate(url, env);
      }

      if (path === "/api/market/history" && request.method === "GET") {
        return handleGetMarketHistory(url, env);
      }

      if (path === "/api/sectors/history" && request.method === "GET") {
        return handleGetSectorsHistory(url, env);
      }

      if (path === "/api/calculation-runs/latest" && request.method === "GET") {
        return handleGetLatestCalculationRuns(url, env);
      }

      if (path === "/api/market/latest" && request.method === "GET") {
        return handleGetMarketLatest(env);
      }

      if (path === "/api/market" && request.method === "GET") {
        return handleGetMarketByDate(url, env);
      }

      if (path === "/api/sectors/latest" && request.method === "GET") {
        return handleGetSectorsLatest(env);
      }

      if (path === "/api/sectors" && request.method === "GET") {
        return handleGetSectorsByDate(url, env);
      }

      if (path === "/api/tickers/indicators" && request.method === "GET") {
        return handleGetTickerIndicators(url, env);
      }

      if (path.startsWith("/api/ticker/") && request.method === "GET") {
        return handleGetTickerIndicatorByPath(path, url, env);
      }

      if (path === "/jobs/check-quality/date" && request.method === "POST") {
        return handleCheckQualityDateJob(url, env);
      }

      if (path === "/jobs/derive/date" && request.method === "POST") {
        return handleDeriveDateJob(url, env);
      }

      if (path === "/jobs/derive/range" && request.method === "POST") {
        return handleDeriveRangeJob(url, env);
      }

      if (path === "/ingest/tickers" && request.method === "POST") {
        return handleIngestTickers(request, env);
      }

      if (path === "/ingest/ohlcv" && request.method === "POST") {
        return handleIngestOhlcv(request, env);
      }
      if (path === "/ingest/membership" && request.method === "POST") {
        return handleIngestMembershipEvents(request, env);
      }
      return json({
        ok: false,
        error: "Not found",
        path
      }, CORS_HEADERS, 404);

    } catch (err) {
      return json({
        ok: false,
        error: String(err && err.message ? err.message : err)
      }, CORS_HEADERS, 500);
    }
  }
};

function requiresWriteAuth(path) {
  return (
    path.startsWith("/ingest/") ||
    path.startsWith("/jobs/")
  );
}

/* -----------------------------
 * Read routes
 * ----------------------------- */

async function handleGetTickers(env) {
  const result = await env.DB.prepare(
    `SELECT ticker, name, sector, industry, sub_industry, sector_etf,
            is_current_sp500, is_active, date_added, date_removed,
            source, updated_at
     FROM tickers
     ORDER BY ticker`
  ).all();

  return json({
    ok: true,
    count: result.results.length,
    data: result.results
  }, CORS_HEADERS);
}

async function handleGetOhlcv(url, env) {
  const ticker = normalizeTicker(url.searchParams.get("ticker"));

  if (!ticker) {
    return json({ ok: false, error: "Missing ticker" }, CORS_HEADERS, 400);
  }

  const limit = clampInteger(url.searchParams.get("limit"), 120, 1, 1000);
  const from = normalizeDate(url.searchParams.get("from"));
  const to = normalizeDate(url.searchParams.get("to"));

  const table = getCurrentOhlcvReadTable();

  const where = ["ticker = ?"];
  const params = [ticker];

  if (from) {
    where.push("date >= ?");
    params.push(from);
  }

  if (to) {
    where.push("date <= ?");
    params.push(to);
  }

  params.push(limit);

  const result = await env.DB.prepare(
    `SELECT ticker, date, open, high, low, close, volume, source, ingested_at
     FROM ${table}
     WHERE ${where.join(" AND ")}
     ORDER BY date DESC
     LIMIT ?`
  ).bind(...params).all();

  return json({
    ok: true,
    source_table: table,
    ticker,
    count: result.results.length,
    data: result.results
  }, CORS_HEADERS);
}

async function handleGetLatest(env) {
  const table = getCurrentOhlcvReadTable();

  const result = await env.DB.prepare(
    `SELECT d.*
     FROM ${table} d
     JOIN (
       SELECT ticker, MAX(date) AS max_date
       FROM ${table}
       GROUP BY ticker
     ) x
     ON d.ticker = x.ticker AND d.date = x.max_date
     ORDER BY d.ticker`
  ).all();

  return json({
    ok: true,
    source_table: table,
    count: result.results.length,
    data: result.results
  }, CORS_HEADERS);
}

async function handleGetLatestSummary(env) {
  const table = getCurrentOhlcvReadTable();

  const result = await env.DB.prepare(
    `SELECT date, COUNT(*) AS raw_rows, COUNT(DISTINCT ticker) AS unique_tickers
     FROM ${table}
     GROUP BY date
     ORDER BY date DESC
     LIMIT 10`
  ).all();

  return json({
    ok: true,
    source_table: table,
    count: result.results.length,
    data: result.results
  }, CORS_HEADERS);
}

async function handleGetUniverse(url, env) {
  const date = normalizeDate(url.searchParams.get("date"));

  if (!date) {
    return json({ ok: false, error: "Missing or invalid date" }, CORS_HEADERS, 400);
  }

  const universe = await getUniverseForDate(env, INDEX_CODE, date);

  return json({
    ok: true,
    index_code: INDEX_CODE,
    date,
    count: universe.length,
    data: universe
  }, CORS_HEADERS);
}

async function handleReadOnlyQualityCheck(url, env) {
  const date = await resolveQualityDate(url, env);

  if (!date) {
    return json({ ok: false, error: "Missing date and could not resolve latest date" }, CORS_HEADERS, 400);
  }

  const quality = await computeOhlcvQuality(env, INDEX_CODE, date);

  return json({
    ok: true,
    write: false,
    quality
  }, CORS_HEADERS);
}

async function handleGetLatestStoredQuality(env) {
  const result = await env.DB.prepare(
    `SELECT *
     FROM ohlcv_quality_daily
     WHERE index_code = ?
     ORDER BY date DESC
     LIMIT 1`
  ).bind(INDEX_CODE).all();

  return json({
    ok: true,
    count: result.results.length,
    data: result.results[0] || null
  }, CORS_HEADERS);
}

async function handleGetStoredQualityByDate(url, env) {
  const date = normalizeDate(url.searchParams.get("date"));

  if (!date) {
    return json({ ok: false, error: "Missing or invalid date" }, CORS_HEADERS, 400);
  }

  const result = await env.DB.prepare(
    `SELECT *
     FROM ohlcv_quality_daily
     WHERE index_code = ?
       AND date = ?`
  ).bind(INDEX_CODE, date).all();

  return json({
    ok: true,
    count: result.results.length,
    data: result.results[0] || null
  }, CORS_HEADERS);
}



async function handleGetDashboardLatest(env) {
  const date = await getLatestDateFromTable(env, MARKET_BREADTH_TABLE);

  if (!date) {
    return json({
      ok: true,
      endpoint: "dashboard_latest",
      index_code: INDEX_CODE,
      date: null,
      data: {
        quality: null,
        market: null,
        sectors: [],
        calculation_runs: []
      }
    }, CORS_HEADERS);
  }

  return getDashboardResponse(env, date, "dashboard_latest");
}

async function handleGetDashboardByDate(url, env) {
  const date = await resolveDerivedDate(url, env, MARKET_BREADTH_TABLE);

  if (!date) {
    return json({ ok: false, error: "Missing date and could not resolve latest dashboard date" }, CORS_HEADERS, 400);
  }

  return getDashboardResponse(env, date, "dashboard");
}

async function getDashboardResponse(env, date, endpointName) {
  const marketResult = await env.DB.prepare(
    `SELECT *
     FROM ${MARKET_BREADTH_TABLE}
     WHERE index_code = ?
       AND date = ?
     LIMIT 1`
  ).bind(INDEX_CODE, date).all();

  const sectorsResult = await env.DB.prepare(
    `SELECT *
     FROM ${SECTOR_BREADTH_TABLE}
     WHERE index_code = ?
       AND date = ?
     ORDER BY rank_breadth ASC, sector ASC`
  ).bind(INDEX_CODE, date).all();

  const qualityResult = await env.DB.prepare(
    `SELECT *
     FROM ohlcv_quality_daily
     WHERE index_code = ?
       AND date = ?
     LIMIT 1`
  ).bind(INDEX_CODE, date).all();

  const runsResult = await env.DB.prepare(
    `SELECT
       run_id,
       job_type,
       target_date,
       target_start_date,
       target_end_date,
       bucket,
       status,
       started_at,
       finished_at,
       rows_read,
       rows_written,
       error,
       metadata_json
     FROM calculation_runs
     WHERE target_date = ?
     ORDER BY started_at DESC
     LIMIT 5`
  ).bind(date).all();

  return json({
    ok: true,
    endpoint: endpointName,
    index_code: INDEX_CODE,
    date,
    source_tables: {
      quality: "ohlcv_quality_daily",
      market: MARKET_BREADTH_TABLE,
      sectors: SECTOR_BREADTH_TABLE,
      calculation_runs: "calculation_runs"
    },
    data: {
      quality: qualityResult.results[0] || null,
      market: marketResult.results[0] || null,
      sectors: sectorsResult.results || [],
      calculation_runs: runsResult.results || []
    }
  }, CORS_HEADERS);
}

async function handleGetMarketHistory(url, env) {
  const options = await resolveHistoryOptions(url, env, MARKET_BREADTH_TABLE, 120, 1000);

  if (!options.ok) {
    return json(options, CORS_HEADERS, options.status_code || 400);
  }

  const where = ["index_code = ?", "date <= ?"];
  const params = [INDEX_CODE, options.to];

  if (options.from) {
    where.push("date >= ?");
    params.push(options.from);
  }

  params.push(options.limit);

  const result = await env.DB.prepare(
    `SELECT *
     FROM ${MARKET_BREADTH_TABLE}
     WHERE ${where.join(" AND ")}
     ORDER BY date DESC
     LIMIT ?`
  ).bind(...params).all();

  const data = (result.results || []).slice().reverse();

  return json({
    ok: true,
    endpoint: "market_history",
    source_table: MARKET_BREADTH_TABLE,
    index_code: INDEX_CODE,
    from: options.from,
    to: options.to,
    limit: options.limit,
    count: data.length,
    data
  }, CORS_HEADERS);
}

async function handleGetSectorsHistory(url, env) {
  const options = await resolveHistoryOptions(url, env, SECTOR_BREADTH_TABLE, 120, 1000);

  if (!options.ok) {
    return json(options, CORS_HEADERS, options.status_code || 400);
  }

  const dateWhere = ["index_code = ?", "date <= ?"];
  const dateParams = [INDEX_CODE, options.to];

  if (options.from) {
    dateWhere.push("date >= ?");
    dateParams.push(options.from);
  }

  const result = await env.DB.prepare(
    `WITH selected_dates AS (
       SELECT DISTINCT date
       FROM ${SECTOR_BREADTH_TABLE}
       WHERE ${dateWhere.join(" AND ")}
       ORDER BY date DESC
       LIMIT ?
     )
     SELECT s.*
     FROM ${SECTOR_BREADTH_TABLE} s
     JOIN selected_dates d
       ON d.date = s.date
     WHERE s.index_code = ?
     ORDER BY s.date ASC, s.rank_breadth ASC, s.sector ASC`
  ).bind(...dateParams, options.limit, INDEX_CODE).all();

  const data = result.results || [];
  const dates = [];
  const seen = new Set();

  for (const row of data) {
    const date = normalizeDate(row.date);
    if (date && !seen.has(date)) {
      seen.add(date);
      dates.push(date);
    }
  }

  return json({
    ok: true,
    endpoint: "sectors_history",
    source_table: SECTOR_BREADTH_TABLE,
    index_code: INDEX_CODE,
    from: options.from,
    to: options.to,
    limit_dates: options.limit,
    date_count: dates.length,
    row_count: data.length,
    dates,
    data
  }, CORS_HEADERS);
}

async function handleGetLatestCalculationRuns(url, env) {
  const limit = clampInteger(url.searchParams.get("limit"), 10, 1, 100);
  const date = normalizeDate(url.searchParams.get("date"));

  const where = [];
  const params = [];

  if (date) {
    where.push("target_date = ?");
    params.push(date);
  }

  params.push(limit);

  const result = await env.DB.prepare(
    `SELECT
       run_id,
       job_type,
       target_date,
       target_start_date,
       target_end_date,
       bucket,
       status,
       started_at,
       finished_at,
       rows_read,
       rows_written,
       error,
       metadata_json
     FROM calculation_runs
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY started_at DESC
     LIMIT ?`
  ).bind(...params).all();

  return json({
    ok: true,
    endpoint: "calculation_runs_latest",
    source_table: "calculation_runs",
    date: date || null,
    limit,
    count: result.results.length,
    data: result.results
  }, CORS_HEADERS);
}

async function resolveHistoryOptions(url, env, table, defaultLimit, maxLimit) {
  assertAllowedDerivedTable(table);

  const from = normalizeDate(url.searchParams.get("from"));
  const rawTo = String(url.searchParams.get("to") || "").trim();
  const to = !rawTo || rawTo.toLowerCase() === "latest"
    ? await getLatestDateFromTable(env, table)
    : normalizeDate(rawTo);

  if (!to) {
    return {
      ok: false,
      status_code: 400,
      error: "Missing or invalid to date, and latest date could not be resolved"
    };
  }

  if (from && from > to) {
    return {
      ok: false,
      status_code: 400,
      error: "Invalid range: from date is after to date",
      from,
      to
    };
  }

  return {
    ok: true,
    from: from || null,
    to,
    limit: clampInteger(url.searchParams.get("limit"), defaultLimit, 1, maxLimit)
  };
}

async function handleGetMarketLatest(env) {
  const date = await getLatestDateFromTable(env, MARKET_BREADTH_TABLE);

  if (!date) {
    return json({
      ok: true,
      source_table: MARKET_BREADTH_TABLE,
      index_code: INDEX_CODE,
      date: null,
      count: 0,
      data: null
    }, CORS_HEADERS);
  }

  return getMarketBreadthResponse(env, date);
}

async function handleGetMarketByDate(url, env) {
  const date = await resolveDerivedDate(url, env, MARKET_BREADTH_TABLE);

  if (!date) {
    return json({ ok: false, error: "Missing date and could not resolve latest market breadth date" }, CORS_HEADERS, 400);
  }

  return getMarketBreadthResponse(env, date);
}

async function getMarketBreadthResponse(env, date) {
  const result = await env.DB.prepare(
    `SELECT *
     FROM ${MARKET_BREADTH_TABLE}
     WHERE index_code = ?
       AND date = ?
     LIMIT 1`
  ).bind(INDEX_CODE, date).all();

  return json({
    ok: true,
    source_table: MARKET_BREADTH_TABLE,
    index_code: INDEX_CODE,
    date,
    count: result.results.length,
    data: result.results[0] || null
  }, CORS_HEADERS);
}

async function handleGetSectorsLatest(env) {
  const date = await getLatestDateFromTable(env, SECTOR_BREADTH_TABLE);

  if (!date) {
    return json({
      ok: true,
      source_table: SECTOR_BREADTH_TABLE,
      index_code: INDEX_CODE,
      date: null,
      count: 0,
      data: []
    }, CORS_HEADERS);
  }

  return getSectorsBreadthResponse(env, date);
}

async function handleGetSectorsByDate(url, env) {
  const date = await resolveDerivedDate(url, env, SECTOR_BREADTH_TABLE);

  if (!date) {
    return json({ ok: false, error: "Missing date and could not resolve latest sector breadth date" }, CORS_HEADERS, 400);
  }

  return getSectorsBreadthResponse(env, date);
}

async function getSectorsBreadthResponse(env, date) {
  const result = await env.DB.prepare(
    `SELECT *
     FROM ${SECTOR_BREADTH_TABLE}
     WHERE index_code = ?
       AND date = ?
     ORDER BY rank_breadth ASC, sector ASC`
  ).bind(INDEX_CODE, date).all();

  return json({
    ok: true,
    source_table: SECTOR_BREADTH_TABLE,
    index_code: INDEX_CODE,
    date,
    count: result.results.length,
    data: result.results
  }, CORS_HEADERS);
}

async function handleGetTickerIndicators(url, env) {
  const date = await resolveDerivedDate(url, env, TICKER_INDICATORS_TABLE);

  if (!date) {
    return json({ ok: false, error: "Missing date and could not resolve latest ticker indicators date" }, CORS_HEADERS, 400);
  }

  const limit = clampInteger(url.searchParams.get("limit"), 600, 1, 1000);
  const sector = safeText(url.searchParams.get("sector"));
  const sortClause = getTickerIndicatorSortClause(url);

  const where = ["index_code = ?", "date = ?"];
  const params = [INDEX_CODE, date];

  if (sector) {
    where.push("sector = ?");
    params.push(sector);
  }

  params.push(limit);

  const result = await env.DB.prepare(
    `SELECT *
     FROM ${TICKER_INDICATORS_TABLE}
     WHERE ${where.join(" AND ")}
     ORDER BY ${sortClause}
     LIMIT ?`
  ).bind(...params).all();

  return json({
    ok: true,
    source_table: TICKER_INDICATORS_TABLE,
    index_code: INDEX_CODE,
    date,
    count: result.results.length,
    limit,
    sector: sector || null,
    data: result.results
  }, CORS_HEADERS);
}

async function handleGetTickerIndicatorByPath(path, url, env) {
  const parts = path.split("/").filter(Boolean);
  const ticker = normalizeTicker(decodeURIComponent(parts[2] || ""));

  if (!ticker) {
    return json({ ok: false, error: "Missing ticker" }, CORS_HEADERS, 400);
  }

  const date = await resolveDerivedDate(url, env, TICKER_INDICATORS_TABLE);

  if (!date) {
    return json({ ok: false, error: "Missing date and could not resolve latest ticker indicators date" }, CORS_HEADERS, 400);
  }

  const result = await env.DB.prepare(
    `SELECT *
     FROM ${TICKER_INDICATORS_TABLE}
     WHERE index_code = ?
       AND date = ?
       AND ticker = ?
     LIMIT 1`
  ).bind(INDEX_CODE, date, ticker).all();

  return json({
    ok: true,
    source_table: TICKER_INDICATORS_TABLE,
    index_code: INDEX_CODE,
    date,
    ticker,
    count: result.results.length,
    data: result.results[0] || null
  }, CORS_HEADERS);
}

function getTickerIndicatorSortClause(url) {
  const requestedSort = String(url.searchParams.get("sort") || "ticker").trim().toLowerCase();
  const requestedDir = String(url.searchParams.get("dir") || "asc").trim().toLowerCase();

  const allowedSorts = {
    ticker: "ticker",
    sector: "sector",
    close: "close",
    volume: "volume",
    dollar_volume: "dollar_volume",
    return_1d: "return_1d",
    return_5d: "return_5d",
    return_20d: "return_20d",
    return_63d: "return_63d",
    above_sma20: "above_sma20",
    above_sma50: "above_sma50",
    above_sma200: "above_sma200",
    distance_sma20_pct: "distance_sma20_pct",
    distance_sma50_pct: "distance_sma50_pct",
    distance_sma200_pct: "distance_sma200_pct",
    volume_ratio_20d: "volume_ratio_20d",
    new_20d_high: "new_20d_high",
    new_20d_low: "new_20d_low",
    new_252d_high: "new_252d_high",
    new_252d_low: "new_252d_low"
  };

  const sortColumn = allowedSorts[requestedSort] || "ticker";
  const direction = requestedDir === "desc" ? "DESC" : "ASC";

  if (sortColumn === "ticker") {
    return `ticker ${direction}`;
  }

  if (sortColumn === "sector") {
    return `sector ${direction}, ticker ASC`;
  }

  return `${sortColumn} IS NULL ASC, ${sortColumn} ${direction}, ticker ASC`;
}

/* -----------------------------
 * Jobs
 * ----------------------------- */

async function handleCheckQualityDateJob(url, env) {
  const date = await resolveQualityDate(url, env);

  if (!date) {
    return json({ ok: false, error: "Missing date and could not resolve latest date" }, CORS_HEADERS, 400);
  }

  const result = await computeAndStoreOhlcvQuality(env, INDEX_CODE, date);

  return json(result, CORS_HEADERS, result.ok ? 200 : 500);
}

async function handleDeriveDateJob(url, env) {
  const date = await resolveQualityDate(url, env);

  if (!date) {
    return json({ ok: false, error: "Missing date and could not resolve latest raw OHLCV date" }, CORS_HEADERS, 400);
  }

  const allowFailQuality = String(url.searchParams.get("allowFailQuality") || "")
    .trim()
    .toLowerCase() === "true";

  const result = await computeAndStoreDerivedDate(env, INDEX_CODE, date, {
    requireQualityOk: !allowFailQuality
  });

  return json(result, CORS_HEADERS, result.status_code || (result.ok ? 200 : 500));
}

async function handleDeriveRangeJob(url, env) {
  const allowFailQuality = String(url.searchParams.get("allowFailQuality") || "")
    .trim()
    .toLowerCase() === "true";

  const stopOnFail = String(url.searchParams.get("stopOnFail") || "")
    .trim()
    .toLowerCase() === "true";

  const limit = clampInteger(
    url.searchParams.get("limit"),
    DEFAULT_DERIVE_RANGE_LIMIT,
    1,
    MAX_DERIVE_RANGE_LIMIT
  );

  const range = await resolveDeriveRange(url, env, limit);

  if (!range.ok) {
    return json(range, CORS_HEADERS, range.status_code || 400);
  }

  if (range.dates.length === 0) {
    return json({
      ok: false,
      error: "No raw OHLCV dates found for requested range",
      from: range.from,
      to: range.to,
      limit
    }, CORS_HEADERS, 404);
  }

  const startedAt = new Date().toISOString();
  const results = [];

  let successCount = 0;
  let failureCount = 0;
  let rowsWritten = 0;

  for (const date of range.dates) {
    const result = await computeAndStoreDerivedDate(env, INDEX_CODE, date, {
      requireQualityOk: !allowFailQuality
    });

    if (result.ok) {
      successCount++;
      rowsWritten += Number(result.rows_written || 0);
    } else {
      failureCount++;
    }

    results.push({
      date,
      ok: Boolean(result.ok),
      status_code: result.status_code || (result.ok ? 200 : 500),
      quality_status: result.quality ? result.quality.status : null,
      rows_written: Number(result.rows_written || 0),
      derived: result.derived || null,
      error: result.error || null,
      missing_samples: result.quality ? result.quality.missing_samples : undefined,
      extra_samples: result.quality ? result.quality.extra_samples : undefined
    });

    if (!result.ok && stopOnFail) {
      break;
    }
  }

  return json({
    ok: failureCount === 0,
    job_type: "DERIVE_DAILY_BREADTH_RANGE",
    from: range.from,
    to: range.to,
    requested_limit: limit,
    processed_count: results.length,
    success_count: successCount,
    failure_count: failureCount,
    rows_written: rowsWritten,
    allow_fail_quality: allowFailQuality,
    stop_on_fail: stopOnFail,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    dates: range.dates,
    results
  }, CORS_HEADERS, 200);
}

async function resolveDeriveRange(url, env, limit) {
  const from = normalizeDate(url.searchParams.get("from"));
  let to = String(url.searchParams.get("to") || "").trim();

  if (!to || to.toLowerCase() === "latest") {
    to = await getLatestRawOhlcvDate(env);
  } else {
    to = normalizeDate(to);
  }

  if (!to) {
    return {
      ok: false,
      status_code: 400,
      error: "Missing or invalid to date, and latest raw OHLCV date could not be resolved"
    };
  }

  if (from && from > to) {
    return {
      ok: false,
      status_code: 400,
      error: "Invalid range: from date is after to date",
      from,
      to
    };
  }

  const dates = await getRawOhlcvDatesInRange(env, {
    from,
    to,
    limit
  });

  return {
    ok: true,
    from: from || null,
    to,
    dates
  };
}

async function getRawOhlcvDatesInRange(env, options) {
  const table = getCurrentOhlcvReadTable();
  assertAllowedOhlcvTable(table);

  const where = ["date <= ?"];
  const params = [options.to];

  if (options.from) {
    where.push("date >= ?");
    params.push(options.from);
  }

  params.push(options.limit);

  const result = await env.DB.prepare(
    `SELECT DISTINCT date
     FROM ${table}
     WHERE ${where.join(" AND ")}
     ORDER BY date DESC
     LIMIT ?`
  ).bind(...params).all();

  return (result.results || []).map((row) => normalizeDate(row.date)).filter(Boolean);
}

async function getLatestRawOhlcvDate(env) {
  const table = getCurrentOhlcvReadTable();
  assertAllowedOhlcvTable(table);

  const result = await env.DB.prepare(
    `SELECT MAX(date) AS latest_date
     FROM ${table}`
  ).all();

  return normalizeDate(result.results[0] && result.results[0].latest_date);
}

async function computeAndStoreDerivedDate(env, indexCode, date, options = {}) {
  const requireQualityOk = options.requireQualityOk !== false;
  const runId = `derive:${indexCode}:${date}:${Date.now()}`;
  const startedAt = new Date().toISOString();
  const sourceTable = getCurrentOhlcvReadTable();

  await env.DB.prepare(
    `INSERT INTO calculation_runs (
      run_id, job_type, target_date, bucket, status, started_at, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    runId,
    "DERIVE_DAILY_BREADTH",
    date,
    sourceTable,
    "RUNNING",
    startedAt,
    JSON.stringify({
      index_code: indexCode,
      date,
      require_quality_ok: requireQualityOk,
      steps: ["quality", "clear_existing_derived", "ticker_indicators", "market_breadth", "sector_breadth"]
    })
  ).run();

  try {
    const quality = await computeOhlcvQuality(env, indexCode, date);
    await upsertOhlcvQuality(env, quality);

    if (requireQualityOk && quality.status !== "OK") {
      const message = `OHLCV quality is ${quality.status}; derived calculation stopped`;

      await env.DB.prepare(
        `UPDATE calculation_runs
         SET status = ?,
             finished_at = ?,
             rows_read = ?,
             rows_written = ?,
             error = ?,
             metadata_json = ?
         WHERE run_id = ?`
      ).bind(
        "FAILED",
        new Date().toISOString(),
        quality.raw_rows + quality.expected_count,
        1,
        message,
        JSON.stringify({
          quality,
          require_quality_ok: requireQualityOk
        }),
        runId
      ).run();

      return {
        ok: false,
        status_code: 409,
        run_id: runId,
        date,
        error: message,
        quality
      };
    }

    const cleared = await clearDerivedRowsForDate(env, indexCode, date);

    const tickerRows = await runTickerIndicatorsForDate(env, indexCode, date);
    const marketRows = await runMarketBreadthForDate(env, indexCode, date);
    const sectorRows = await runSectorBreadthForDate(env, indexCode, date);

    const rowsWritten = 1 + tickerRows + marketRows + sectorRows;

    const summary = {
      quality_status: quality.status,
      quality_expected_count: quality.expected_count,
      quality_raw_rows: quality.raw_rows,
      cleared_rows: cleared,
      ticker_indicator_rows: tickerRows,
      market_breadth_rows: marketRows,
      sector_breadth_rows: sectorRows
    };

    await env.DB.prepare(
      `UPDATE calculation_runs
       SET status = ?,
           finished_at = ?,
           rows_read = ?,
           rows_written = ?,
           metadata_json = ?
       WHERE run_id = ?`
    ).bind(
      "DONE",
      new Date().toISOString(),
      quality.raw_rows + quality.expected_count,
      rowsWritten,
      JSON.stringify(summary),
      runId
    ).run();

    return {
      ok: true,
      run_id: runId,
      date,
      quality,
      rows_written: rowsWritten,
      cleared_rows: cleared,
      derived: {
        ticker_indicators: tickerRows,
        market_breadth: marketRows,
        sector_breadth: sectorRows
      }
    };

  } catch (err) {
    const message = String(err && err.message ? err.message : err);

    await env.DB.prepare(
      `UPDATE calculation_runs
       SET status = ?,
           finished_at = ?,
           error = ?
       WHERE run_id = ?`
    ).bind(
      "FAILED",
      new Date().toISOString(),
      message,
      runId
    ).run();

    return {
      ok: false,
      run_id: runId,
      date,
      error: message
    };
  }
}

async function clearDerivedRowsForDate(env, indexCode, date) {
  const statements = [
    env.DB.prepare(
      `DELETE FROM ${TICKER_INDICATORS_TABLE}
       WHERE index_code = ?
         AND date = ?`
    ).bind(indexCode, date),
    env.DB.prepare(
      `DELETE FROM ${MARKET_BREADTH_TABLE}
       WHERE index_code = ?
         AND date = ?`
    ).bind(indexCode, date),
    env.DB.prepare(
      `DELETE FROM ${SECTOR_BREADTH_TABLE}
       WHERE index_code = ?
         AND date = ?`
    ).bind(indexCode, date)
  ];

  const results = await env.DB.batch(statements);
  let rowsDeleted = 0;

  for (const item of results || []) {
    if (item && item.meta && typeof item.meta.rows_written === "number") {
      rowsDeleted += item.meta.rows_written;
    }
  }

  return rowsDeleted;
}

function normalizeSectorSql(alias) {
  return `CASE
    WHEN ${alias}.sector IS NULL OR TRIM(${alias}.sector) = '' THEN NULL
    WHEN TRIM(${alias}.sector) = 'Technology' THEN 'Information Technology'
    ELSE TRIM(${alias}.sector)
  END`;
}

function normalizeSectorEtfSql(alias) {
  return `CASE
    WHEN ${alias}.sector IS NULL OR TRIM(${alias}.sector) = '' THEN NULL
    WHEN TRIM(${alias}.sector) IN ('Technology', 'Information Technology') THEN 'XLK'
    WHEN ${alias}.sector_etf IS NULL OR TRIM(${alias}.sector_etf) = '' THEN NULL
    ELSE TRIM(${alias}.sector_etf)
  END`;
}

async function runTickerIndicatorsForDate(env, indexCode, date) {
  const rawTable = getCurrentOhlcvReadTable();
  assertAllowedOhlcvTable(rawTable);
  assertAllowedDerivedTable(TICKER_INDICATORS_TABLE);

  await env.DB.prepare(
    `INSERT OR REPLACE INTO ${TICKER_INDICATORS_TABLE} (
      index_code,
      date,
      ticker,
      sector,
      sector_etf,

      close,
      volume,
      dollar_volume,

      prev_close,
      return_1d,
      return_5d,
      return_20d,
      return_63d,

      sma20,
      sma50,
      sma200,

      distance_sma20_pct,
      distance_sma50_pct,
      distance_sma200_pct,

      above_sma20,
      above_sma50,
      above_sma200,

      high_20d,
      low_20d,
      high_252d,
      low_252d,

      near_20d_high,
      near_20d_low,
      new_20d_high,
      new_20d_low,
      new_252d_high,
      new_252d_low,

      volume_sma20,
      volume_ratio_20d,

      is_advancer,
      is_decliner,
      is_unchanged,

      is_member_for_date,
      quality_status,
      calc_version,
      calculated_at
    )
    WITH target AS (
      SELECT '${date}' AS target_date
    ),
    universe AS (
      SELECT
        p.ticker,
        CASE
          WHEN t.sector IS NULL OR TRIM(t.sector) = '' THEN NULL
          WHEN TRIM(t.sector) = 'Technology' THEN 'Information Technology'
          ELSE TRIM(t.sector)
        END AS sector,
        CASE
          WHEN t.sector IS NULL OR TRIM(t.sector) = '' THEN NULL
          WHEN TRIM(t.sector) IN ('Technology', 'Information Technology') THEN 'XLK'
          WHEN t.sector_etf IS NULL OR TRIM(t.sector_etf) = '' THEN NULL
          ELSE TRIM(t.sector_etf)
        END AS sector_etf
      FROM index_membership_periods p
      LEFT JOIN tickers t
        ON t.ticker = p.ticker
      JOIN target d
        ON p.index_code = '${indexCode}'
       AND p.start_date <= d.target_date
       AND (p.end_date IS NULL OR d.target_date < p.end_date)
    ),
    hist AS (
      SELECT
        u.ticker,
        u.sector,
        u.sector_etf,
        o.date,
        o.close,
        o.high,
        o.low,
        o.volume,
        ROW_NUMBER() OVER (
          PARTITION BY u.ticker
          ORDER BY o.date DESC
        ) AS rn
      FROM universe u
      LEFT JOIN ${rawTable} o
        ON o.ticker = u.ticker
       AND o.date <= (SELECT target_date FROM target)
    ),
    per_ticker AS (
      SELECT
        ticker,
        sector,
        sector_etf,

        COUNT(date) AS bars_available,

        MAX(CASE WHEN rn = 1 THEN date END) AS latest_bar_date,
        MAX(CASE WHEN rn = 1 THEN close END) AS close,
        MAX(CASE WHEN rn = 1 THEN high END) AS today_high,
        MAX(CASE WHEN rn = 1 THEN low END) AS today_low,
        MAX(CASE WHEN rn = 1 THEN volume END) AS volume,

        MAX(CASE WHEN rn = 2 THEN close END) AS close_1d_ago,
        MAX(CASE WHEN rn = 6 THEN close END) AS close_5d_ago,
        MAX(CASE WHEN rn = 21 THEN close END) AS close_20d_ago,
        MAX(CASE WHEN rn = 64 THEN close END) AS close_63d_ago,

        CASE WHEN COUNT(date) >= 20
          THEN AVG(CASE WHEN rn <= 20 THEN close END)
        END AS sma20,

        CASE WHEN COUNT(date) >= 50
          THEN AVG(CASE WHEN rn <= 50 THEN close END)
        END AS sma50,

        CASE WHEN COUNT(date) >= 200
          THEN AVG(CASE WHEN rn <= 200 THEN close END)
        END AS sma200,

        CASE WHEN COUNT(date) >= 20
          THEN MAX(CASE WHEN rn <= 20 THEN high END)
        END AS high_20d,

        CASE WHEN COUNT(date) >= 20
          THEN MIN(CASE WHEN rn <= 20 THEN low END)
        END AS low_20d,

        CASE WHEN COUNT(date) >= 252
          THEN MAX(CASE WHEN rn <= 252 THEN high END)
        END AS high_252d,

        CASE WHEN COUNT(date) >= 252
          THEN MIN(CASE WHEN rn <= 252 THEN low END)
        END AS low_252d,

        CASE WHEN COUNT(date) >= 20
          THEN AVG(CASE WHEN rn <= 20 THEN volume END)
        END AS volume_sma20

      FROM hist
      GROUP BY ticker, sector, sector_etf
    )
    SELECT
      '${indexCode}' AS index_code,
      (SELECT target_date FROM target) AS date,
      ticker,
      sector,
      sector_etf,

      close,
      volume,
      close * volume AS dollar_volume,

      close_1d_ago AS prev_close,

      CASE
        WHEN close_1d_ago IS NOT NULL AND close_1d_ago != 0
        THEN close / close_1d_ago - 1
      END AS return_1d,

      CASE
        WHEN close_5d_ago IS NOT NULL AND close_5d_ago != 0
        THEN close / close_5d_ago - 1
      END AS return_5d,

      CASE
        WHEN close_20d_ago IS NOT NULL AND close_20d_ago != 0
        THEN close / close_20d_ago - 1
      END AS return_20d,

      CASE
        WHEN close_63d_ago IS NOT NULL AND close_63d_ago != 0
        THEN close / close_63d_ago - 1
      END AS return_63d,

      sma20,
      sma50,
      sma200,

      CASE WHEN sma20 IS NOT NULL AND sma20 != 0 THEN close / sma20 - 1 END AS distance_sma20_pct,
      CASE WHEN sma50 IS NOT NULL AND sma50 != 0 THEN close / sma50 - 1 END AS distance_sma50_pct,
      CASE WHEN sma200 IS NOT NULL AND sma200 != 0 THEN close / sma200 - 1 END AS distance_sma200_pct,

      CASE WHEN sma20 IS NULL THEN NULL WHEN close > sma20 THEN 1 ELSE 0 END AS above_sma20,
      CASE WHEN sma50 IS NULL THEN NULL WHEN close > sma50 THEN 1 ELSE 0 END AS above_sma50,
      CASE WHEN sma200 IS NULL THEN NULL WHEN close > sma200 THEN 1 ELSE 0 END AS above_sma200,

      high_20d,
      low_20d,
      high_252d,
      low_252d,

      CASE WHEN high_20d IS NULL THEN NULL WHEN close >= high_20d * 0.98 THEN 1 ELSE 0 END AS near_20d_high,
      CASE WHEN low_20d IS NULL THEN NULL WHEN close <= low_20d * 1.02 THEN 1 ELSE 0 END AS near_20d_low,

      CASE WHEN high_20d IS NULL THEN NULL WHEN today_high >= high_20d THEN 1 ELSE 0 END AS new_20d_high,
      CASE WHEN low_20d IS NULL THEN NULL WHEN today_low <= low_20d THEN 1 ELSE 0 END AS new_20d_low,

      CASE WHEN high_252d IS NULL THEN NULL WHEN today_high >= high_252d THEN 1 ELSE 0 END AS new_252d_high,
      CASE WHEN low_252d IS NULL THEN NULL WHEN today_low <= low_252d THEN 1 ELSE 0 END AS new_252d_low,

      volume_sma20,

      CASE
        WHEN volume_sma20 IS NOT NULL AND volume_sma20 != 0
        THEN volume / volume_sma20
      END AS volume_ratio_20d,

      CASE WHEN close_1d_ago IS NOT NULL AND close > close_1d_ago THEN 1 ELSE 0 END AS is_advancer,
      CASE WHEN close_1d_ago IS NOT NULL AND close < close_1d_ago THEN 1 ELSE 0 END AS is_decliner,
      CASE WHEN close_1d_ago IS NOT NULL AND close = close_1d_ago THEN 1 ELSE 0 END AS is_unchanged,

      1 AS is_member_for_date,

      COALESCE(
        (
          SELECT status
          FROM ohlcv_quality_daily q
          WHERE q.index_code = '${indexCode}'
            AND q.date = (SELECT target_date FROM target)
        ),
        'UNKNOWN'
      ) AS quality_status,

      'ticker_indicators_v1' AS calc_version,
      CURRENT_TIMESTAMP AS calculated_at

    FROM per_ticker
    WHERE latest_bar_date = (SELECT target_date FROM target)`
  ).run();

  return getDerivedRowCount(env, TICKER_INDICATORS_TABLE, indexCode, date);
}

async function runMarketBreadthForDate(env, indexCode, date) {
  assertAllowedDerivedTable(TICKER_INDICATORS_TABLE);
  assertAllowedDerivedTable(MARKET_BREADTH_TABLE);

  await env.DB.prepare(
    `INSERT OR REPLACE INTO ${MARKET_BREADTH_TABLE} (
      index_code,
      date,

      universe_count,
      coverage_count,

      above_sma20_count,
      above_sma20_pct,
      above_sma50_count,
      above_sma50_pct,
      above_sma200_count,
      above_sma200_pct,

      advancers_count,
      decliners_count,
      unchanged_count,
      advancers_pct,
      decliners_pct,

      new_20d_high_count,
      new_20d_low_count,
      new_252d_high_count,
      new_252d_low_count,

      average_return_1d,
      average_return_5d,
      average_return_20d,

      up_volume,
      down_volume,
      net_volume_pressure,

      calc_version,
      calculated_at
    )
    SELECT
      '${indexCode}' AS index_code,
      '${date}' AS date,

      COUNT(*) AS universe_count,
      SUM(CASE WHEN close IS NOT NULL THEN 1 ELSE 0 END) AS coverage_count,

      SUM(CASE WHEN above_sma20 = 1 THEN 1 ELSE 0 END) AS above_sma20_count,
      ROUND(
        100.0 * SUM(CASE WHEN above_sma20 = 1 THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN above_sma20 IS NOT NULL THEN 1 ELSE 0 END), 0),
        2
      ) AS above_sma20_pct,

      SUM(CASE WHEN above_sma50 = 1 THEN 1 ELSE 0 END) AS above_sma50_count,
      ROUND(
        100.0 * SUM(CASE WHEN above_sma50 = 1 THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN above_sma50 IS NOT NULL THEN 1 ELSE 0 END), 0),
        2
      ) AS above_sma50_pct,

      SUM(CASE WHEN above_sma200 = 1 THEN 1 ELSE 0 END) AS above_sma200_count,
      ROUND(
        100.0 * SUM(CASE WHEN above_sma200 = 1 THEN 1 ELSE 0 END)
        / NULLIF(SUM(CASE WHEN above_sma200 IS NOT NULL THEN 1 ELSE 0 END), 0),
        2
      ) AS above_sma200_pct,

      SUM(is_advancer) AS advancers_count,
      SUM(is_decliner) AS decliners_count,
      SUM(is_unchanged) AS unchanged_count,

      ROUND(
        100.0 * SUM(is_advancer) / NULLIF(COUNT(*), 0),
        2
      ) AS advancers_pct,

      ROUND(
        100.0 * SUM(is_decliner) / NULLIF(COUNT(*), 0),
        2
      ) AS decliners_pct,

      SUM(new_20d_high) AS new_20d_high_count,
      SUM(new_20d_low) AS new_20d_low_count,
      SUM(new_252d_high) AS new_252d_high_count,
      SUM(new_252d_low) AS new_252d_low_count,

      AVG(return_1d) AS average_return_1d,
      AVG(return_5d) AS average_return_5d,
      AVG(return_20d) AS average_return_20d,

      SUM(CASE WHEN is_advancer = 1 THEN volume ELSE 0 END) AS up_volume,
      SUM(CASE WHEN is_decliner = 1 THEN volume ELSE 0 END) AS down_volume,

      CASE
        WHEN
          SUM(CASE WHEN is_advancer = 1 THEN volume ELSE 0 END) +
          SUM(CASE WHEN is_decliner = 1 THEN volume ELSE 0 END) > 0
        THEN
          1.0 * (
            SUM(CASE WHEN is_advancer = 1 THEN volume ELSE 0 END) -
            SUM(CASE WHEN is_decliner = 1 THEN volume ELSE 0 END)
          )
          /
          (
            SUM(CASE WHEN is_advancer = 1 THEN volume ELSE 0 END) +
            SUM(CASE WHEN is_decliner = 1 THEN volume ELSE 0 END)
          )
      END AS net_volume_pressure,

      'market_breadth_v1' AS calc_version,
      CURRENT_TIMESTAMP AS calculated_at

    FROM ${TICKER_INDICATORS_TABLE}
    WHERE index_code = '${indexCode}'
      AND date = '${date}'`
  ).run();

  return getDerivedRowCount(env, MARKET_BREADTH_TABLE, indexCode, date);
}

async function runSectorBreadthForDate(env, indexCode, date) {
  assertAllowedDerivedTable(TICKER_INDICATORS_TABLE);
  assertAllowedDerivedTable(SECTOR_BREADTH_TABLE);

  await env.DB.prepare(
    `INSERT OR REPLACE INTO ${SECTOR_BREADTH_TABLE} (
      index_code,
      date,
      sector,
      sector_etf,

      ticker_count,
      coverage_count,

      above_sma20_count,
      above_sma20_pct,
      above_sma50_count,
      above_sma50_pct,
      above_sma200_count,
      above_sma200_pct,

      advancers_count,
      decliners_count,
      unchanged_count,
      advancers_pct,
      decliners_pct,

      new_20d_high_count,
      new_20d_low_count,
      new_252d_high_count,
      new_252d_low_count,

      median_return_1d,
      median_return_5d,
      median_return_20d,

      average_return_1d,
      average_return_5d,
      average_return_20d,

      up_volume,
      down_volume,
      net_volume_pressure,

      breadth_score,
      momentum_score,
      trend_score,

      rank_breadth,
      rank_momentum,
      rank_trend,

      calc_version,
      calculated_at
    )
    WITH base AS (
      SELECT
        index_code,
        date,
        CASE
          WHEN sector IS NULL OR TRIM(sector) = '' THEN 'UNKNOWN'
          WHEN TRIM(sector) = 'Technology' THEN 'Information Technology'
          ELSE TRIM(sector)
        END AS sector,
        CASE
          WHEN TRIM(sector) IN ('Technology', 'Information Technology') THEN 'XLK'
          WHEN sector_etf IS NULL OR TRIM(sector_etf) = '' THEN NULL
          ELSE TRIM(sector_etf)
        END AS sector_etf,
        close,
        volume,
        return_1d,
        return_5d,
        return_20d,
        above_sma20,
        above_sma50,
        above_sma200,
        is_advancer,
        is_decliner,
        is_unchanged,
        new_20d_high,
        new_20d_low,
        new_252d_high,
        new_252d_low
      FROM ${TICKER_INDICATORS_TABLE}
      WHERE index_code = '${indexCode}'
        AND date = '${date}'
    ),
    r1 AS (
      SELECT
        sector,
        return_1d,
        ROW_NUMBER() OVER (PARTITION BY sector ORDER BY return_1d) AS rn,
        COUNT(*) OVER (PARTITION BY sector) AS cnt
      FROM base
      WHERE return_1d IS NOT NULL
    ),
    m1 AS (
      SELECT
        sector,
        AVG(return_1d) AS median_return_1d
      FROM r1
      WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
      GROUP BY sector
    ),
    r5 AS (
      SELECT
        sector,
        return_5d,
        ROW_NUMBER() OVER (PARTITION BY sector ORDER BY return_5d) AS rn,
        COUNT(*) OVER (PARTITION BY sector) AS cnt
      FROM base
      WHERE return_5d IS NOT NULL
    ),
    m5 AS (
      SELECT
        sector,
        AVG(return_5d) AS median_return_5d
      FROM r5
      WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
      GROUP BY sector
    ),
    r20 AS (
      SELECT
        sector,
        return_20d,
        ROW_NUMBER() OVER (PARTITION BY sector ORDER BY return_20d) AS rn,
        COUNT(*) OVER (PARTITION BY sector) AS cnt
      FROM base
      WHERE return_20d IS NOT NULL
    ),
    m20 AS (
      SELECT
        sector,
        AVG(return_20d) AS median_return_20d
      FROM r20
      WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
      GROUP BY sector
    ),
    agg AS (
      SELECT
        '${indexCode}' AS index_code,
        '${date}' AS date,
        b.sector,
        MAX(b.sector_etf) AS sector_etf,

        COUNT(*) AS ticker_count,
        SUM(CASE WHEN b.close IS NOT NULL THEN 1 ELSE 0 END) AS coverage_count,

        SUM(CASE WHEN b.above_sma20 = 1 THEN 1 ELSE 0 END) AS above_sma20_count,
        ROUND(
          100.0 * SUM(CASE WHEN b.above_sma20 = 1 THEN 1 ELSE 0 END)
          / NULLIF(SUM(CASE WHEN b.above_sma20 IS NOT NULL THEN 1 ELSE 0 END), 0),
          2
        ) AS above_sma20_pct,

        SUM(CASE WHEN b.above_sma50 = 1 THEN 1 ELSE 0 END) AS above_sma50_count,
        ROUND(
          100.0 * SUM(CASE WHEN b.above_sma50 = 1 THEN 1 ELSE 0 END)
          / NULLIF(SUM(CASE WHEN b.above_sma50 IS NOT NULL THEN 1 ELSE 0 END), 0),
          2
        ) AS above_sma50_pct,

        SUM(CASE WHEN b.above_sma200 = 1 THEN 1 ELSE 0 END) AS above_sma200_count,
        ROUND(
          100.0 * SUM(CASE WHEN b.above_sma200 = 1 THEN 1 ELSE 0 END)
          / NULLIF(SUM(CASE WHEN b.above_sma200 IS NOT NULL THEN 1 ELSE 0 END), 0),
          2
        ) AS above_sma200_pct,

        SUM(CASE WHEN b.is_advancer = 1 THEN 1 ELSE 0 END) AS advancers_count,
        SUM(CASE WHEN b.is_decliner = 1 THEN 1 ELSE 0 END) AS decliners_count,
        SUM(CASE WHEN b.is_unchanged = 1 THEN 1 ELSE 0 END) AS unchanged_count,

        ROUND(
          100.0 * SUM(CASE WHEN b.is_advancer = 1 THEN 1 ELSE 0 END)
          / NULLIF(COUNT(*), 0),
          2
        ) AS advancers_pct,

        ROUND(
          100.0 * SUM(CASE WHEN b.is_decliner = 1 THEN 1 ELSE 0 END)
          / NULLIF(COUNT(*), 0),
          2
        ) AS decliners_pct,

        SUM(CASE WHEN b.new_20d_high = 1 THEN 1 ELSE 0 END) AS new_20d_high_count,
        SUM(CASE WHEN b.new_20d_low = 1 THEN 1 ELSE 0 END) AS new_20d_low_count,
        SUM(CASE WHEN b.new_252d_high = 1 THEN 1 ELSE 0 END) AS new_252d_high_count,
        SUM(CASE WHEN b.new_252d_low = 1 THEN 1 ELSE 0 END) AS new_252d_low_count,

        m1.median_return_1d,
        m5.median_return_5d,
        m20.median_return_20d,

        AVG(b.return_1d) AS average_return_1d,
        AVG(b.return_5d) AS average_return_5d,
        AVG(b.return_20d) AS average_return_20d,

        SUM(CASE WHEN b.is_advancer = 1 THEN b.volume ELSE 0 END) AS up_volume,
        SUM(CASE WHEN b.is_decliner = 1 THEN b.volume ELSE 0 END) AS down_volume,

        CASE
          WHEN
            SUM(CASE WHEN b.is_advancer = 1 THEN b.volume ELSE 0 END) +
            SUM(CASE WHEN b.is_decliner = 1 THEN b.volume ELSE 0 END) > 0
          THEN
            1.0 * (
              SUM(CASE WHEN b.is_advancer = 1 THEN b.volume ELSE 0 END) -
              SUM(CASE WHEN b.is_decliner = 1 THEN b.volume ELSE 0 END)
            )
            /
            (
              SUM(CASE WHEN b.is_advancer = 1 THEN b.volume ELSE 0 END) +
              SUM(CASE WHEN b.is_decliner = 1 THEN b.volume ELSE 0 END)
            )
        END AS net_volume_pressure

      FROM base b
      LEFT JOIN m1 ON m1.sector = b.sector
      LEFT JOIN m5 ON m5.sector = b.sector
      LEFT JOIN m20 ON m20.sector = b.sector
      GROUP BY b.sector
    ),
    scored AS (
      SELECT
        *,

        ROUND(
          (
            COALESCE(above_sma20_pct, 0) +
            COALESCE(advancers_pct, 0) +
            COALESCE(100.0 - decliners_pct, 0)
          ) / 3.0,
          2
        ) AS breadth_score,

        CASE
          WHEN average_return_20d IS NULL THEN NULL
          WHEN 50.0 + average_return_20d * 500.0 > 100 THEN 100
          WHEN 50.0 + average_return_20d * 500.0 < 0 THEN 0
          ELSE ROUND(50.0 + average_return_20d * 500.0, 2)
        END AS momentum_score,

        ROUND(
          (
            COALESCE(above_sma50_pct, 0) +
            COALESCE(above_sma200_pct, 0)
          ) / 2.0,
          2
        ) AS trend_score

      FROM agg
    ),
    ranked AS (
      SELECT
        *,
        RANK() OVER (ORDER BY breadth_score DESC) AS rank_breadth,
        RANK() OVER (ORDER BY momentum_score DESC) AS rank_momentum,
        RANK() OVER (ORDER BY trend_score DESC) AS rank_trend
      FROM scored
    )
    SELECT
      index_code,
      date,
      sector,
      sector_etf,

      ticker_count,
      coverage_count,

      above_sma20_count,
      above_sma20_pct,
      above_sma50_count,
      above_sma50_pct,
      above_sma200_count,
      above_sma200_pct,

      advancers_count,
      decliners_count,
      unchanged_count,
      advancers_pct,
      decliners_pct,

      new_20d_high_count,
      new_20d_low_count,
      new_252d_high_count,
      new_252d_low_count,

      median_return_1d,
      median_return_5d,
      median_return_20d,

      average_return_1d,
      average_return_5d,
      average_return_20d,

      up_volume,
      down_volume,
      net_volume_pressure,

      breadth_score,
      momentum_score,
      trend_score,

      rank_breadth,
      rank_momentum,
      rank_trend,

      'sector_breadth_v1' AS calc_version,
      CURRENT_TIMESTAMP AS calculated_at
    FROM ranked`
  ).run();

  return getDerivedRowCount(env, SECTOR_BREADTH_TABLE, indexCode, date);
}

async function getDerivedRowCount(env, table, indexCode, date) {
  assertAllowedDerivedTable(table);

  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS row_count
     FROM ${table}
     WHERE index_code = ?
       AND date = ?`
  ).bind(indexCode, date).all();

  return Number(result.results[0] && result.results[0].row_count || 0);
}

async function computeAndStoreOhlcvQuality(env, indexCode, date) {
  const runId = `quality:${indexCode}:${date}:${Date.now()}`;
  const startedAt = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO calculation_runs (
      run_id, job_type, target_date, bucket, status, started_at, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    runId,
    "CHECK_OHLCV_QUALITY",
    date,
    getCurrentOhlcvReadTable(),
    "RUNNING",
    startedAt,
    JSON.stringify({ index_code: indexCode, date })
  ).run();

  try {
    const quality = await computeOhlcvQuality(env, indexCode, date);
    await upsertOhlcvQuality(env, quality);

    await env.DB.prepare(
      `UPDATE calculation_runs
       SET status = ?,
           finished_at = ?,
           rows_read = ?,
           rows_written = ?,
           metadata_json = ?
       WHERE run_id = ?`
    ).bind(
      "DONE",
      new Date().toISOString(),
      quality.raw_rows + quality.expected_count,
      1,
      JSON.stringify({
        status: quality.status,
        missing_count: quality.missing_count,
        extra_count: quality.extra_count,
        duplicate_extra_rows: quality.duplicate_extra_rows
      }),
      runId
    ).run();

    return {
      ok: true,
      run_id: runId,
      quality
    };

  } catch (err) {
    const message = String(err && err.message ? err.message : err);

    await env.DB.prepare(
      `UPDATE calculation_runs
       SET status = ?,
           finished_at = ?,
           error = ?
       WHERE run_id = ?`
    ).bind(
      "FAILED",
      new Date().toISOString(),
      message,
      runId
    ).run();

    return {
      ok: false,
      run_id: runId,
      error: message
    };
  }
}

/* -----------------------------
 * Quality / universe logic
 * ----------------------------- */

async function getUniverseForDate(env, indexCode, date) {
  const result = await env.DB.prepare(
    `SELECT
       p.ticker,
       t.name,
       t.sector,
       t.industry,
       t.sub_industry,
       t.sector_etf,
       p.start_date,
       p.end_date,
       p.event_type,
       p.source
     FROM index_membership_periods p
     LEFT JOIN tickers t
       ON t.ticker = p.ticker
     WHERE p.index_code = ?
       AND p.start_date <= ?
       AND (p.end_date IS NULL OR ? < p.end_date)
     ORDER BY p.ticker`
  ).bind(indexCode, date, date).all();

  return result.results || [];
}

async function computeOhlcvQuality(env, indexCode, date) {
  const table = getCurrentOhlcvReadTable();
  assertAllowedOhlcvTable(table);
  const universe = await getUniverseForDate(env, indexCode, date);
  const rowsResult = await env.DB.prepare(
    `SELECT ticker, open, high, low, close, volume, source
     FROM ${table} WHERE date = ? ORDER BY ticker`
  ).bind(date).all();

  const expectedSet = new Set();
  const presentSet = new Set();
  const validSet = new Set();
  const rowCounts = new Map();
  let rawRows = 0, duplicateExtraRows = 0, invalidRows = 0;
  const duplicateSamples = [], invalidSamples = [];
  for (const row of universe) {
    const ticker = normalizeTicker(row.ticker);
    if (ticker) expectedSet.add(ticker);
  }
  for (const row of rowsResult.results || []) {
    rawRows++;
    const ticker = normalizeTicker(row.ticker);
    if (!ticker) { invalidRows++; continue; }
    presentSet.add(ticker);
    rowCounts.set(ticker, (rowCounts.get(ticker) || 0) + 1);

    const values = [row.open, row.high, row.low, row.close, row.volume].map(Number);
    const [open, high, low, close, volume] = values;
    const valid = values.every(Number.isFinite) &&
      open > 0 && high > 0 && low > 0 && close > 0 && volume > 0 &&
      high >= Math.max(open, low, close) &&
      low <= Math.min(open, high, close);
    if (valid) validSet.add(ticker);
    else {
      invalidRows++;
      if (invalidSamples.length < 20) invalidSamples.push(ticker);
    }
  }
  for (const [ticker, count] of rowCounts.entries()) {
    if (count > 1) {
      duplicateExtraRows += count - 1;
      if (duplicateSamples.length < 20) duplicateSamples.push(`${ticker} x${count}`);
    }
  }

  const missing = [], extras = [];
  for (const ticker of expectedSet) if (!validSet.has(ticker)) missing.push(ticker);
  for (const ticker of validSet) if (!expectedSet.has(ticker)) extras.push(ticker);
  missing.sort(); extras.sort();

  const expectedCount = expectedSet.size;
  const minimumRequiredCount = Math.ceil(expectedCount * 0.98);
  const validUniqueTickers = validSet.size;
  // Extras must never inflate coverage: only valid members of the expected
  // date-specific universe count toward the 98% threshold.
  const matchedExpectedTickers = expectedCount - missing.length;
  const coverageRate = expectedCount > 0 ? matchedExpectedTickers / expectedCount : 0;
  const status = expectedCount > 0 &&
    matchedExpectedTickers >= minimumRequiredCount &&
    duplicateExtraRows === 0 && invalidRows === 0
      ? "OK" : "FAIL";

  return {
    index_code: indexCode, date, source_table: table,
    expected_count: expectedCount,
    minimum_required_count: minimumRequiredCount,
    coverage_rate: Number((coverageRate * 100).toFixed(2)),
    raw_rows: rawRows, unique_tickers: presentSet.size,
    valid_unique_tickers: validUniqueTickers,
    matched_expected_tickers: matchedExpectedTickers, invalid_rows: invalidRows,
    duplicate_extra_rows: duplicateExtraRows,
    missing_count: missing.length, extra_count: extras.length,
    membership_grace_trading_days: 2,
    status,
    missing_samples: missing.slice(0, 50), extra_samples: extras.slice(0, 50),
    duplicate_samples: duplicateSamples.slice(0, 50),
    invalid_samples: invalidSamples.slice(0, 50),
    checked_at: new Date().toISOString(),
    source: "worker_quality_check_v2_98pct"
  };
}

async function upsertOhlcvQuality(env, quality) {
  await env.DB.prepare(
    `INSERT INTO ohlcv_quality_daily (
      index_code,
      date,
      expected_count,
      raw_rows,
      unique_tickers,
      duplicate_extra_rows,
      missing_count,
      extra_count,
      status,
      missing_samples_json,
      extra_samples_json,
      duplicate_samples_json,
      checked_at,
      source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(index_code, date) DO UPDATE SET
      expected_count = excluded.expected_count,
      raw_rows = excluded.raw_rows,
      unique_tickers = excluded.unique_tickers,
      duplicate_extra_rows = excluded.duplicate_extra_rows,
      missing_count = excluded.missing_count,
      extra_count = excluded.extra_count,
      status = excluded.status,
      missing_samples_json = excluded.missing_samples_json,
      extra_samples_json = excluded.extra_samples_json,
      duplicate_samples_json = excluded.duplicate_samples_json,
      checked_at = excluded.checked_at,
      source = excluded.source`
  ).bind(
    quality.index_code,
    quality.date,
    quality.expected_count,
    quality.raw_rows,
    quality.unique_tickers,
    quality.duplicate_extra_rows,
    quality.missing_count,
    quality.extra_count,
    quality.status,
    JSON.stringify(quality.missing_samples || []),
    JSON.stringify(quality.extra_samples || []),
    JSON.stringify(quality.duplicate_samples || []),
    quality.checked_at,
    quality.source
  ).run();
}

/* -----------------------------
 * Ingest routes
 * ----------------------------- */

async function handleIngestTickers(request, env) {
  const body = await request.json();
  const rows = Array.isArray(body.data) ? body.data : [];

  if (rows.length === 0) {
    return json({ ok: false, error: "No ticker rows provided" }, CORS_HEADERS, 400);
  }

  const now = new Date().toISOString();
  const statements = [];
  const received = rows.length;
  let valid = 0;

  for (const row of rows) {
    const ticker = normalizeTicker(row.ticker);
    if (!ticker) continue;

    valid++;

    statements.push(
      env.DB.prepare(
        `INSERT INTO tickers (
          ticker, name, sector, industry, sub_industry, sector_etf,
          is_current_sp500, is_active, date_added, date_removed,
          source, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET
          name = excluded.name,
          sector = excluded.sector,
          industry = excluded.industry,
          sub_industry = excluded.sub_industry,
          sector_etf = excluded.sector_etf,
          is_current_sp500 = excluded.is_current_sp500,
          is_active = excluded.is_active,
          date_added = COALESCE(NULLIF(tickers.date_added, ''), excluded.date_added),
          date_removed = excluded.date_removed,
          source = excluded.source,
          updated_at = excluded.updated_at`
      ).bind(
        ticker,
        safeText(row.name),
        safeText(row.sector),
        safeText(row.industry),
        safeText(row.sub_industry),
        safeText(row.sector_etf),
        boolToInt(row.is_current_sp500),
        boolToInt(row.is_active),
        safeText(row.date_added),
        safeText(row.date_removed),
        safeText(row.source || "google_sheet"),
        safeText(row.updated_at || now)
      )
    );
  }

  if (statements.length === 0) {
    return json({
      ok: false,
      error: "No valid ticker rows provided",
      received,
      valid
    }, CORS_HEADERS, 400);
  }

  const batchResult = await env.DB.batch(statements);

  return json({
    ok: true,
    received,
    valid,
    accepted: valid,
    inserted: valid,
    target_table: "tickers",
    batch_results: summarizeBatchResults(batchResult)
  }, CORS_HEADERS);
}

async function handleIngestOhlcv(request, env) {
  const body = await request.json();
  const rows = Array.isArray(body.data) ? body.data : [];

  if (rows.length === 0) {
    return json({ ok: false, error: "No OHLCV rows provided" }, CORS_HEADERS, 400);
  }

  const now = new Date().toISOString();
  const statements = [];

  const received = rows.length;
  let valid = 0;

  const invalidSamples = [];
  const bucketCounts = {};
  const targetTables = new Set();

  for (const row of rows) {
    const ticker = normalizeTicker(row.ticker);
    const date = normalizeDate(row.date);

    if (!ticker || !date) {
      if (invalidSamples.length < 10) invalidSamples.push(row);
      continue;
    }

    const bucket = getOhlcvBucketForDate(date);

    if (!bucket) {
      if (invalidSamples.length < 10) {
        invalidSamples.push({
          ticker,
          date,
          reason: "No OHLCV bucket table for date"
        });
      }
      continue;
    }

    valid++;

    bucketCounts[bucket.table] = (bucketCounts[bucket.table] || 0) + 1;
    targetTables.add(bucket.table);

    statements.push(
      buildOhlcvUpsertStatement(env, bucket.table, {
        ticker,
        date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        source: row.source || "GOOGLEFINANCE",
        ingested_at: now
      })
    );

    if (DUAL_WRITE_LEGACY_OHLCV) {
      targetTables.add(LEGACY_OHLCV_TABLE);

      statements.push(
        buildOhlcvUpsertStatement(env, LEGACY_OHLCV_TABLE, {
          ticker,
          date,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          source: row.source || "GOOGLEFINANCE",
          ingested_at: now
        })
      );
    }
  }

  if (valid === 0 || statements.length === 0) {
    return json({
      ok: false,
      error: "No valid OHLCV rows provided",
      received,
      valid,
      invalid_samples: invalidSamples
    }, CORS_HEADERS, 400);
  }

  const batchResult = await env.DB.batch(statements);

  return json({
    ok: true,
    mode: "bucket-aware-dual-write",
    received,
    valid,
    accepted: valid,
    inserted: valid,
    target_tables: Array.from(targetTables).sort(),
    bucket_counts: bucketCounts,
    legacy_dual_write: DUAL_WRITE_LEGACY_OHLCV,
    statements_written: statements.length,
    invalid_samples: invalidSamples,
    batch_results: summarizeBatchResults(batchResult)
  }, CORS_HEADERS);
}

function buildOhlcvUpsertStatement(env, table, row) {
  assertAllowedOhlcvTable(table);

  return env.DB.prepare(
    `INSERT INTO ${table} (
      ticker, date, open, high, low, close, volume, source, ingested_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, date) DO UPDATE SET
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume,
      source = excluded.source,
      ingested_at = excluded.ingested_at`
  ).bind(
    row.ticker,
    row.date,
    nullableNumber(row.open),
    nullableNumber(row.high),
    nullableNumber(row.low),
    nullableNumber(row.close),
    nullableInteger(row.volume),
    safeText(row.source || "GOOGLEFINANCE"),
    safeText(row.ingested_at)
  );
}

/* -----------------------------
 * Bucket helpers
 * ----------------------------- */



function getCurrentOhlcvReadTable() {
  return "ohlcv_daily_2024_2027";
}

function getOhlcvBucketForDate(date) {
  const dateKey = normalizeDate(date);
  if (!dateKey) return null;

  for (const bucket of OHLCV_BUCKETS) {
    if (dateKey >= bucket.start && dateKey < bucket.end) {
      return bucket;
    }
  }

  return null;
}

function assertAllowedOhlcvTable(table) {
  if (table === LEGACY_OHLCV_TABLE) return;

  for (const bucket of OHLCV_BUCKETS) {
    if (bucket.table === table) return;
  }

  throw new Error(`Unsafe or unsupported OHLCV table: ${table}`);
}

async function resolveQualityDate(url, env) {
  const rawDate = String(url.searchParams.get("date") || "").trim();

  if (rawDate && rawDate.toLowerCase() !== "latest") {
    return normalizeDate(rawDate);
  }

  const table = getCurrentOhlcvReadTable();

  const result = await env.DB.prepare(
    `SELECT MAX(date) AS latest_date
     FROM ${table}`
  ).all();

  return normalizeDate(result.results[0] && result.results[0].latest_date);
}


async function resolveDerivedDate(url, env, table) {
  const rawDate = String(url.searchParams.get("date") || "").trim();

  if (rawDate && rawDate.toLowerCase() !== "latest") {
    return normalizeDate(rawDate);
  }

  return getLatestDateFromTable(env, table);
}

async function getLatestDateFromTable(env, table) {
  assertAllowedDerivedTable(table);

  const result = await env.DB.prepare(
    `SELECT MAX(date) AS latest_date
     FROM ${table}
     WHERE index_code = ?`
  ).bind(INDEX_CODE).all();

  return normalizeDate(result.results[0] && result.results[0].latest_date);
}

function assertAllowedDerivedTable(table) {
  if (
    table === TICKER_INDICATORS_TABLE ||
    table === MARKET_BREADTH_TABLE ||
    table === SECTOR_BREADTH_TABLE
  ) {
    return;
  }

  throw new Error(`Unsafe or unsupported derived table: ${table}`);
}

/* -----------------------------
 * Generic helpers
 * ----------------------------- */

function json(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function normalizeTicker(value) {
  return String(value || "").toUpperCase().trim();
}

function normalizeDate(value) {
  if (value === null || typeof value === "undefined") return "";

  const text = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";

  return date.toISOString().slice(0, 10);
}

function safeText(value) {
  if (value === null || typeof value === "undefined") return "";
  return String(value).trim();
}

function nullableNumber(value) {
  if (value === "" || value === null || typeof value === "undefined") return null;

  const n = Number(value);
  if (!Number.isFinite(n)) return null;

  return n;
}

function nullableInteger(value) {
  if (value === "" || value === null || typeof value === "undefined") return null;

  const n = Number(value);
  if (!Number.isFinite(n)) return null;

  return Math.round(n);
}

function boolToInt(value) {
  if (value === true) return 1;
  if (value === false) return 0;

  const text = String(value ?? "").toUpperCase().trim();

  if (text === "TRUE" || text === "YES" || text === "1") return 1;
  if (text === "FALSE" || text === "NO" || text === "0") return 0;

  return 1;
}

function clampInteger(value, fallback, min, max) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.min(Math.max(Math.floor(n), min), max);
}

function summarizeBatchResults(batchResult) {
  if (!Array.isArray(batchResult)) {
    return {
      count: 0,
      success_count: 0,
      rows_written: 0,
      samples: []
    };
  }

  let successCount = 0;
  let rowsWritten = 0;
  const samples = [];

  for (const item of batchResult) {
    if (item && item.success) successCount++;

    if (item && item.meta && typeof item.meta.rows_written === "number") {
      rowsWritten += item.meta.rows_written;
    }

    if (samples.length < 3) {
      samples.push({
        success: item ? item.success : undefined,
        rows_written: item && item.meta ? item.meta.rows_written : undefined,
        duration: item && item.meta ? item.meta.duration : undefined
      });
    }
  }

  return {
    count: batchResult.length,
    success_count: successCount,
    rows_written: rowsWritten,
    samples
  };
}

async function handleIngestMembershipEvents(request, env) {
  const body = await request.json();
  const rows = Array.isArray(body.data) ? body.data : [];

  if (rows.length === 0) {
    return json({ ok: false, error: "No membership event rows provided" }, CORS_HEADERS, 400);
  }

  const results = [];
  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const indexCode = safeText(row.index_code || INDEX_CODE).toUpperCase();
    const ticker = normalizeTicker(row.ticker);
    const action = safeText(row.action).toUpperCase(); // "ADD" | "REMOVE"
    const effectiveDate = normalizeDate(row.effective_date);
    const source = safeText(row.source || "membership_sync");
    const notes = safeText(row.notes || "");

    if (!ticker || !effectiveDate || (action !== "ADD" && action !== "REMOVE")) {
      results.push({ ticker, action, ok: false, reason: "Invalid row: requires ticker, action(ADD|REMOVE), effective_date" });
      failed++;
      continue;
    }

    if (action === "REMOVE") {
      const open = await env.DB.prepare(
        `SELECT ticker, start_date FROM index_membership_periods
         WHERE index_code = ? AND ticker = ? AND end_date IS NULL`
      ).bind(indexCode, ticker).all();

      const openRows = open.results || [];

      if (openRows.length === 0) {
        results.push({ ticker, action, ok: true, reason: "No open period found (already closed)" });
        skipped++;
        continue;
      }

      if (openRows.length > 1) {
        // 資料本身已經是異常狀態，不要悶著頭全關，回報出來讓人去看
        results.push({
          ticker,
          action,
          ok: false,
          reason: `Ambiguous state: ${openRows.length} open periods found for this ticker, refusing to auto-close`,
          open_start_dates: openRows.map((r) => r.start_date)
        });
        failed++;
        continue;
      }

      await env.DB.prepare(
        `UPDATE index_membership_periods
         SET end_date = ?, event_type = 'REMOVE', source = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
         WHERE index_code = ? AND ticker = ? AND end_date IS NULL`
      ).bind(effectiveDate, source, notes, indexCode, ticker).run();

      results.push({ ticker, action, ok: true, end_date: effectiveDate });
      applied++;
      continue;
    }

    // action === "ADD"
    const existing = await env.DB.prepare(
      `SELECT ticker FROM index_membership_periods
       WHERE index_code = ? AND ticker = ? AND start_date = ?`
    ).bind(indexCode, ticker, effectiveDate).all();

    if (existing.results && existing.results.length > 0) {
      results.push({ ticker, action, ok: true, reason: "Period already exists (idempotent skip)" });
      skipped++;
      continue;
    }

    const insertResult = await env.DB.prepare(
      `INSERT OR IGNORE INTO index_membership_periods (
        index_code, ticker, start_date, end_date, event_type, source, notes
      ) VALUES (?, ?, ?, NULL, 'ADD', ?, ?)`
    ).bind(indexCode, ticker, effectiveDate, source, notes).run();

    const wasInserted = insertResult.meta && insertResult.meta.rows_written > 0;

    results.push({
      ticker,
      action,
      ok: true,
      start_date: effectiveDate,
      reason: wasInserted ? undefined : "Already existed (race-condition guard, idempotent skip)"
    });

    if (wasInserted) {
      applied++;
    } else {
      skipped++;
    }
  }

  return json({
    ok: failed === 0,
    received: rows.length,
    applied,
    skipped,
    failed,
    target_table: "index_membership_periods",
    results
  }, CORS_HEADERS);
}