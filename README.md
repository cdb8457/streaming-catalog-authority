# Catalog Authority — Phase 1 (DB-resident authority)

Event-sourced catalog authority core. **No** provider adapters, media servers, HTTP,
Hermes, job queues, or UI — by design. The core stands alone.

## Run

```bash
npm install      # downloads an embedded PostgreSQL 16 binary (no Docker needed)
npm run ci       # typecheck, then all suites: crypto (15) + authority (21) + SecretStore (4)
                 # + crypto-shred (15) + reconcile (9) + integration (9) = 73 passed
```

Tests boot a throwaway PostgreSQL 16 unless `DATABASE_URL` is already set.

### Against your own PostgreSQL 16 (or Docker Compose)

```bash
docker compose up -d postgres                 # provision postgres:16
docker compose logs -f postgres               # follow DB logs (Ctrl-C to stop)

export ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/catalog
export DATABASE_URL=postgresql://app:app@localhost:5432/catalog
npm run ci

# or run the suite fully inside containers, against the postgres service:
docker compose run --rm app npm test          # or: npm run ci

docker compose down                           # stop and remove containers
docker compose down -v                        # also drop the postgres volume
```

See `.env.example`. `ADMIN_DATABASE_URL` is the owner/migrator; `DATABASE_URL` is the
least-privileged runtime role.

## The authority lives in the database

The DB is the enforcement boundary, not a convention in TypeScript. Every mutation goes
through `SECURITY DEFINER` functions owned by the migrator (`cat_add_item`, `cat_restore`,
`cat_forget`, `cat_record_signal`, `cat_apply`, `cat_rebuild`, `cat_prune_and_rebuild`).
The runtime `app` role is granted only `SELECT` on the tables and `EXECUTE` on those
functions — it cannot insert events, write the projection, prune without rebuilding, or
disable the append-only triggers. The TypeScript `CatalogAuthority` is a typed client.

```
src/
  db/migrations.sql          tables + triggers + the whole authority (plpgsql) + role grants
  db/pool.ts                 app pool (DATABASE_URL) + owner migrate (ADMIN_DATABASE_URL)
  core/catalog/events.ts     types, EVENT_REGISTRY, mintItemId(), opaque-id check
  core/catalog/authority.ts  typed client over the cat_* functions
  core/redaction/noleak.ts   client-side fast-fail gate + generic signature scanner (Phase 2 logs)
test/run.ts                  the Phase 1 suite (21 checks)
```

## Guarantees (all tested)

- **Mutation only via the DB authority.** No TS writes the tables; the app role physically
  cannot bypass `CatalogAuthority` (raw insert / projection write / prune all denied).
- **Opaque ids.** `item_id` is a UUID, enforced in TS and by a DB `CHECK` — content cannot
  leak through the id channel.
- **No-leak gate on the exact stored value.** Payloads are validated post-serialize, so a
  client `toJSON()` cannot make validation and persistence disagree; `op` must be a member
  of a fixed ref-type enum; `weight` a bounded int.
- **Lifecycle enforced in the apply path.** Forget is terminal: re-add is rejected,
  `apply(ItemAdded)` on a forgotten item is rejected, forgetting an unknown id still
  creates a tombstone. `restore()` is the only reversal.
- **Append-only, two layers.** Triggers reject UPDATE / non-prune DELETE / TRUNCATE; the
  app role lacks the privileges to even attempt them.
- **Coordinated maintenance.** Writers take a shared advisory lock; rebuild/prune take the
  exclusive one. `pruneAndRebuild` is one atomic transaction with a single cutoff.
- **Deterministic rebuild** with explicit cutoff; restores operational state only, identity
  NULL; proven by a genuine fresh-DB replay.

## Erasure scope (Phase 2, crypto-shredding — Stage 2a)

Identity is now stored **only as ciphertext** (`items.identity_ct`, `provider_refs.ref_value_ct`),
encrypted in-process under a **per-item key** held by a key custodian. `forget` is a
coordinator: it clears the ciphertext and marks `shred_pending`, the custodian **irreversibly
destroys the key lineage**, then it marks `shred_complete`. After that, any surviving copy of
the ciphertext (dead tuples, WAL, replicas, backups) is permanently undecryptable — reads
fail closed when the custodian reports the key destroyed. `restore` after a completed shred
begins a fresh lineage and re-supplies identity (the old identity is gone, by design).

A reconciler completes interrupted shreds, promotes keys whose commit ack was lost, destroys
confirmed-orphan provisional keys (doing **nothing** when the DB is unreachable), and
self-heals an old-backup restore (a still-`active` row whose key is destroyed is re-driven
through forget). Completion requires an unforgeable HMAC **attestation** from the custodian.

The custodian is an interface. `InMemoryCustodian` is the dev/test impl; **`FileCustodian`** is
a durable reference production adapter (survives restart; overwrite+unlink irreversible delete;
durable non-secret tombstones; holds the completion secret outside the app DB). A managed KMS /
secrets service implementing the same interface drops in for production — FS-level overwrite is
only best-effort irreversibility; a managed KMS provides the real guarantee.

Status: Stage 2a (schema + coordinator + reads), Stage 2b (reconciler + winner-selection +
old-backup self-heal), and Stage 3a (production custodian adapter + integration suite) are
built and tested. The encrypted backup policy (Stage 3b) is pending.

## Not in this slice

No provider adapter (mock or real), no Plex/Jellyfin/RD/TorBox, no Hermes, no HTTP, no
job queue, no frontend.
