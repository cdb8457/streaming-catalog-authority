# Catalog Authority — Phase 1 (DB-resident authority)

Event-sourced catalog authority core. **No** provider adapters, media servers, HTTP,
Hermes, job queues, or UI — by design. The core stands alone.

## Run

```bash
npm install      # downloads an embedded PostgreSQL 16 binary (no Docker needed)
npm run ci       # typecheck, then all suites: crypto (15) + authority (21) + SecretStore (4)
                 # + crypto-shred (15) + reconcile (9) + integration (10) + backup (12) = 86 passed
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

- **Mutation only via the DB authority.** No app-path TS writes the tables; the app role
  physically cannot bypass `CatalogAuthority` (raw insert / projection write / prune all denied).
  The one documented exception is the owner-side backup **restore** (Stage 3b), which bypasses the
  append-only authority by design and is reachable only over the superuser/owner connection — never
  by the app role.
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
a durable reference **harness, not the production adapter** (survives restart; zeroize-replace
+ unlink of the wrapped DEK — best-effort, *not* a guaranteed physical block scrub, see below;
durable non-secret tombstones; holds the completion secret and KEK outside the app DB). A
managed KMS / secrets service implementing the same `KeyCustodian` interface is the production
target (design **O4**, still open) and provides the real deletion guarantee; swapping it in is a
constructor change.

The erasure guarantee does **not** depend on physically overwriting the DEK's disk blocks — an
atomic rename swaps in a new inode rather than scrubbing the old one in place. It depends on the
DEK being stored only **wrapped under the KEK**, the wrapped file being unlinked from the live
keystore, and the **keystore + KEK + completion secret being excluded from every main-DB backup**
(see Backup policy below). A surviving wrapped block is useless without the KEK.

Status: Stage 2a (schema + coordinator + reads), Stage 2b (reconciler + winner-selection +
old-backup self-heal), Stage 3a (durable reference custodian harness + integration suite), and
Stage 3b (encrypted backup/restore policy) are built and tested.

## Backup policy (Stage 3b)

Main-DB backups carry **ciphertext and key-control state only** — never decryptable key material.
`BackupPolicy` (`src/core/backup/backup-policy.ts`) dumps `events`, `items`, `provider_refs`,
`item_key_control`, and `aborted_operations`, and **deliberately excludes** the FileCustodian
keystore (wrapped DEKs), the KEK, and `crypto_config` (the completion secret). The dump runs in a
single `REPEATABLE READ` snapshot so the artifact is **point-in-time consistent** (a commit landing
mid-dump cannot tear `items`/`item_key_control` against `events`), and `restore` runs a
**post-load integrity gate** that **replays the events through the real reducer (`cat_rebuild`) and
compares** the resulting structural projection to the loaded one — rolling back
(`BackupIntegrityError`) if any item/provider-ref state is not derivable from the log. The backup
artifact must additionally be **encrypted at rest by the operator** (storage-level or a
`pg_dump | age`/`gpg` pipeline); confidentiality at rest is defense-in-depth, while the erasure
guarantee comes from the key-material exclusion above.

**External restore prerequisites (out-of-band, NOT in the backup):** restoring the main-DB
backup alone yields a *fail-closed* system. Before it is usable an operator must independently
(1) provision the **KEK** into the custodian and (2) set the **completion secret** into
`crypto_config` (matching the external custodian). Until both are supplied, reads fail closed and
shred completions cannot verify — by design.

Two invariants are proven by `test/backup.ts`: a restored backup **cannot resurrect shredded
identity** (the destroyed key's tombstone lives in the separate keystore; reads fail closed and
the reconciler re-drives `forget`), and **expired behavioral events do not return** after restore
(cutoff-aware projection + prune mean a restored event past its `expires_at` neither scores nor
survives a prune). See `docs/PHASE_2_BACKUP_POLICY.md`.

## Self-hosting / Unraid (Phase 3–5)

Deployment is **CLI/library only** — Postgres + on-demand one-shot ops containers, **no HTTP
service and no UI**. Operate it with `npm run ops:*` (or `docker compose run --rm ops <script>`):

| Command | What it does |
|---|---|
| `ops:init` | first run: migrate + provision the completion secret + self-check |
| `ops:doctor` | **read-only** production self-check (config, privileges, secret match, custodian, keystore); non-zero exit on any failure |
| `ops:migrate` | apply schema + grants (owner), idempotent |
| `ops:backup -- dump/restore <file>` | ciphertext-only backup / guarded restore (preflight + integrity gate) |
| `ops:rewrap-kek` | rotate the KEK (rewrap wrapped DEKs; resumable; identity untouched) |

- **Docker Compose:** `docker-compose.deploy.yml` (keystore on a volume separate from the DB and
  backups; secrets via `*_FILE`; healthchecked Postgres).
- **Unraid:** `deploy/unraid-catalog-authority.xml` (Community-Applications template for the
  one-shot ops container; no ports/UI).
- **Runbook:** `docs/PHASE_5_RUNBOOK.md` (backup/restore/rewrap, first-run, **disaster-recovery
  matrix**, interrupted-operation recovery). Deployment details: `docs/PHASE_3_DEPLOYMENT.md`.

Open production gates remain **O4** (managed-KMS adapter) and **O5** (age KEK rotation
*automation*); `CUSTODIAN_MODE=memory` is refused in production.

## Not in this slice

No provider adapter (mock or real), no Plex/Jellyfin/RD/TorBox, no Hermes, no HTTP, no
job queue, no frontend.
