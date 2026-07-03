# Catalog Authority — Phase 1 (DB-resident authority)

Event-sourced catalog authority core. **No** provider adapters, media servers, HTTP,
Hermes, job queues, or UI — by design. The core stands alone.

## Run

```bash
npm install      # downloads an embedded PostgreSQL 16 binary (no Docker needed)
npm run ci       # typecheck, then all suites (33 embedded-PostgreSQL suites); a green run = 0 failures
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

## Self-hosting / Unraid (Phase 3–6)

Deployment is **CLI/library only** — Postgres + on-demand one-shot ops containers, **no HTTP
service and no UI**. Operate it with `npm run ops:*` (or `docker compose run --rm ops <script>`):

| Command | What it does |
|---|---|
| `ops:init` | first run: migrate + provision the completion secret + self-check |
| `ops:migrate` | apply schema + grants (owner), idempotent; records the schema version |
| `ops:version` | db schema version vs this build (exit 1 on mismatch) |
| `ops:doctor [--json]` | **read-only** production self-check (config, schema version, runtime least-privilege, secret match, custodian, keystore, O4/O5 production gate WARN visibility); `--json` is the stable unattended-healthcheck contract; non-zero exit on any failure |
| `ops:backup -- dump/restore <file>` | ciphertext-only backup / guarded restore (preflight + integrity gate) |
| `ops:verify-backup -- <file>` | **offline** structural check of a backup artifact (no DB) |
| `ops:rehearse-restore -- <file>` | restore rehearsal into a throwaway `REHEARSAL_ADMIN_DATABASE_URL` (hard-refuses production) |
| `ops:rewrap-kek [-- --plan [--json]]` | plan or rotate the KEK (preflight counts; explicit rewrap is resumable; identity untouched) |
| `ops:readiness-plan [-- -- --json]` | static, redaction-safe rehearsal skeleton for the Phase 22/23 readiness evidence package; no live services or evidence scanning |

- **Docker Compose:** `docker-compose.deploy.yml` (keystore on a volume separate from the DB and
  backups; secrets via `*_FILE`; healthchecked Postgres).
- **Unraid:** `deploy/unraid-catalog-authority.xml` (Community-Applications template for the
  one-shot ops container; no ports/UI).
- **Start here — the authoritative production readiness gate:**
  **`docs/PHASE_22_PRODUCTION_READINESS_GATE.md`** — one consolidated checklist (9 criteria, each
  marked met / operator-provided / deferred / blocked, with the in-repo evidence source). Read it before
  claiming production readiness. Package operator evidence with
  **`docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md`**; coordinators should use
  **`docs/PHASE_24_COORDINATOR_RELEASE_GATE.md`** for future phase release gates. Rehearse the evidence
  package shape with **`docs/PHASE_25_READINESS_REHEARSAL.md`** before a real readiness review. The docs
  below are the gate's underlying sources.
- **Docs:** `docs/PHASE_6_LIFECYCLE.md` (upgrade/rollback, backup verification, restore + DR
  rehearsal, unattended healthcheck) · `docs/RELEASE_CHECKLIST.md` (operator checklist) ·
  `docs/PHASE_5_RUNBOOK.md` (backup/restore/rewrap + DR matrix) ·
  `docs/PHASE_19_PRODUCTION_READINESS_EVIDENCE.md` (redaction-safe evidence bundle) ·
  `docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md` (operator-owned schedules/retention) ·
  `docs/PHASE_21_EXTERNAL_CUSTODIAN_ACCEPTANCE.md` (external custodian acceptance harness) ·
  `docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md` (Phase 22 evidence packaging map) ·
  `docs/PHASE_24_COORDINATOR_RELEASE_GATE.md` (coordinator release gate) ·
  `docs/PHASE_25_READINESS_REHEARSAL.md` (static readiness rehearsal command) ·
  `docs/PHASE_3_DEPLOYMENT.md`.

Rollback is **restore-the-pre-upgrade-backup** (no down-migrations). Open production gates remain
**O4** (managed-KMS adapter) and **O5** (managed age KEK custody/scheduling); `CUSTODIAN_MODE=memory`
is refused in production. Phase 16 defines the external custodian acceptance boundary and O4 evidence
requirements in `docs/PHASE_16_EXTERNAL_CUSTODIAN_READINESS.md`: `FileCustodian` is still a hardened
reference harness, live external custodian validation is operator-run, and CI must not require a live
KMS/cloud service. Phase 21 adds the importable contract kit
(`test/helpers/custodian-contract-kit.ts`) and deterministic local acceptance suite
(`npm run test:custodian-acceptance`) for future adapters; it does not close O4. Phase 17 adds
`ops:rewrap-kek -- --plan` for redaction-safe, non-mutating KEK
rotation preflight; live rotation remains explicitly operator-run.
`ops:doctor` surfaces this explicitly: production file-custodian deployments WARN that O4 remains
open, and production deployments WARN that O5 managed KEK custody/scheduling remains open while
pointing to `ops:rewrap-kek -- --plan`.
For shareable production-readiness review, use
`docs/templates/PRODUCTION_READINESS_EVIDENCE.md`; it captures doctor, backup verification, restore
rehearsal, KEK rewrap-plan, and O4/O5 gate evidence without requesting secrets or raw identity.

## Provider adapter boundary (Phase 7)

The isolation layer for **future** provider/debrid adapters — **contracts + a local fake harness +
a privacy bridge + tests only** (no real providers, no network, no HTTP/UI). An adapter receives
**only** an opaque `itemId` + one scoped `{ refType, refValue }` (never catalog identity) through
`CatalogAuthority.withProviderRef()`, which decrypts a single ref, redacts it via the `SecretStore`
for the call and clears it after, and is fail-closed. Adapter output is **advisory** — never written
to the event log. `ADAPTER_MODE=fake|none` (unknown fails closed). See `docs/PHASE_7_ADAPTER_BOUNDARY.md`.

## Publisher adapter boundary (Phase 8)

The isolation layer for **future** identity-consuming publisher adapters (media-server sync) —
**contracts + a local fake harness + a scoped-identity bridge + tests only** (no real Plex/Jellyfin,
no network, no credentials, no persistence). A publisher **declares** the fields it needs and
`CatalogAuthority.withPublishableIdentity()` yields **only** those minimized fields
(`title`/`year`/`providerRefs` — never `externalIds`/`metadata`/ciphertext), redacted via the
`SecretStore` and cleared after; it is fail-closed and TOCTOU-hardened (forget mid-bridge fails
closed). **Dry-run is the default**; output is **advisory** (never persisted). `PUBLISHER_MODE=none|fake`.
⚠️ **Real external publishing conflicts with crypto-shredding** (a copy escapes the erasure boundary)
and is a **deferred policy gate**. See `docs/PHASE_8_PUBLISHER_BOUNDARY.md`.

## External-publishing erasure policy (Phase 9)

Publishing identity externally copies it **outside** the crypto-shredding boundary, so `forget`
can't reach it. Phase 9 makes future real publishing responsible (**fakes/local only**): a
**fail-closed consent gate** (`PUBLISH_EXTERNAL_IDENTITY=allow|deny`, default deny; dry-run always
allowed), an **identity-free `publish_ledger`** (opaque item id + target + opaque handle + disclosed
field **names** only — never values; owner-managed, app writes via `SECURITY DEFINER` only), and a
**best-effort revocation** flow: `forget` is unchanged, but a reconciliation queues a forgotten
item's published rows and a `RevocationAdapter` (fake) unpublishes each **opaque handle**, keeping
failures visible/retryable. See `docs/PHASE_9_ERASURE_POLICY.md`.

## Jellyfin publisher adapter (Phase 10 — fake/local only)

The first concrete media publisher target, **Jellyfin**, as **collection curation keyed on provider
refs** — a fake local client + config/redaction scaffolding, **no real network** (the real HTTP client
is **deferred to Phase 11**). The adapter discloses exactly `title` (collection name) + `providerRefs`
(match library items); the opaque **collection id** is the Phase 9 ledger handle. Deterministic
no-match: all-unmatched → `skipped`/no ledger row; partial → matched-only publish with counts; a ledger
row only when a handle is created. Revoke deletes the collection by opaque id (with documented limits —
Jellyfin's own logs/exports are beyond reach). `JELLYFIN_*` is parser/redaction scaffolding only (api
key redacted, never ledgered). A live publish still needs `PUBLISH_EXTERNAL_IDENTITY=allow`. See
`docs/PHASE_10_JELLYFIN_ADAPTER.md`.

## Real Jellyfin HTTP client (Phase 11 — gated, injected-fetch, find + revoke)

The real Jellyfin client over an **injected `fetch`** (no new dep), gated by `JELLYFIN_ENABLE_NETWORK`
(default off). It ships **real find + revoke** only; live collection **create is hard-disabled**
(deferred to **Phase 12's** durable publish-intent outbox — a remote create can't guarantee a captured
revocation handle under network failure, so allowing it could orphan an unrevocable external copy). The
api key is header-only (`X-Emby-Token`), redacted, never in URL/log/ledger/error. Per-request timeout +
**bounded** retry for idempotent search/delete, fail-closed. **No live server in CI** — every test injects
a fake transport, and the shared FIND contract passes for fake and real. Mapping is **provisional**,
validated only by the opt-in read-only `npm run smoke:jellyfin`. See `docs/PHASE_11_JELLYFIN_HTTP.md`.

## Durable publish-intent outbox (Phase 12 — orphan-safe live Jellyfin create)

Live Jellyfin create is now safe to enable — **only through a durable outbox**. A durable intent (opaque
`correlation_token`) is written **before** the create; the collection is **tagged with the token**; and
recovery is **by token, not by the response handle** — `reconcile()` searches Jellyfin for the token and
**adopts** the collection (or proves it gone), so every crash point ends tracked-or-gone (proven by a
crash matrix incl. *server-creates-then-response-lost-then-state-discarded*). `publish_ledger` is extended
(v3, still identity-free); `ops:doctor` surfaces stuck intents; `ops:publish-reconcile` repairs them. Live
create is **triple-gated** (`JELLYFIN_ENABLE_NETWORK` + `JELLYFIN_ALLOW_LIVE_PUBLISH` +
`PUBLISH_EXTERNAL_IDENTITY=allow`); the real endpoint mapping stays provisional/smoke-gated. See
`docs/PHASE_12_PUBLISH_OUTBOX.md`.

## Jellyfin endpoint validation (Phase 13)

The provisional Jellyfin mapping is validated by a **structured, opt-in smoke** — never in CI. A
**read-only** mode (`npm run smoke:jellyfin -- tmdb 603`) checks auth + the find mapping; a **destructive
`--write`** round-trip (gated by the flag **and** `JELLYFIN_ALLOW_LIVE_PUBLISH`) runs
`find → create token-tagged → find-by-token → delete → verify-gone`, **self-cleans**, and reports **loudly
if cleanup can't be confirmed**. `find-by-token` now filters BoxSet names **locally** (never trusts
`SearchTerm`, which could miss the marker → duplicate). Reports are redaction-safe (opaque ids/counts).
**Real publishing is not "proven" until the write smoke passes.** The find/lookup requests **paginate**
(`StartIndex`/`Limit`, bounded) so matches beyond Jellyfin's first page are never missed
(`docs/PHASE_14_JELLYFIN_HARDENING.md`). See `docs/PHASE_13_JELLYFIN_VALIDATION.md`.

## Jellyfin validation evidence (Phase 15)

Real Jellyfin validation evidence is an **operator-run** artifact, not a CI requirement. Phase 15 adds
the reviewable runbook and redaction-safe report template for read-only and write-capable smoke runs:
`docs/PHASE_15_JELLYFIN_VALIDATION_EVIDENCE.md` and
`docs/templates/JELLYFIN_VALIDATION_EVIDENCE.md`. Write validation remains mutating/destructive unless
cleanup is confirmed and requires both the explicit `--write` flag and
`JELLYFIN_ALLOW_LIVE_PUBLISH=true`; live Jellyfin validation stays out of CI.

## Not in this slice

No Plex, no RD/TorBox, no Hermes, no HTTP daemon, no job queue, no frontend, and **no live network in
automated tests**. (Phases 7–13 add adapter *boundaries* + erasure policy + Jellyfin find/revoke/outbox +
smoke validation; real network is strictly gated + smoke-validated.)
