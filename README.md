# Breadth Backend

Google Apps Script collector and Cloudflare Worker/D1 ingestion pipeline.

## Source layout

- `00_config.gs` – shared configuration and schemas.
- `01_Utils.gs`–`09_Audit.gs` – production collector, registry, sync, and health-gate modules.
- `11_API.gs` – Apps Script API endpoints.
- `12_CloudflareSync.gs` – Cloudflare ingestion and derivation engine.
- `99_Admin.gs` – manual inspection, maintenance, and temporary operations.

## Operating rules

1. Production schedules and reusable pipeline logic stay in their numbered modules.
2. One-off work (backfills, repairs, replays, historical pushes, re-derives, data cleanup, and temporary diagnostics) is authored only in `99_Admin.gs`.
3. Before a one-off write, add a preview/dry-run and explicit scope checks. Run it, verify the result, then remove the temporary operation code from `99_Admin.gs`.
4. Never leave incident-specific dates, ticker lists, or destructive cleanup functions in production modules.
5. Do not clear worker state or delete triggers broadly. Inspect the exact state and handler first; reset only the confirmed stale item.
6. One-off repair code must not prune the Sheet cache or advance production cursors. Production pipeline safety gates must be validated separately.
7. Existing Sheet data and historical queue/stage sheets are not deleted by source cleanup.

## Legacy workers

Old generic and incident-specific backfill workers have been retired from source. Minimal callbacks in `99_Admin.gs` exist only to remove stale time triggers when they fire. Legacy Script Properties are inspected by `inspectAllActiveStates()`; do not delete them until their contents are reviewed.

## Deployment

A GitHub source commit does not deploy Apps Script or the Cloudflare Worker. Deploy each runtime separately.
