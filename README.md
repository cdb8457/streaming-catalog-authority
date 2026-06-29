# Catalog Authority — Phase 1

Event-sourced catalog authority core. **No** provider adapters, media servers, HTTP,
Hermes, job queues, or UI — by design. The core stands alone.

## Run

```bash
npm install      # downloads an embedded PostgreSQL 16 binary (no Docker needed)
npm run ci       # typecheck, then the full Phase 1 suite -> "14 passed, 0 failed"
```

Tests boot a throwaway PostgreSQL 16 on `localhost:5433` and point `DATABASE_URL`
at it. To run against your own server instead, set `DATABASE_URL` before invoking.

## Structure

```
src/
  db/migrations.sql          events (append-only trigger), items, provider_refs
  db/pool.ts                 connection + migrate helpers
  core/catalog/events.ts     opaque event constructors (structural + behavioral)
  core/catalog/reducer.ts    pure event -> OPERATIONAL projection writes
  core/catalog/authority.ts  CatalogAuthority — the SOLE mutator
  core/redaction/noleak.ts   no-leak gate (key allowlist + signature scan)
test/run.ts                  the Phase 1 suite
test/embedded-pg.ts          embedded PostgreSQL 16 boot for tests
```

## Boundaries (enforced)

- `CatalogAuthority` is the only writer of `items` / `provider_refs` (static test).
- `apply(event)` is the single mutator; commands author events and route through it.
- Events are opaque — no title, external_ids, infohash value, magnet, URL, or key in
  any payload. The no-leak gate runs before every insert.
- Identity lives only in the projection; rebuild restores operational state, identity NULL.
- Append-only log, folded by `seq`, per-item advisory lock. DELETE allowed only for
  expired behavioral events (ADR-4 TTL split).
- The catalog core imports nothing about providers / HTTP / adapters / Hermes (static test).

## Not in this slice

No provider adapter (mock or real), no Plex/Jellyfin/RD/TorBox, no Hermes, no HTTP, no
job queue, no frontend. That isolation is the result, not an omission.
