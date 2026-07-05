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
| `ops:evidence-rehearsal [-- -- --json]` | static, redaction-safe checklist for the expected Phase 22/23 evidence artifact shape; advisory only |
| `ops:custodian-evidence-preflight -- -- <descriptor.json> [--json]` | static, redaction-safe Phase 28 descriptor preflight for O4 evidence review; reads one descriptor file only and does not close O4 |
| `ops:kek-evidence-preflight -- -- <descriptor.json> [--json]` | static, redaction-safe O5 KEK custody/scheduling evidence preflight; reads one descriptor file only and does not close O5 |
| `ops:torbox-smoke-readiness-preflight -- -- <descriptor.json> [--json]` | static, redaction-safe TorBox smoke readiness descriptor preflight; reads one descriptor file only and does not authorize live smoke |
| `ops:torbox-live-smoke-evidence-preflight -- -- <phase-43-report.json> [--json]` | static, redaction-safe Phase 43 live-smoke evidence report preflight; reads one report file only and does not contact TorBox |
| `ops:torbox-live-smoke-summary-pack -- -- <phase-43-report.json>... [--json]` | static, redaction-safe Phase 43 live-smoke summary pack; reads explicit report files only and does not contact TorBox |
| `ops:torbox-live-smoke-review-gate -- -- <phase-49-summary-pack.json> [--json]` | static, redaction-safe Phase 49 summary review gate; reads one summary file only and does not close live-smoke review |
| `ops:torbox-live-smoke-operator-packet [-- -- --json]` | static, redaction-safe run/save/review packet for Phase 43, 44, 49, and 51 live-smoke artifacts; placeholders only, executes nothing |
| `ops:torbox-live-smoke-packet-manifest -- -- <packet-manifest.json> [--json]` | static, redaction-safe Phase 53 retained-packet manifest preflight; reads one manifest file only and does not scan artifacts |
| `ops:torbox-live-smoke-acceptance-record -- -- <acceptance-record.json> [--json]` | static, redaction-safe Phase 54 live-smoke acceptance-record preflight; records accepted/rejected/deferred without enabling provider mode |
| `ops:torbox-live-smoke-plan [-- --json]` | static, redaction-safe TorBox live-smoke operator command plan; placeholders only, executes nothing |
| `ops:provider-availability-summary -- -- <bridge-report.json>... [--json]` | static, redaction-safe Phase 58 provider availability summary; reads explicit sanitized bridge reports only |
| `ops:provider-availability-operator-packet [-- --json]` | static, redaction-safe Phase 59 provider availability evidence/review packet; executes nothing |
| `ops:release-guard -- -- --base <ref> [--head <ref>] [--tag <tag>] [--mode pre-pr\|pre-merge\|post-merge]` | static, advisory coordinator release guard for Phase 24 handoffs; read-only Git inspection only, never approval |

- **Docker Compose:** `docker-compose.deploy.yml` (keystore on a volume separate from the DB and
  backups; secrets via `*_FILE`; healthchecked Postgres).
- **Unraid:** `deploy/unraid-catalog-authority.xml` (Community-Applications template for the
  one-shot ops container; no ports/UI).
- **Start here — the authoritative production readiness gate:**
  **`docs/PHASE_22_PRODUCTION_READINESS_GATE.md`** — one consolidated checklist (9 criteria, each
  marked met / operator-provided / deferred / blocked, with the in-repo evidence source). Read it before
  claiming production readiness. Package operator evidence with
  **`docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md`**; coordinators should use
  **`docs/PHASE_24_COORDINATOR_RELEASE_GATE.md`** for future phase release gates, with advisory support
  from **`docs/PHASE_27_RELEASE_GUARD.md`** / `ops:release-guard`. Phase 28 adds the static
  **`docs/PHASE_28_PRODUCTION_CUSTODIAN_CONTRACT.md`** descriptor contract for future production
  custodians; it is metadata-only and does not close O4. Phase 29 adds
  **`docs/PHASE_29_CUSTODIAN_EVIDENCE_PREFLIGHT.md`** / `ops:custodian-evidence-preflight` to preflight
  one descriptor JSON file before evidence review; it also does not close O4. Phase 30 adds
  **`docs/PHASE_30_KEK_EVIDENCE_PREFLIGHT.md`** / `ops:kek-evidence-preflight` to preflight one
  descriptor JSON file before O5 KEK custody/scheduling evidence review; it does not close O5. Phase 31 adds
  **`docs/PHASE_31_TORBOX_BOUNDARY.md`** / `test:torbox-boundary` as static TorBox boundary research
  only: no live TorBox, no SDK dependency, no downloading, no playback, no provider mode, and no
  token/API-key handling. Phase 32 adds **`docs/PHASE_32_FAKE_TORBOX_ADAPTER.md`** /
  `test:torbox-fake-adapter` as a local fake contract only; it does not prove real TorBox works and
  keeps the real client separately gated. Phase 33 adds
  **`docs/PHASE_33_TORBOX_REAL_CLIENT_GATE.md`** / `test:torbox-real-client-gate` as a design gate,
  not a live client: injected transport only, no SDK dependency, no ADAPTER_MODE wiring, and any
  future real client must be separately authorized/reviewed. Phase 34 adds
  **`docs/PHASE_34_TORBOX_READONLY_FIXTURE.md`** / `test:torbox-readonly-client` as an injected
  in-memory fixture transport client only: no live TorBox calls, no SDK dependency, no ADAPTER_MODE
  wiring, and no proof that real TorBox works. Phase 35 adds
  **`docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md`**,
  **`docs/templates/TORBOX_SMOKE_EVIDENCE.md`**,
  **`docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md`**, and `test:torbox-smoke-evidence` as operator-run
  smoke evidence design and future UI-readiness examples only: no live transport, no runtime UI, no
  SDK dependency, no ADAPTER_MODE wiring, and O4/O5 remain open/deferred. Phase 36 adds
  **`docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md`** / `test:torbox-live-smoke-contract` as the
  acceptance contract for a future opt-in live smoke command: no live transport, no operator CLI, no
  SDK dependency, no ADAPTER_MODE wiring, no provider writes, and no CI/live-network requirement.
  Phase 37 adds **`docs/PHASE_37_TORBOX_SMOKE_CLI_SHELL.md`** / `smoke:torbox-readonly` /
  `test:torbox-smoke-cli` as a refused-by-default operator CLI shell only: it performs local
  preflight/reporting, stays out of CI, attaches no live transport, and exits before TorBox contact.
  Phase 38 adds **`docs/PHASE_38_TORBOX_SMOKE_FIXTURE_HARNESS.md`** / `test:torbox-smoke-fixture`
  as deterministic local fixture execution for that shell: no live transport, no SDK, no env reads,
  no network, no provider mode, and no proof that real TorBox works. Phase 39 adds
  **`docs/PHASE_39_TORBOX_TRANSPORT_ACCEPTANCE.md`** / `test:torbox-transport-acceptance`
  as a deterministic transport acceptance harness for future reviewed transports: injected local
  fixtures only, no live transport, no SDK, no env reads, no network, no provider mode, and no proof
  that real TorBox works. Phase 40 adds
  **`docs/PHASE_40_TORBOX_SMOKE_READINESS_PREFLIGHT.md`** /
  `ops:torbox-smoke-readiness-preflight` / `test:torbox-smoke-readiness-preflight` as a
  redaction-safe one-file descriptor preflight before any future TorBox operator smoke readiness
  review; it does not authorize live smoke. Phase 41 adds
  **`docs/PHASE_41_TORBOX_ENDPOINT_MAPPING.md`** / `test:torbox-endpoint-mapping` as a static
  endpoint mapping review for the first future read-only live-smoke surface: official-source mapping
  only, GET-only first-smoke cache/status/hoster routes, no live transport, no SDK, no env reads, no
  provider mode, and no live-smoke authorization. Phase 42 adds
  **`docs/PHASE_42_TORBOX_LIVE_TRANSPORT.md`** / `src/ops/torbox-live-transport.ts` /
  `test:torbox-live-transport` as the first live-capable, injected-fetch TorBox transport for a
  future operator smoke: GET-only reviewed endpoints, bearer-header cache auth, no SDK, no env/secret
  reads, no `globalThis.fetch` construction in the module, no `ADAPTER_MODE` wiring, no provider
  mode, and no proof that TorBox works against a real account. Phase 43 adds
  **`docs/PHASE_43_TORBOX_LIVE_SMOKE_CLI.md`** / `test:torbox-live-smoke-cli` as the explicit
  operator-run live smoke wiring for `smoke:torbox-readonly`: all preflight gates must pass, credentials
  come only from `--credential-file`, evidence is redaction-safe fixed categories/counts only, and the
  command remains absent from CI with no provider-mode, downloading, playback, or adapter-factory wiring.
  Phase 44 adds **`docs/PHASE_44_TORBOX_LIVE_SMOKE_EVIDENCE_PREFLIGHT.md`** /
  `ops:torbox-live-smoke-evidence-preflight` / `test:torbox-live-smoke-evidence-preflight` as a
  static one-file verifier for saved Phase 43 JSON reports; it does not contact TorBox, read
  credentials, or close live-smoke review. Phase 45 adds
  **`docs/PHASE_45_TORBOX_LIVE_SMOKE_OPERATOR_PLAN.md`** / `ops:torbox-live-smoke-plan` /
  `test:torbox-live-smoke-plan` as a deterministic placeholder-only operator command plan; it
  executes nothing and adds no live network, credential reads, provider mode, downloading, or playback.
  Phase 46 adds **`docs/PHASE_46_TORBOX_PROVIDER_READONLY_ADAPTER.md`** /
  `src/core/adapters/torbox-provider-adapter.ts` / `test:torbox-provider-adapter` as the first
  TorBox provider-mode wiring: read-only advisory availability only, explicit injected transport
  only, no live transport construction in core, no env/credential reads, no SDK, no provider writes,
  no downloading, and no playback. Phase 47 adds
  **`docs/PHASE_47_TORBOX_CATALOG_BRIDGE.md`** / `test:torbox-catalog-bridge` as deterministic
  catalog-bridge acceptance for persisted `infohash` refs through `withProviderRef()` and the
  injected TorBox adapter; it writes no events/provider refs and adds no live TorBox, credential,
  download, playback, UI, or provider-write path. Phase 48 adds
  **`docs/PHASE_48_TORBOX_SMOKE_COMMAND_PLAN_FIX.md`** as a static correction to the live-smoke
  command plan: generated smoke command shapes now use `npm run --silent ... -- -- ...` so npm does
  not consume smoke flags or add headers to redirected JSON. Phase 49 adds
  **`docs/PHASE_49_TORBOX_LIVE_SMOKE_SUMMARY_PACK.md`** / `ops:torbox-live-smoke-summary-pack` /
  `test:torbox-live-smoke-summary-pack` to summarize explicit Phase 43 report files into fixed,
  redaction-safe review labels without echoing paths, credentials, raw refs, provider payloads, or
  account/media details. Phase 50 adds **`docs/PHASE_50_TORBOX_LIVE_SMOKE_LABEL_CONTRACT.md`** /
  `test:torbox-live-smoke-labels` so Phase 43 report production, Phase 44 preflight, and Phase 49
  summaries share one fixed label contract. Phase 51 adds
  **`docs/PHASE_51_TORBOX_LIVE_SMOKE_REVIEW_GATE.md`** / `ops:torbox-live-smoke-review-gate` /
  `test:torbox-live-smoke-review-gate` to verify a Phase 49 summary has the required service-status
  and hoster-metadata ready probes without contacting TorBox or closing review. Phase 52 adds
  **`docs/PHASE_52_TORBOX_LIVE_SMOKE_OPERATOR_PACKET.md`** /
  `ops:torbox-live-smoke-operator-packet` / `test:torbox-live-smoke-operator-packet` to tie the
  Phase 43 live reports, Phase 44 preflights, Phase 49 summary, and Phase 51 review gate into one
  redaction-safe operator packet without executing commands. Phase 53 adds
  **`docs/PHASE_53_TORBOX_LIVE_SMOKE_PACKET_MANIFEST.md`** /
  `ops:torbox-live-smoke-packet-manifest` / `test:torbox-live-smoke-packet-manifest` to preflight
  one retained-packet manifest without reading artifact contents or scanning directories. Phase 54 adds
  **`docs/PHASE_54_TORBOX_LIVE_SMOKE_ACCEPTANCE_RECORD.md`** /
  `ops:torbox-live-smoke-acceptance-record` / `test:torbox-live-smoke-acceptance-record` to record
  accepted/rejected/deferred live-smoke review disposition without enabling provider mode.
  Rehearse the evidence
  package shape with
  **`docs/PHASE_25_READINESS_REHEARSAL.md`** and **`docs/PHASE_26_EVIDENCE_REHEARSAL.md`** before a
  real readiness review. The docs
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
  `docs/PHASE_26_EVIDENCE_REHEARSAL.md` (static evidence package shape check) ·
  `docs/PHASE_27_RELEASE_GUARD.md` (advisory release-guard command) ·
  `docs/PHASE_28_PRODUCTION_CUSTODIAN_CONTRACT.md` (static production custodian descriptor contract) ·
  `docs/PHASE_29_CUSTODIAN_EVIDENCE_PREFLIGHT.md` (static O4 descriptor preflight command) Â·
  `docs/PHASE_32_FAKE_TORBOX_ADAPTER.md` (local fake TorBox adapter contract) Â·
  `docs/PHASE_33_TORBOX_REAL_CLIENT_GATE.md` (TorBox real-client design gate; no live client) Â·
  `docs/PHASE_34_TORBOX_READONLY_FIXTURE.md` (TorBox injected-transport fixture; no live client) Â·
  `docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md` (operator-run smoke evidence design; no live transport) Â·
  `docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md` (future operator UI examples; no frontend code) Â·
  `docs/PHASE_61_OPERATOR_UI_PACKET_CONTRACT.md` (static redaction-safe operator UI packet contract) Â·
  `docs/PHASE_63_STATIC_OPERATOR_UI_PROTOTYPE.md` (read-only static operator UI prototype) Â·
  `docs/PHASE_65_STATIC_UI_ARTIFACT_PACKAGING.md` (static operator UI artifact packaging) Â·
  `docs/PHASE_67_OPERATOR_UI_LAUNCH_READINESS.md` (operator UI launch readiness gate) Â·
  `docs/PHASE_68_OPERATOR_UI_RUNTIME_BOUNDARY.md` (local operator UI runtime boundary plan) Â·
  `docs/PHASE_69_OPERATOR_UI_PACKET_SOURCE_CONTRACT.md` (sanitized local operator packet source contract) Â·
  `docs/PHASE_3_DEPLOYMENT.md`.

Rollback is **restore-the-pre-upgrade-backup** (no down-migrations). Open production gates remain
**O4** (managed-KMS adapter) and **O5** (managed age KEK custody/scheduling); `CUSTODIAN_MODE=memory`
is refused in production. Phase 16 defines the external custodian acceptance boundary and O4 evidence
requirements in `docs/PHASE_16_EXTERNAL_CUSTODIAN_READINESS.md`: `FileCustodian` is still a hardened
reference harness, live external custodian validation is operator-run, and CI must not require a live
KMS/cloud service. Phase 21 adds the importable contract kit
(`test/helpers/custodian-contract-kit.ts`) and deterministic local acceptance suite
(`npm run test:custodian-acceptance`) for future adapters; it does not close O4. Phase 28 adds
`src/core/crypto/production-custodian-contract.ts` and `npm run test:production-custodian-contract`
so future adapter metadata can be checked without secrets, live services, or claiming O4 closure.
Phase 29 adds `ops:custodian-evidence-preflight` for one-file descriptor JSON preflight before
review; it is redaction-safe, descriptor-only, and also leaves O4 open/deferred.
Phase 30 adds `ops:kek-evidence-preflight` for one-file descriptor JSON preflight before O5 KEK
custody/scheduling evidence review; it is redaction-safe, descriptor-only, and leaves O5
open/deferred.
Phase 17 adds
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
to the event log. `ADAPTER_MODE=fake|none` from env (unknown fails closed); `torbox-readonly` is
available only through explicit injected transport configuration and fails closed if requested from
env alone. See `docs/PHASE_7_ADAPTER_BOUNDARY.md`.

Provider availability policy (Phase 55) now lives in
`src/core/adapters/provider-availability-policy.ts`. It converts advisory adapter results into fixed
redaction-safe routing decisions: `available` becomes `candidate`, `unavailable` becomes `skip`, and
`unknown`/stale/invalid results become `hold`. The policy remains advisory-only, persists nothing,
and never echoes provider locators, details, raw refs, URLs, credentials, item ids, or media identity.
See `docs/PHASE_55_PROVIDER_AVAILABILITY_POLICY.md`.
Provider availability bridge (Phase 56) now lives in
`src/core/adapters/provider-availability-bridge.ts`. It wraps one scoped adapter lookup and returns
only sanitized adapter status plus the Phase 55 policy decision; locator/detail payloads are not
echoed, and the bridge remains non-persistent and advisory-only.
See `docs/PHASE_56_PROVIDER_AVAILABILITY_BRIDGE.md`.
Provider availability summary (Phase 57) now lives in
`src/core/adapters/provider-availability-summary.ts`. It aggregates sanitized bridge reports into
fixed counts and readiness labels only, with no item rows, provider detail, raw refs, credentials,
URLs, media identity, persistence, or UI/runtime behavior.
See `docs/PHASE_57_PROVIDER_AVAILABILITY_SUMMARY.md`.
Provider availability summary CLI (Phase 58) adds `ops:provider-availability-summary`, a bounded
operator command that reads explicit bridge-report JSON files only and emits the same count-only
summary without path, provider detail, raw ref, credential, URL, item, media identity, or payload
echo.
See `docs/PHASE_58_PROVIDER_AVAILABILITY_SUMMARY_CLI.md`.
Provider availability operator packet (Phase 59) adds
`ops:provider-availability-operator-packet`, a static run/retain/review packet for sanitized bridge
reports and Phase 58 count summaries. It is guidance only, executes nothing, and preserves the no UI,
no provider contact, no persistence, and no provider-mode-expansion boundaries.
See `docs/PHASE_59_PROVIDER_AVAILABILITY_OPERATOR_PACKET.md`.

Phase 31 adds `docs/PHASE_31_TORBOX_BOUNDARY.md` and `src/core/adapters/torbox-boundary.ts` as a
static TorBox capability/redaction contract based on official TorBox docs/SDK surfaces. It names
cache/status/hoster capabilities for later review and explicitly future-gates create-download and
request-download-link flows. It is not a real TorBox adapter: no live TorBox, no SDK dependency, no
downloading, no playback, no provider mode, no env secret reads, and no adapter factory mode. The
Phase 32 local fake contract now lives in `src/core/adapters/fake-torbox-adapter.ts` and
`docs/PHASE_32_FAKE_TORBOX_ADAPTER.md`; it implements `ProviderAdapter` for direct tests only,
supports scoped infohash/hash-digest/link-derived-digest/NZB-derived-digest refs, returns advisory
available/unavailable/unknown results, and is not wired into `ADAPTER_MODE`. It does not prove real
TorBox works. Create/download-link/token-query flows remain future-gated/high risk, and any real
client remains a separately gated real client. Phase 33 adds
`src/core/adapters/torbox-real-client-gate.ts` and
`docs/PHASE_33_TORBOX_REAL_CLIENT_GATE.md` as a design gate, not a live client: injected transport
only, no SDK dependency, no ADAPTER_MODE wiring, live smoke must be operator-run outside CI, and a
future real client must be separately authorized/reviewed. Phase 34 adds
`src/core/adapters/torbox-readonly-client.ts` and
`docs/PHASE_34_TORBOX_READONLY_FIXTURE.md` as an injected-transport fixture client for read-only
request mapping and fail-closed fixture parsing only. It uses an in-memory test transport, makes no
live TorBox calls, does not prove real TorBox works, and adds no ADAPTER_MODE wiring. Phase 35 adds
`docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md`, `docs/templates/TORBOX_SMOKE_EVIDENCE.md`, and
`docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md` as operator-run smoke evidence design and future
operator-dashboard examples only. It adds no TorBox transport, SDK, provider mode, HTTP service,
frontend runtime, playback, or download behavior. Phase 36 adds
`docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md` as the required future live-smoke acceptance order:
explicit authorization, out-of-CI opt-in, read-only confirmation, secret indirection, bounded
timeouts, redaction, injected reviewed transport only, and Phase 35-shaped evidence before any
later implementation may contact TorBox. Phase 37 adds `src/ops/torbox-smoke-cli.ts` and
`src/ops/torbox-smoke-shell.ts` as a refused-by-default `smoke:torbox-readonly` shell. It is
operator-run only, not in CI, has no live transport, does not read env/secret files, and reports only
fixed gates/categories/counts before exiting without TorBox contact.
Phase 38 adds explicit `--fixture available|unavailable|unknown|auth|quota|timeout|parse|ambiguous-response`
handling for deterministic local output. Fixture mode never contacts TorBox and does not prove real
TorBox availability. Phase 39 adds `src/ops/torbox-transport-acceptance.ts` and
`docs/PHASE_39_TORBOX_TRANSPORT_ACCEPTANCE.md` as a deterministic transport acceptance harness for
future reviewed transports. It uses injected local fixtures only, does not add a live TorBox
transport, and does not prove real TorBox availability. Phase 40 adds
`ops:torbox-smoke-readiness-preflight` as a static descriptor preflight for future operator smoke
readiness review. It reads one JSON descriptor file, emits fixed redaction-safe findings, does not
call TorBox, and does not authorize live smoke. Phase 41 adds
`docs/PHASE_41_TORBOX_ENDPOINT_MAPPING.md` as a static official-source endpoint mapping review for
the first future read-only smoke surface. It allows only GET-first cache/status/hoster mapping for a
later reviewed transport and keeps request-download-link, token-query, CDN/permalink URL, metadata
lookup, user-data, downloading, and playback flows future-gated. Phase 42 adds
`src/ops/torbox-live-transport.ts` as a live-capable injected transport for that reviewed surface.
It normalizes provider responses to fixed availability/categories, never returns raw provider
payloads, does not read env or secret files, and remains detached from adapter factory/provider mode.
Phase 43 wires that transport into the operator-only `smoke:torbox-readonly -- --live-smoke
--live-transport ...` path after fail-closed preflight gates. The CLI reads one explicit credential
file, attaches global fetch only there, keeps live smoke out of CI, and emits no credential values,
credential file paths, raw refs, endpoint URLs, or provider response bodies.
Phase 44 adds `ops:torbox-live-smoke-evidence-preflight` to verify one saved Phase 43 JSON report
before retention or review. It is static and redaction-safe: no live TorBox call, no credential-file
read, no env read, no provider mode, no downloading, and no playback.
Phase 45 adds `ops:torbox-live-smoke-plan`, a static command plan for the operator sequence from
readiness metadata through Phase 43 smoke and Phase 44 report preflight. It prints placeholders only
and executes nothing.
Phase 46 adds `src/core/adapters/torbox-provider-adapter.ts` and
`docs/PHASE_46_TORBOX_PROVIDER_READONLY_ADAPTER.md` as read-only provider-mode wiring over the
reviewed injected transport contract. The factory can create it only from explicit transport config;
the env-only path fails closed, core constructs no live transport, and request-download-link,
provider writes, UI, and playback remain blocked.
Phase 47 adds `docs/PHASE_47_TORBOX_CATALOG_BRIDGE.md` and `test:torbox-catalog-bridge` to prove the
TorBox adapter through `CatalogAuthority.withProviderRef()` using encrypted persisted `infohash`
refs and a local injected transport fixture. It is advisory-only, writes no catalog events or
provider-ref rows, and keeps live validation operator-run.
Phase 56 adds `src/core/adapters/provider-availability-bridge.ts` and
`docs/PHASE_56_PROVIDER_AVAILABILITY_BRIDGE.md` so scoped adapter results are immediately classified
through the Phase 55 policy and sanitized before future orchestration can inspect them.
Phase 57 adds `src/core/adapters/provider-availability-summary.ts` and
`docs/PHASE_57_PROVIDER_AVAILABILITY_SUMMARY.md` for count-only summaries of sanitized bridge
decisions.
Phase 58 adds `ops:provider-availability-summary` for explicit-file, count-only aggregation of
sanitized bridge reports.
Phase 59 adds `ops:provider-availability-operator-packet` for static evidence/review packaging
before any future dashboard consumes provider availability counts.
Phase 61 adds `src/ops/operator-ui-packet-contract.ts` and `test:operator-ui-packet-contract` as a
static allowlisted packet contract for future operator UI screens. It renders no UI, reads no DB,
files, env, or network, exposes only synthetic labels, and keeps provider availability advisory and
count-only.
Phase 62 adds `src/ops/operator-ui-fixtures.ts`, `docs/PHASE_62_OPERATOR_UI_FIXTURES.md`, and
`test:operator-ui-fixtures` as deterministic operator UI fixture packets for those nine screens.
They are static fixture data only, validate through the Phase 61 contract, render no UI, read no DB,
files, env, or network, and preserve the same advisory/count-only provider availability boundary.
Phase 63 adds `src/ops/operator-ui-static-prototype.ts`,
`docs/PHASE_63_STATIC_OPERATOR_UI_PROTOTYPE.md`, `ops:operator-ui-static-prototype`, and
`test:operator-ui-static-prototype` as a read-only static operator UI prototype generated from
Phase 62 fixture packets only. It adds no live app, server, framework, DB read, file/env read,
network call, provider control, playback, download, or streaming behavior.
Phase 64 adds `src/ops/operator-ui-render-allowlist.ts`,
`docs/PHASE_64_RENDER_ALLOWLIST_HARDENING.md`, and `test:operator-ui-render-allowlist` as a static
render allowlist evidence gate for that prototype. Rendered text must come only from Phase 61/62
allowlists plus fixed safe chrome, failures use fixed redaction-safe codes, and the boundary remains:
no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database read,
provider adapter, network call, env read, file read, browser JavaScript, browser storage, external
asset, remote font, provider control, playback, download, or streaming behavior.
Phase 65 adds `src/ops/operator-ui-static-artifact.ts`,
`docs/PHASE_65_STATIC_UI_ARTIFACT_PACKAGING.md`, `ops:operator-ui-static-artifact`, and
`test:operator-ui-static-artifact` as static operator UI artifact packaging for
`operator-ui-static-prototype.html`. It keeps the Phase 64 allowlist gate in front of packaging,
emits HTML only through stdout, keeps JSON evidence metadata-only, and remains fixture-only with:
no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database read,
provider adapter, network call, env read, file read, browser JavaScript, browser storage, external
asset, remote font, provider control, playback, download, or streaming behavior.
Phase 66 adds `docs/PHASE_66_STATIC_UI_LAYOUT_REFINEMENT.md` and
`test:operator-ui-static-layout` as a static UI layout refinement over the same fixture-only HTML
artifact. It improves the Graphite + Muted Orange appliance structure, keeps the Phase 64 allowlist
gate and Phase 65 artifact packaging gate required, and leaves any live or sanitized local packet
connection behind a future decision gate.
Phase 67 adds `src/ops/operator-ui-launch-readiness.ts`,
`docs/PHASE_67_OPERATOR_UI_LAUNCH_READINESS.md`, `ops:operator-ui-launch-readiness`, and
`test:operator-ui-launch-readiness` as a fixed synthetic operator UI launch readiness gate:
`static-preview` is `ready`, `local-readonly-ui` is `blocked/deferred`, and `live-product` is
`not-ready`. The fixture-only static preview can be generated/shared after Phase 64 and Phase 65
pass; local read-only UI is blocked/deferred pending explicit future authorization and design; live
product launch is not ready pending security/runtime/production gates. Live UI/API/runtime,
sanitized local packet source, and auth/access boundary are not implemented or authorized. Provider
availability remains packet/count/advisory only; O4 and O5 remain open/deferred; `FileCustodian`
remains a hardened reference harness, not production KMS.
Phase 68 adds `src/ops/operator-ui-runtime-boundary.ts`,
`docs/PHASE_68_OPERATOR_UI_RUNTIME_BOUNDARY.md`, `ops:operator-ui-runtime-boundary`, and
`test:operator-ui-runtime-boundary` as a fixed synthetic Local Operator UI Runtime Boundary Plan.
It keeps static preview as the only ready surface and states that local read-only runtime remains
blocked until Phase 69 plus source/auth/runtime designs are satisfied. Future runtime work must have
local-only bind/access posture, an operator access/auth boundary, and a read-only packet
endpoint/source with no direct DB access from UI. The exact JSON command is
`npm run --silent ops:operator-ui-runtime-boundary -- -- --json`. This adds no live UI server,
runtime UI, API route, browser JavaScript, DB read, env read, filesystem scan, network call,
provider execution, playback/download control, scraping, media-server logic, credentials, or live
packet ingestion. Provider availability remains packet/count/advisory only; O4 and O5 remain
open/deferred; `FileCustodian` remains a hardened reference harness, not production KMS.
Phase 69 adds `src/ops/operator-ui-packet-source-contract.ts`,
`docs/PHASE_69_OPERATOR_UI_PACKET_SOURCE_CONTRACT.md`,
`ops:operator-ui-packet-source-contract`, and `test:operator-ui-packet-source-contract` as a fixed
synthetic Sanitized Local Operator Packet Source Contract. Future local read-only UI packet sources
may only be immutable/read-only packet snapshots or an explicit sanitized local packet endpoint, and
both remain not implemented. Any future packet producer must sit behind explicit sanitization and
allowlist checks, emit only redaction-safe operator packets with synthetic labels, counts, and
statuses, and preserve the Phase 61 allowlists. The exact JSON command is
`npm run --silent ops:operator-ui-packet-source-contract -- -- --json`. The contract forbids direct
UI DB reads, raw event payloads, raw provider refs, titles, external IDs, provider names/logos,
infohashes, magnets, credentials, paths, artwork, user library data, provider/provider-mode direct
consumption, playback/download controls, scraping, media-server logic, and live packet ingestion.
Provider availability remains packet/count/advisory only; local read-only runtime remains blocked;
live product launch remains not ready; O4 and O5 remain open/deferred; `FileCustodian` remains a
hardened reference harness, not production KMS.
Phase 48 updates the static live-smoke operator plan command shapes to the copy/paste-safe npm form:
`npm run --silent smoke:torbox-readonly -- -- --live-smoke ...`.
Phase 49 adds `ops:torbox-live-smoke-summary-pack`, a local summary command for explicit Phase 43
report files. It validates each report with Phase 44 rules and emits only fixed probe labels,
categories, counts, readiness, and gate reminders.
Phase 50 centralizes the fixed live-smoke `probe`, `operation`, and `category` labels so Phase 43,
Phase 44, and Phase 49 cannot drift apart.
Phase 51 adds `ops:torbox-live-smoke-review-gate`, a local review-prep command for one Phase 49
summary pack. It checks required service-status and hoster-metadata readiness, keeps
cache-availability optional, and does not close live-smoke review.
Phase 52 adds `ops:torbox-live-smoke-operator-packet`, a static run/save/review workflow that
connects Phase 43 reports, Phase 44 preflights, the Phase 49 summary pack, and the Phase 51 review
gate into a redaction-safe packet for independent review.
Phase 53 adds `ops:torbox-live-smoke-packet-manifest`, a one-file retained-packet manifest preflight
that checks required redacted artifact kinds and optional cache pairing without reading artifacts,
scanning directories, or closing live-smoke review.
Phase 54 adds `ops:torbox-live-smoke-acceptance-record`, a one-file acceptance-record preflight for
recording independent-review disposition. It can mark TorBox live smoke accepted/rejected/deferred,
but does not enable provider mode or close O4/O5.

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

No Plex, no RD provider integration, no TorBox provider-mode integration, no Hermes, no HTTP daemon, no job queue, no frontend, and **no live network in
automated tests**. (Phases 7–13 add adapter *boundaries* + erasure policy + Jellyfin find/revoke/outbox +
smoke validation; Phase 31 adds TorBox boundary research only; Phase 32 adds a local fake TorBox
contract only; Phase 33 adds a TorBox real-client design gate only; Phase 34 adds an injected
fixture-transport read-only client only; Phase 35 adds operator-run TorBox smoke evidence and future
operator UI examples only; Phase 36 adds the future live-smoke acceptance contract only; Phase 37
adds the refused-by-default TorBox smoke CLI shell only; Phase 38 adds deterministic local fixture
execution only; Phase 39 adds deterministic local transport acceptance only; Phase 40 adds static
TorBox smoke readiness descriptor preflight only; Phase 41 adds static TorBox endpoint mapping review
only; Phase 42 adds a live-capable injected TorBox transport only, with no CI live network, provider-mode integration, downloading, or playback; real network is strictly operator-gated + smoke-validated; Phase 43 adds the operator-only TorBox live smoke CLI wiring for that transport, still outside CI and still detached from provider mode, downloading, and playback; Phase 44 adds static saved-report evidence preflight only, with no live network or credential reads; Phase 45 adds a static placeholder-only operator command plan, with no command execution.)
