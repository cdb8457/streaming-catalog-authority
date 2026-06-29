# Catalog Authority — Phase 1 (hardened)

Event-sourced catalog authority core. **No** provider adapters, media servers, HTTP,
Hermes, job queues, or UI — by design. The core stands alone.

## Run

```bash
npm install      # downloads an embedded PostgreSQL 16 binary (no Docker needed)
npm run ci       # typecheck, then the full Phase 1 suite -> "19 passed, 0 failed"
```

Tests boot a throwaway PostgreSQL 16 unless `DATABASE_URL` is already set. To run against
your own server, export `ADMIN_DATABASE_URL` (owner/migrator) and `DATABASE_URL` (runtime
app role) — see `.env.example`. A `docker-compose.yml` provisions a `postgres:16` service.

## Structure

```
src/
  db/migrations.sql          events (append-only + truncate guard), items, provider_refs,
                             prune function, least-privilege app role + grants
  db/pool.ts                 app pool (DATABASE_URL) + owner migrate (ADMIN_DATABASE_URL)
  core/catalog/events.ts     opaque event constructors + EVENT_REGISTRY
  core/catalog/reducer.ts    pure, cutoff-aware fold -> OPERATIONAL projection only
  core/catalog/authority.ts  CatalogAuthority — the SOLE mutator
  core/redaction/noleak.ts   typed per-event payload schemas + generic signature scanner
test/run.ts                  the Phase 1 suite (19 checks)
```

## Boundaries (enforced)

- `CatalogAuthority` is the only writer of `items` / `provider_refs` (static test).
- `apply(event)` is the single mutator; commands author events and route through it.
- **Typed payloads.** Each event type has a payload schema; `op` must be a member of a
  fixed ref-type enum, `weight` a bounded int. Identity cannot be smuggled into the log.
- **Append-only, two layers.** Triggers reject UPDATE / non-prune DELETE / TRUNCATE on
  `events`; the runtime `app` role holds only SELECT+INSERT on `events` and cannot disable
  the triggers. Pruning is exposed only via a `SECURITY DEFINER` function.
- **Coordinated maintenance.** Writers take a *shared* advisory lock; rebuild/prune take
  the *exclusive* one, so they never interleave.
- **Deterministic rebuild** with an explicit `cutoff`; restores operational state only,
  identity stays NULL. `pruneAndRebuild` does prune+refold in one transaction.
- **Forget is terminal**: a re-`addItem` is rejected; `restore()` is the only reversal.
- The catalog core imports nothing about providers / HTTP / adapters / Hermes (static test).

## Erasure scope (important)

`forget` performs **logical erasure**: it removes all content identity from the live
projection and keeps every event opaque. It does **not** by itself erase PostgreSQL's
physical history (dead tuples, WAL, replicas, prior backups). True cryptographic erasure
(per-item identity keys, key destruction on forget) is a **Phase 2** design item and is
deliberately out of scope here.

## Not in this slice

No provider adapter (mock or real), no Plex/Jellyfin/RD/TorBox, no Hermes, no HTTP, no
job queue, no frontend.
