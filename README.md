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

Deployment is Postgres + on-demand one-shot ops containers plus the Phase 147 read-only operator
API/UI service. Operate one-shot tasks with `npm run ops:*` (or `docker compose run --rm ops
<script>`) and run the UI through the Unraid `app` service on port `8099`.

| Command | What it does |
|---|---|
| `ops:init` | first run: migrate + provision the completion secret + self-check |
| `ops:migrate` | apply schema + grants (owner), idempotent; records the schema version |
| `ops:version` | db schema version vs this build (exit 1 on mismatch) |
| `ops:doctor [--json]` | **read-only** production self-check (config, schema version, runtime least-privilege, secret match, custodian, keystore, O4/O5 production gate WARN visibility); `--json` is the stable unattended-healthcheck contract; non-zero exit on any failure |
| `ops:backup -- dump/restore <file>` | ciphertext-only backup / guarded restore (preflight + integrity gate) |
| `ops:operator-ui-server -- --serve --host 0.0.0.0 --port 8099` | long-running read-only operator API/UI; `/api/status` and `/api/logs` require `X-Operator-UI-Secret` from `OPERATOR_UI_TOKEN_FILE` |
| `ops:verify-backup -- <file>` | **offline** structural check of a backup artifact (no DB) |
| `ops:rehearse-restore -- <file>` | restore rehearsal into a throwaway `REHEARSAL_ADMIN_DATABASE_URL` (hard-refuses production) |
| `ops:rewrap-kek [-- --plan [--json]]` | plan or rotate the KEK (preflight counts; explicit rewrap is resumable; identity untouched) |
| `ops:readiness-plan [-- -- --json]` | static, redaction-safe rehearsal skeleton for the Phase 22/23 readiness evidence package; no live services or evidence scanning |
| `ops:evidence-rehearsal [-- -- --json]` | static, redaction-safe checklist for the expected Phase 22/23 evidence artifact shape; advisory only |
| `ops:launch-gate-audit [-- -- --json]` | static Phase 83 audit for launch steps 1-3: O4/O5 production gates, operator rehearsal, and real TorBox/Jellyfin validation; no live services or evidence scanning |
| `ops:operator-acceptance-packet [-- -- --json]` | static Phase 84 operator-run acceptance packet for O4/O5, Unraid rehearsal, TorBox/Jellyfin validation, and launch-candidate decision; no live services or evidence scanning |
| `ops:launch-decision-record -- -- <decision-record.json> [--json]` | static Phase 85 launch-decision record preflight; reads one metadata record only and never approves launch, closes O4/O5, scans evidence, or contacts live services |
| `ops:launch-candidate-scope-freeze [--json]` | static Phase 86 launch-candidate scope-freeze packet; no launch approval, production-ready claim, O4/O5 closure, evidence scanning, or runtime/provider/UI expansion |
| `ops:launch-candidate-metadata-packet [--json]` | static Phase 87 launch-candidate metadata packet; retained labels and review questions only, with no approval, evidence reads, or runtime/provider/UI expansion |
| `ops:custodian-evidence-preflight -- -- <descriptor.json> [--json]` | static, redaction-safe Phase 28 descriptor preflight for O4 evidence review; reads one descriptor file only and does not close O4 |
| `ops:kek-evidence-preflight -- -- <descriptor.json> [--json]` | static, redaction-safe O5 KEK custody/scheduling evidence preflight; reads one descriptor file only and does not close O5 |
| `ops:o4-o5-evidence-decision -- -- --decision <decision.json> --custodian <o4-descriptor.json> --kek <o5-descriptor.json> [--json]` | static Phase 96 O4/O5 evidence decision packet; reads three explicit JSON files, authorizes only the offline contract-harness evidence slice, never contacts live services, and does not close O4/O5 |
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

- **Docker Compose:** `docker-compose.unraid.yml` is the repository-clone Unraid stack file
  (Postgres + one-shot ops + read-only operator `app`, appdata bind mounts, intentional
  `8099:8099` app port, local `build: .`).
  `docker-compose.unraid.runtime.yml` is the Arcane/launcher runtime variant that uses
  `${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}` instead of a build context, so it can later
  point at a published image without editing YAML. `docker-compose.deploy.yml` remains the
  generic/local deployment topology.
- **Unraid ops launcher:** `deploy/unraid-ops-launcher.sh` provides short Arcane/User Scripts
  commands for `start-postgres`, `status`, `migrate`, `doctor`, `backup`, and `rewrap-plan` using
  the runtime compose file.
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
  `docs/PHASE_70_LOCAL_STATIC_UI_RUNTIME_SHELL.md` (local static operator UI runtime shell) ·
  `docs/PHASE_71_STATIC_RUNTIME_HARDENING.md` (local static runtime hardening) -
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
Phase 97 adds `src/ops/operator-ui-preview-launch-packet.ts`,
`docs/PHASE_97_OPERATOR_UI_PREVIEW_LAUNCH_PACKET.md`,
`ops:operator-ui-preview-launch-packet`, and `test:operator-ui-preview-launch-packet` as a static
launch packet for the fixture-only preview. It keeps `remoteExposureAllowed: false`,
`liveDataAllowed: false`, and `providerContactAllowed: false`, documents local loopback preview plus
an operator-controlled SSH tunnel shape for Unraid, and blocks reverse-proxy/LAN exposure.
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
Phase 70 adds `src/ops/operator-ui-static-runtime.ts`,
`docs/PHASE_70_LOCAL_STATIC_UI_RUNTIME_SHELL.md`, `ops:operator-ui-static-runtime`, and
`test:operator-ui-static-runtime` as a Local Static Operator UI Runtime Shell. It intentionally
serves only the existing Phase 65 fixture-only static artifact over `127.0.0.1` after the Phase 64
render allowlist and Phase 65 artifact packaging gates. The exact start command is
`npm run ops:operator-ui-static-runtime -- --serve --host 127.0.0.1 --port 8787`. Without
`--serve`, the CLI prints boundary usage and starts no listener. Routes are fixed to `GET /` and
`GET /healthz`, with safe `404`/`405` handling and restrictive no-store/nosniff/CSP headers. Phase
68/69 boundaries remain visible: no live DB/provider/packet-source/API/playback/download/scraping/media-server behavior,
no frontend framework, no browser JavaScript, no file artifact read, no env/config read, no outbound
network call, and no sanitized packet endpoint implementation. Provider availability remains
packet/count/advisory only; O4 and O5 remain open/deferred; `FileCustodian` remains a hardened
reference harness, not production KMS.
Phase 71 adds `docs/PHASE_71_STATIC_RUNTIME_HARDENING.md` and
`test:operator-ui-static-runtime-hardening` as Local Static Runtime Hardening over that same shell.
It adds a pre-listen self-check against the Phase 64 allowlist inspection, retains the checked Phase
65 artifact in memory for repeated `/` responses, rejects `HEAD` with `Allow: GET`, keeps query
strings from creating route behavior, applies fixed safe headers on all response paths, adds
conservative server timeout/header limits, and closes the server on `SIGINT`/`SIGTERM`. The exact
runtime command remains `npm run ops:operator-ui-static-runtime -- --serve --host 127.0.0.1 --port
8787`. It still serves only the in-process Phase 65 static artifact behind the Phase 64 allowlist and
adds no API/data route, packet source, DB/provider/playback/download/scraping/media-server behavior.
O4 and O5 remain open/deferred; `FileCustodian` remains a hardened reference harness, not production
KMS.
Phase 72 adds `docs/PHASE_72_STATIC_RUNTIME_MANIFEST.md` and
`test:operator-ui-static-runtime-manifest` as a Local Static Runtime Manifest Endpoint over the same
hardened local static runtime. The only new route is `GET /manifest.json`, which returns fixed
deterministic JSON with `OPERATOR_UI_STATIC_RUNTIME_MANIFEST`, `local-static-fixture-preview`,
`fixture-only`, `not-implemented`, `static-preview-only`, `not-ready`, the fixed route list
`GET /`, `GET /healthz`, and `GET /manifest.json`, and boundary/gate strings for Phase 64, Phase
65, Phase 68, Phase 69, Phase 71, O4/O5, FileCustodian, and provider availability. `HEAD
/manifest.json` is rejected with `405`, `Allow: GET`, and an empty body; raw target bypass forms
around the manifest remain fixed `404`. The manifest is not a packet source and not a data API: it
adds no DB/provider/API data/playback/download/scraping/media-server/packet source behavior, no live
data, no env/config read, no filesystem scan or artifact-file read, no outbound network, no provider
call/integration, no credential handling, no sanitized packet endpoint, no frontend framework, and
no browser JavaScript. It contains no host data, paths, ports, timestamps, package versions, git
refs, content titles, provider names/logos, raw refs, infohashes, magnets, credentials, user library
data, poster art, streaming artwork, or raw event payloads. O4 and O5 remain open/deferred;
`FileCustodian` remains a hardened reference harness, not production KMS. Provider availability
remains packet/count/advisory only.
Phase 73 adds `docs/PHASE_73_OPERATOR_UI_ACCESS_BOUNDARY.md` and
`test:operator-ui-static-runtime-access-boundary` as an Operator Static Runtime Access Boundary over
that same local static runtime. The manifest now states fixed no-input access metadata:
`accessBoundary: loopback-only-fixture-preview`, `operatorAuth: not-implemented`,
`remoteExposure: blocked`, and `futureDataSurfacesRequire: explicit-auth-access-phase`. This is not
production auth and does not authorize reverse proxy or public exposure. It remains a loopback-only
fixture preview with no auth/session/cookie/token mechanism, no API route, packet endpoint, DB read,
provider integration, playback, download, scraping, media-server logic, TLS, or public bind. Future
packet or data surfaces require an explicit auth/access phase. O4 and O5 remain open/deferred;
`FileCustodian` remains a hardened reference harness, not production KMS. Provider availability
remains packet/count/advisory only.
Phase 74 adds `src/ops/operator-ui-auth-access-contract.ts`,
`docs/PHASE_74_OPERATOR_UI_AUTH_ACCESS_CONTRACT.md`, `ops:operator-ui-auth-access-contract`, and
`test:operator-ui-auth-access-contract` as an operator UI auth/access contract gate. It is fixed,
no-input, and contract-only with contract name `operator-ui-auth-access-contract`, version
`phase-74.v1`, status `not-implemented` / `contract-only`, current runtime exposure allowed only as
`127.0.0.1 fixture preview only`, and remote exposure `blocked until explicit future phase`. The
exact JSON command is `npm run --silent ops:operator-ui-auth-access-contract -- -- --json`. Future
review categories are labels only: `operator-local-secret-file`,
`reverse-proxy-forward-auth-attestation`, and `mTLS-or-local-network-attestation`. Before any packet
or data route, a future phase requires explicit Clint authorization and independent reviewer GO, no
public bind without a reviewed deployment/auth model, no direct DB reads from UI runtime, Sanitized
packet source only after Phase 69 contract and auth/access review, redaction-safe operator-facing
outputs, No credentials/tokens/cookies/session values in logs, docs, or evidence, and retained rate,
size, method, and raw-target fail-closed behavior. `/api/*`, `/packets`, `/login`, `/session`,
`/auth`, `/token`, `/callback`, `/logout`, `/oauth`, `/sso`, and `/admin` remain forbidden, as do
cookie/session/token/bearer/basic parsing, env/config/file secret reads,
TLS/reverse-proxy/public-bind implementation, frontend framework/browser JavaScript, DB/provider,
packet source, playback, download, scraping, and media-server logic. `GET /manifest.json` remains
the only manifest route; no runtime auth/data/provider/UI expansion is added. O4 and O5 remain
open/deferred; `FileCustodian` remains a hardened reference harness, not production KMS. Provider
availability remains packet/count/advisory only.
Phase 75 adds `src/ops/operator-ui-packet-endpoint-readiness.ts`,
`docs/PHASE_75_OPERATOR_UI_PACKET_ENDPOINT_READINESS.md`,
`ops:operator-ui-packet-endpoint-readiness`, and `test:operator-ui-packet-endpoint-readiness` as a
Sanitized Packet Endpoint Readiness Preflight. The operator UI packet endpoint readiness report is
fixed, no-input, and preflight-only with report name `operator-ui-packet-endpoint-readiness`,
version `phase-75.v1`, code `OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED`, and status
`not-ready` / `preflight-only`. The exact JSON command is
`npm run --silent ops:operator-ui-packet-endpoint-readiness -- -- --json`. Phase 69 packet source
contract exists but endpoint is not implemented; Phase 74 auth/access contract exists but auth is
not implemented; the static route surface remains only `GET /`, `GET /healthz`, and
`GET /manifest.json`; sanitized local packet endpoint remains blocked; direct UI DB reads remain
forbidden; Provider availability remains packet/count/advisory only; O4/O5 remain open/deferred
unless separately proven; and FileCustodian remains reference harness only. A future endpoint still
requires explicit Clint authorization and reviewer GO, auth/access implementation phase completed
and reviewed, endpoint source must consume only sanitized redaction-safe operator packets, no real
titles, external IDs, provider names/logos, raw refs, infohashes, magnets, credentials, paths,
artwork, user library data, or raw event payloads, no provider calls,
playback/download/scraping/media-server logic, direct DB access, or live packet ingestion,
route/method/body/raw-target hardening retained, size/rate bounds defined before endpoint exists,
and evidence/redaction tests added before any endpoint route is exposed. `/api/*`, `/packets`,
`/packet`, `/operator-packets`, `/data`, `/events`, `/catalog`, `/items`, `/auth`, `/login`,
`/session`, and `/token` remain forbidden, as do route handlers, API framework, DB/env/fs reads,
fetch/network calls, provider integration, browser JS/framework, cookies/sessions/tokens, and
runtime auth/data/provider/UI expansion.
Phase 76 adds `src/ops/operator-ui-packet-endpoint-limits.ts`,
`docs/PHASE_76_OPERATOR_UI_PACKET_ENDPOINT_LIMITS.md`,
`ops:operator-ui-packet-endpoint-limits`, and `test:operator-ui-packet-endpoint-limits` as a
Packet Endpoint Limits Contract. The operator UI packet endpoint limits report is fixed, no-input,
and contract-only with report name `operator-ui-packet-endpoint-limits`, version `phase-76.v1`,
code `OPERATOR_UI_PACKET_ENDPOINT_LIMITS_REPORTED`, and status `not-implemented` /
`contract-only`. The exact JSON command is
`npm run --silent ops:operator-ui-packet-endpoint-limits -- -- --json`.
`sanitized-local-packet-endpoint` remains `not-implemented`. Only GET may ever serve packet
snapshots in the first implementation; HEAD remains rejected unless explicitly reviewed; POST, PUT,
PATCH, DELETE, OPTIONS, and other methods rejected with fixed sanitized responses; request bodies
ignored/rejected and never echoed. Fixed limits are max request target bytes: 2048, max header count:
64, max request body bytes: 0, max response bytes: 262144, max packet count: 64, max string field
bytes: 256, and max array length per field: 64. Rate-limit contract data is loopback preview only,
max requests per minute per operator/runtime process: 60, burst size: 10, no remote/IP-based trust
yet, and no persistence/counters implemented in this phase. Future failures require fixed 404, fixed
405 with `Allow: GET` only after endpoint exists, fixed 413, fixed 429, and no echoing paths, query
strings, headers, body snippets, credentials, raw refs, packet contents, provider details, or DB
errors. Retained hardening includes raw target bypass closed, query strings cannot create behavior,
safe headers retained, no browser JS/framework requirement, no direct DB read, no provider calls, no
playback/download/scraping/media-server behavior, and no live packet ingestion. Phase 75 readiness
remains not-ready until endpoint/auth implementation and evidence tests exist; no packet
endpoint/runtime enforcement/auth/data/provider/UI expansion is added.
Phase 77 adds `src/ops/operator-ui-packet-endpoint-evidence-gate.ts`,
`docs/PHASE_77_OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE.md`,
`ops:operator-ui-packet-endpoint-evidence-gate`, and
`test:operator-ui-packet-endpoint-evidence-gate` as a Packet Endpoint Evidence Gate. The operator UI
packet endpoint evidence gate report is fixed, no-input, and blocked with report name
`operator-ui-packet-endpoint-evidence-gate`, version `phase-77.v1`, code
`OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE_REPORTED`, status `blocked` / `evidence-required`, and
`endpointExposure` `blocked` / `not-implemented`. The exact JSON command is
`npm run --silent ops:operator-ui-packet-endpoint-evidence-gate -- -- --json`. Phase 75 readiness
remains not-ready and Phase 76 limits remain contract-only and not-implemented. Future endpoint
exposure requires static runtime route-surface regression evidence proving only `GET /`, `GET
/healthz`, and `GET /manifest.json`; a reviewed local operator auth boundary; enforcement evidence
for request target, header, body, response, packet, string, and array limits; GET-only initial
endpoint behavior with HEAD rejected unless explicitly reviewed and POST, PUT, PATCH, DELETE,
OPTIONS, and OTHER receive fixed sanitized rejections; fixed 404, 405, 413, and 429 redaction
evidence; only a sanitized future packet producer may feed the endpoint with no direct DB,
provider, or raw-ref source; fixtures and synthetic packets only; endpoint tests covering oversized
target, header, body, response, method rejection, blocked route, raw-target bypass, and redaction
sentinel cases; independent reviewer GO; and a redaction-safe operator packet and review record.
Allowed future evidence artifacts are synthetic labels only, and forbidden evidence fields include
titles, external IDs, provider names/logos, raw refs, infohashes, magnets, URLs, credentials,
tokens, cookies, DB URLs, DB errors, request paths, query strings, headers, bodies, packet contents,
and artifact contents. No endpoint route handler, runtime auth implementation, API framework,
DB/env/fs reads, network calls, provider integration, frontend or browser JavaScript, packet
ingestion, or playback/download/scraping/media-server behavior is added.
Phase 78 adds `src/ops/operator-ui-packet-endpoint-route-dry-run.ts`,
`docs/PHASE_78_OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN.md`,
`ops:operator-ui-packet-endpoint-route-dry-run`, and
`test:operator-ui-packet-endpoint-route-dry-run` as a Packet Endpoint Route Dry-Run Plan. The
operator UI packet endpoint route dry-run report is fixed, no-input, and blocked with report name
`operator-ui-packet-endpoint-route-dry-run`, version `phase-78.v1`, code
`OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN_REPORTED`, status `blocked` / `dry-run-plan-only`, and
`routeExposure` `blocked` / `not-implemented`. The exact JSON command is
`npm run --silent ops:operator-ui-packet-endpoint-route-dry-run -- -- --json`. The candidate endpoint
is `sanitized-local-packet-endpoint` and the candidate route is the synthetic label
`future-local-packet-snapshot-route`, not an implemented path. The planned route is local loopback
only in a future phase and remains blocked now. GET only is the first planned method; HEAD remains
rejected unless explicitly reviewed; POST, PUT, PATCH, DELETE, OPTIONS, and OTHER rejected with
fixed sanitized responses. The dry-run plan keeps request body byte limit remains 0, request target
max 2048 bytes, max header count 64, max response 262144 bytes, max packet count 64, max string
field bytes 256, and max array length 64. The future rate preview is 60 requests/min per operator
runtime process, burst 10, loopback preview only, no remote/IP trust, and no counters implemented
now. Future failures require fixed 404, fixed 405 with Allow GET only after endpoint exists, fixed
413, and fixed 429, with no echoing paths, query strings, headers, bodies, credentials, raw refs,
packet contents, provider details, and DB errors. Phase 77 evidence gate must be satisfied and
independently reviewed before implementation. The acceptance matrix covers method matrix, size
matrix, rate preview, redaction sentinel, raw target bypass, blocked route, auth boundary, packet
source boundary, operator acceptance, and independent reviewer GO. Current static runtime routes
remain `GET /, GET /healthz, GET /manifest.json`; `/api/packets`, `/packets`, `/packet`,
`/operator-packets`, `/data`, `/events`, `/catalog`, `/items`, `/auth`, `/login`, `/session`, and
`/token` remain forbidden current routes. Phase 75 readiness remains not-ready, Phase 76 limits
remain contract-only and not-implemented, and Phase 77 evidence gate remains blocked and
evidence-required. no endpoint/runtime/auth/provider/UI/data expansion is added.
Phase 79 adds `src/ops/operator-ui-local-auth-boundary.ts`,
`docs/PHASE_79_OPERATOR_UI_LOCAL_AUTH_BOUNDARY.md`, `ops:operator-ui-local-auth-boundary`, and
`test:operator-ui-local-auth-boundary` as an operator UI local auth boundary selection report. The
report is fixed, no-input, and contract-only with report name `operator-ui-local-auth-boundary`,
version `phase-79.v1`, code `OPERATOR_UI_LOCAL_AUTH_BOUNDARY_REPORTED`, and status `blocked /
auth-boundary-selection-only`; auth implementation remains `not-implemented`. Run it with
`npm run --silent ops:operator-ui-local-auth-boundary -- -- --json`. The selected future boundary
is `local-operator-secret-file-with-explicit-path-and-redacted-evidence` with status
`selected-for-future-review/not-implemented`. The future shape requires an explicit
operator-provided file path only in a later reviewed phase, no default secret path, no environment
variable secret value, no CLI argument secret value, bounded file size in future implementation,
e.g. <= 4096 bytes, trim one trailing newline only, reject empty or whitespace-only values, reject
values below minimum entropy or length, constant-time comparison, never log, echo, persist,
hash-output, or include the secret value in evidence, redaction-safe errors only, loopback-only use
unless a later reviewed remote access model exists, and no browser storage, cookie/session token,
bearer/basic auth, or OAuth/Sso in the first implementation. The first implementation rejects
`reverse-proxy-forward-auth-attestation`, `mTLS-or-local-network-attestation`,
`browser-cookie-session`, and `bearer-token-api` as `rejected-for-first-implementation`.
`currentRuntimeExposure` remains `127.0.0.1 fixture preview only`, `remoteExposure` remains
blocked, and current static runtime routes remain `GET /, GET /healthz, GET /manifest.json`.
Forbidden current routes include `/login`, `/auth`, `/session`, `/token`, `/callback`, `/logout`,
`/oauth`, `/sso`, `/admin`, `/api/packets`, `/packets`, `/packet`, and `/operator-packets`. Phase
74 auth contract remains contract-only and not-implemented, Phase 75 readiness remains not-ready,
Phase 76 limits remain contract-only and not-implemented, Phase 77 evidence gate remains blocked
and evidence-required, and Phase 78 route dry-run remains blocked and dry-run-plan-only. no
auth/runtime/route/provider/UI/data expansion is added.
Phase 80 adds `src/ops/operator-ui-local-auth-secret-file-preflight.ts`,
`docs/PHASE_80_OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT.md`,
`ops:operator-ui-local-auth-secret-file-preflight`, and
`test:operator-ui-local-auth-secret-file-preflight` as an operator UI local auth secret-file
preflight / acceptance contract for the Phase 79 boundary. Run it with
`npm run --silent ops:operator-ui-local-auth-secret-file-preflight -- -- <descriptor.json> --json`.
The report name is `operator-ui-local-auth-secret-file-preflight`, version `phase-80.v1`, code
`OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT_REPORTED`, with status
`ready-for-review/preflight-only` for a complete descriptor or `blocked/preflight-only` for
incomplete or invalid input; `authImplementation` remains `not-implemented` and runtime auth
remains blocked. The selected boundary remains
`local-operator-secret-file-with-explicit-path-and-redacted-evidence`. The CLI reads one single
explicit operator JSON descriptor file only. The descriptor path is never echoed, descriptor values
are never echoed, the future secret file path is not read, and the future secret path is not
validated against the filesystem. Accepted fields are `boundaryId`, `operatorFilePathProvided`,
`defaultPathDisabled`, `envSecretValueDisabled`, `cliSecretValueDisabled`, `maxSecretFileBytes`
(`<= 4096`), `trimOneTrailingNewlineOnly`, `rejectEmptyOrWhitespace`,
`rejectLowEntropyOrShort`, `constantTimeComparisonPlanned`, `secretNeverLoggedOrPersisted`,
`redactionSafeErrors`, `loopbackOnly`, `browserStorageCookieSessionBearerBasicOAuthDisabled`,
`reviewerGoRecorded`, and `operatorAcceptanceRecorded`. Forbidden fields such as `secretValue`,
`secretPath`, `databaseUrl`, `packetContents`, and `artifactContents` fail closed without value
echo. Fixed input failure codes include `DESCRIPTOR_FILE_REQUIRED`,
`DESCRIPTOR_JSON_MALFORMED`, `DESCRIPTOR_OBJECT_REQUIRED`, `DESCRIPTOR_FILE_IS_DIRECTORY`, and
`DESCRIPTOR_FILE_TOO_LARGE`. Current static routes remain `GET /, GET /healthz, GET /manifest.json`;
runtime auth remains blocked and no auth/runtime/route/provider/UI/data expansion is added.
Phase 81 adds the guarded operator UI auth packet runtime. The existing
`ops:operator-ui-static-runtime` command keeps static-only behavior unless
started with `--operator-secret-file <path>`. With that explicit file, the
runtime enables `GET /operator-ui/packets.json`, gated by
`X-Operator-UI-Secret`, and the manifest reports `local-secret-file-enabled`
and `sanitized-local-packet-endpoint`. The response is
`synthetic-fixture-only` and uses existing fixture packet allowlists. The root
UI includes a same-origin in-memory fetch control and no cookies, sessions,
bearer/basic auth, OAuth, localStorage, sessionStorage, persistent browser
secret storage, query-string secrets, or URL secrets. No DB reads, no
provider/debrid/Plex/Jellyfin/Hermes calls, no scraping/downloading/playback,
and no frontend/API framework are added. See
`docs/PHASE_81_OPERATOR_UI_AUTH_PACKET_RUNTIME.md` and
`test:operator-ui-auth-packet-runtime`.
Phase 82 adds `ops:operator-ui-auth-packet-acceptance`, a redaction-safe
operator UI auth packet acceptance evidence harness for Phase 81 runtime
behavior. It generates its own temporary local secret file for local-loopback
fixture probes, removes it after probing, and emits either text or
`npm run --silent ops:operator-ui-auth-packet-acceptance -- -- --json`. The report
is `operator-ui-auth-packet-acceptance` / `phase-82.v1` with
`OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_REPORTED`; it is `accepted` only when all
checks pass and otherwise reports `blocked`. Evidence covers fixed 404, fixed
401, fixed 405, `local-loopback-fixture-only`, `local-secret-file-enabled`,
`sanitized-local-packet-endpoint`, `synthetic-fixture-only`, hash-pinned inline
script CSP, and same-origin connect. It records counts only, with no user
secret values, user secret paths, query values, packet contents, artifact
contents, or HTML. No DB reads, no provider or debrid integrations, no live
source, scraping, download, playback, or media-server behavior are added. O4
and O5 remain open/deferred, and FileCustodian remains a hardened reference
harness only, not production KMS. See
`docs/PHASE_82_OPERATOR_UI_AUTH_PACKET_ACCEPTANCE.md` and
`test:operator-ui-auth-packet-acceptance`.
Phase 83 adds `ops:launch-gate-audit`, a static launch-gap audit for the first
three launch work areas: production security gates, operator launch rehearsal,
and real service validation. It reports `LAUNCH_GATE_AUDIT_REPORTED`,
`steps-1-2-3-launch-gap-audit`, `launchReady: false`, and `status: blocked`
until O4/O5 evidence is reviewed or explicitly accepted, real Unraid/operator
rehearsal evidence is collected, and TorBox/Jellyfin live validation evidence is
provided. The JSON command is
`npm run --silent ops:launch-gate-audit -- -- --json`. It does not close O4 or
O5, does not read descriptors/evidence/backups/env/credentials, does not contact
DBs, TorBox, Jellyfin, Real-Debrid, Plex, Usenet, custodians, KMS, Docker, or
live packet sources, and does not add provider mode, playback, downloading,
scraping, frontend/API framework, or web UI behavior. FileCustodian remains a
hardened reference harness only, not production KMS. See
`docs/PHASE_83_LAUNCH_GATE_AUDIT.md` and `test:launch-gate-audit`.
Phase 84 adds `ops:operator-acceptance-packet`, a static operator-run acceptance
packet that converts the Phase 83 audit into concrete redaction-safe run,
retain, and review steps. It reports `OPERATOR_ACCEPTANCE_PACKET_REPORTED`,
`operator-run-redaction-safe-launch-acceptance`, `launchReady: false`, and
`status: blocked` until O4/O5 are proven or explicitly accepted, real Unraid
rehearsal evidence is retained, TorBox/Jellyfin validation evidence is reviewed,
and the Usenet/fallback decision is recorded. The JSON command is
`npm run --silent ops:operator-acceptance-packet -- -- --json`. It does not read
evidence files, credentials, environment values, descriptors, backups, or DBs;
does not contact live services; and does not add provider mode, playback,
downloading, scraping, media-server writes, frontend/API framework, or web UI
behavior. It does not approve launch, close O4, close O5, or close production
readiness. See `docs/PHASE_84_OPERATOR_ACCEPTANCE_PACKET.md` and
`test:operator-acceptance-packet`.
Phase 85 adds `ops:launch-decision-record`, a one-file redaction-safe
launch-decision record preflight for the Phase 84 operator acceptance packet.
It reads a single operator-supplied metadata JSON record, emits fixed
pass/warn/fail labels, and reports `phase-85-launch-decision-record-preflight`,
`single-operator-supplied-launch-decision-record-json-file`, `launchApproved:
false`, and `productionReady: false`. A `launch-candidate-requested`
disposition can become `ready-for-review` only when reviewer `GO`, production
security decision, Unraid rehearsal, and live validation labels are all present.
It never approves launch, closes O4/O5, reads evidence contents, reads
credentials, reads environment values, scans directories, contacts live
services, executes other commands, or adds provider mode, playback,
downloading, scraping, media-server writes, frontend/API framework, or web UI
behavior. FileCustodian remains a hardened reference harness only. See
`docs/PHASE_85_LAUNCH_DECISION_RECORD.md` and `test:launch-decision-record`.
Phase 86 adds `ops:launch-candidate-scope-freeze`, a static no-input packet
that freezes the permitted shape of any later launch-candidate phase. It reports
`LAUNCH_CANDIDATE_SCOPE_FREEZE_REPORTED`,
`phase-85-launch-decision-record-preflight`,
`phase-84-operator-acceptance-packet`, `launchApproved: false`,
`productionReady: false`, `closesO4: false`, `closesO5: false`, and
`status: blocked-pending-operator-decision`. It allows only static
release-candidate label names, existing command references, and retained evidence
label names. It
forbids launch approval, production-ready claims, O4/O5 closure without separate
reviewed evidence or explicit residual-risk acceptance, DB access, evidence
scanning, credential/environment/artifact/provider/raw-ref/media-identity reads,
network calls, live service contact, provider/debrid/media-server/playback
expansion, frontend/API framework work, schedulers, Docker changes, and
background runtime behavior. See
`npm run --silent ops:launch-candidate-scope-freeze -- -- --json`. See
`docs/PHASE_86_LAUNCH_CANDIDATE_SCOPE_FREEZE.md` and
`test:launch-candidate-scope-freeze`.
Phase 87 adds `ops:launch-candidate-metadata-packet`, a static no-input
metadata packet for launch-candidate review. It reports
`LAUNCH_CANDIDATE_METADATA_PACKET_REPORTED`,
`phase-86-launch-candidate-scope-freeze`,
`phase-85-launch-decision-record-preflight`, `launchApproved: false`,
`productionReady: false`, `releaseCandidateApproved: false`, `closesO4:
false`, and `closesO5: false`. It lists retained label names for commit/tag target,
Phase 85/86 records, O4/O5 decision evidence, operator rehearsal evidence,
TorBox/Jellyfin validation summaries, and Usenet/fallback decision. It allows
only fixed label names such as `commit-id-label`, `tag-name-label`,
`report-name-label`, `phase-number-label`, `reviewer-verdict-label`,
`pass-warn-fail-count-label`, existing command names as references, and
evidence artifact label names. It does not retain the actual commit id, tag
name, report date, reviewer verdict, pass/warn/fail count, operator conclusion,
or evidence value. It forbids launch approval, production-ready claims,
release-candidate approval, O4/O5 closure, DB access, credential/environment
reads, evidence/artifact/provider/raw-ref/media-identity reads, network calls,
live service contact, provider/debrid/media-server/playback expansion,
frontend/API framework work, schedulers, Docker changes, and background runtime
behavior. The JSON command is
`npm run --silent ops:launch-candidate-metadata-packet -- -- --json`. See
`docs/PHASE_87_LAUNCH_CANDIDATE_METADATA_PACKET.md` and
`test:launch-candidate-metadata-packet`.
Phase 88 adds `ops:launch-candidate-review-checklist`, a static no-input
checklist for launch-candidate review. It reports
`LAUNCH_CANDIDATE_REVIEW_CHECKLIST_REPORTED`,
`phase-87-launch-candidate-metadata-packet`,
`phase-86-launch-candidate-scope-freeze`, `launchApproved: false`,
`productionReady: false`, `releaseCandidateApproved: false`, `closesO4:
false`, and `closesO5: false`. It lists review row labels, source label names,
pass condition labels, hold condition labels, allowed review material, forbidden
material, and explicit non-goals. It keeps O4/O5 visible, keeps FileCustodian as
a reference harness, and remains label-only. It does not retain actual commit
ids, tag names, dates, verdicts, counts, conclusions, evidence values, secrets,
provider payloads, raw refs, media identity, logs, or patch contents. It forbids
launch approval, production-ready claims, release-candidate approval, O4/O5
closure, DB access, credential/environment reads, evidence/artifact/provider/raw-ref/media-identity
reads, network calls, live service contact, provider/debrid/media-server/playback
expansion, frontend/API framework work, schedulers, Docker changes, and
background runtime behavior. The JSON command is
`npm run --silent ops:launch-candidate-review-checklist -- -- --json`. See
`docs/PHASE_88_LAUNCH_CANDIDATE_REVIEW_CHECKLIST.md` and
`test:launch-candidate-review-checklist`.
Phase 89 adds `ops:launch-candidate-review-handoff`, a static no-input handoff
for independent launch-candidate review. It reports
`LAUNCH_CANDIDATE_REVIEW_HANDOFF_REPORTED`,
`phase-88-launch-candidate-review-checklist`,
`phase-87-launch-candidate-metadata-packet`, `launchApproved: false`,
`productionReady: false`, `releaseCandidateApproved: false`, `closesO4:
false`, and `closesO5: false`. It lists handoff section labels, source label
names, reviewer question labels, hold trigger labels, required verdict labels,
forbidden material, and explicit non-goals. It keeps the handoff label-only and
does not retain actual commit ids, tag names, dates, verdicts, counts,
conclusions, evidence values, secrets, provider payloads, raw refs, media
identity, logs, or patch contents. It forbids launch approval,
production-ready claims, release-candidate approval, O4/O5 closure, DB access,
credential/environment reads, evidence/artifact/provider/raw-ref/media-identity
reads, network calls, live service contact, provider/debrid/media-server/playback
expansion, frontend/API framework work, schedulers, Docker changes, and
background runtime behavior. The JSON command is
`npm run --silent ops:launch-candidate-review-handoff -- -- --json`. See
`docs/PHASE_89_LAUNCH_CANDIDATE_REVIEW_HANDOFF.md` and
`test:launch-candidate-review-handoff`.
Phase 90 adds `ops:final-launch-disposition`, a static no-input final
launch-disposition template that combines the operator launch decision with
explicit O4/O5 gate disposition labels. It reports
`FINAL_LAUNCH_DISPOSITION_REPORTED`,
`phase-89-launch-candidate-review-handoff`,
`phase-88-launch-candidate-review-checklist`, `launchDecision: hold`,
`launchApproved: false`, `productionReady: false`,
`releaseCandidateApproved: false`, `closesO4: false`, and `closesO5: false`.
The default decision is HOLD. A later human operator decision may request a
launch candidate with O4/O5 accepted as deferred risk, but this packet still
does not close O4 or O5 and does not claim production readiness. It requires
`operator-final-decision-label`, `reviewer-go-or-hold-label`,
`o4-disposition-label`, `o5-disposition-label`,
`residual-risk-acceptance-label`, and `launch-candidate-target-label`. It
forbids launch approval, production-ready claims, release-candidate approval,
O4/O5 closure, DB access, credential/environment reads,
evidence/artifact/provider/raw-ref/media-identity reads, network calls, live
service contact, provider/debrid/media-server/playback expansion, frontend/API
framework work, schedulers, Docker changes, and background runtime behavior.
The JSON command is
`npm run --silent ops:final-launch-disposition -- -- --json`. See
`docs/PHASE_90_FINAL_LAUNCH_DISPOSITION.md` and
`test:final-launch-disposition`.
Phase 91 adds `ops:production-time-decision`, a static no-input production-time
decision record for the operator direction to push through to launch-candidate
review while keeping the security boundary honest. It reports
`PRODUCTION_TIME_DECISION_RECORDED`, `phase-90-final-launch-disposition`,
`phase-89-launch-candidate-review-handoff`, `phase-22-production-readiness-gate`,
`launchCandidateRequested: true`, `launchApproved: false`,
`productionReady: false`, `releaseCandidateApproved: false`, `closesO4:
false`, `closesO5: false`, and `residualRiskAccepted: true`. The allowed claim
is `launch candidate requested; O4/O5 deferred risk explicitly accepted`; the
forbidden claim is `turnkey production ready`. It records O4 and O5 as
operator-accepted deferred risks only and lists the evidence required to close
them later. It forbids launch approval, production-ready claims,
release-candidate approval, O4/O5 closure, DB access, credential/environment
reads, evidence/artifact/provider/raw-ref/media-identity reads, network calls,
live service contact, provider/debrid/media-server/playback expansion,
frontend/API framework work, schedulers, Docker changes, and background runtime
behavior. The JSON command is
`npm run --silent ops:production-time-decision -- -- --json`. See
`docs/PHASE_91_PRODUCTION_TIME_DECISION.md` and
`test:production-time-decision`.
Phase 92 adds `ops:launch-candidate-seal`, a static no-input launch-candidate
seal record for tagging the reviewed commit as `phase-92` and
`launch-candidate-1`. It reports `LAUNCH_CANDIDATE_SEAL_RECORDED`,
`phase-91-production-time-decision`, `phase-90-final-launch-disposition`,
`phase-89-launch-candidate-review-handoff`, `launchCandidateSealed: true`,
`launchApproved: false`, `productionReady: false`,
`releaseCandidateApproved: false`, `releaseApproved: false`, `closesO4:
false`, `closesO5: false`, and `residualRiskAccepted: true`. The allowed claim
is `launch candidate sealed for review; O4/O5 deferred risk explicitly
accepted`; the forbidden claim is `production release approved`. It preserves
O4/O5 as open/deferred launch-candidate residual risk and keeps FileCustodian as
a reference harness. It forbids launch approval, production-ready claims,
release-candidate approval, production release approval, O4/O5 closure, DB
access, credential/environment reads, evidence/artifact/provider/raw-ref/media-identity
reads, network calls, live service contact, provider/debrid/media-server/playback
expansion, frontend/API framework work, schedulers, Docker changes, and
background runtime behavior. The JSON command is
`npm run --silent ops:launch-candidate-seal -- -- --json`. See
`docs/PHASE_92_LAUNCH_CANDIDATE_SEAL.md` and `test:launch-candidate-seal`.
Phase 93 adds `ops:semi-launch-validation-packet`, a static no-input GO/HOLD
validation packet for deciding whether `launch-candidate-1` is a real
semi-launch candidate. It reports
`SEMI_LAUNCH_VALIDATION_PACKET_RECORDED`,
`phase-92-launch-candidate-seal`, `phase-91-production-time-decision`,
`semiLaunchCandidateVerdict: hold`, `semiLaunchCandidateGo: false`,
`launchApproved: false`, `productionReady: false`,
`releaseCandidateApproved: false`, `releaseApproved: false`, `closesO4:
false`, `closesO5: false`, `operatorEvidenceCollected: false`, and
`independentReviewRequired: true`. The default status is HOLD pending operator
evidence; it defines required ref checks, clean-checkout repo validation,
operator evidence labels, hold triggers, and GO conditions. The allowed claim is
`launch candidate is sealed; semi-launch GO is pending operator evidence
review`; the forbidden claim is `semi-launch candidate approved`. It does not
grant semi-launch GO, approve launch, claim production readiness, approve a
release, close O4/O5, read evidence, run commands, contact live services, or
add runtime behavior. The JSON command is
`npm run --silent ops:semi-launch-validation-packet -- -- --json`. See
`docs/PHASE_93_SEMI_LAUNCH_VALIDATION_PACKET.md` and
`test:semi-launch-validation-packet`.
Phase 94 adds `ops:operator-validation-run-sheet`, a static no-input final run
sheet before Clint/operator validation is required. It reports
`OPERATOR_VALIDATION_RUN_SHEET_RECORDED`,
`phase-93-semi-launch-validation-packet`, `launch-candidate-1`,
`operatorActionRequired: true`, `semiLaunchCandidateGo: false`,
`operatorEvidenceCollected: false`, `independentReviewRequired: true`,
`launchApproved: false`, `productionReady: false`,
`releaseCandidateApproved: false`, `releaseApproved: false`, `closesO4:
false`, and `closesO5: false`. It lists the required run order, command shapes,
evidence labels, reviewer handoff labels, retention rules, and HOLD triggers.
The allowed claim is `operator validation run sheet ready; semi-launch GO awaits
retained evidence`; the forbidden claim is `operator validation complete`. It
does not collect evidence, grant semi-launch GO, approve launch, claim
production readiness, approve a release, close O4/O5, read evidence, run live
commands, contact services, or add runtime behavior. The JSON command is
`npm run --silent ops:operator-validation-run-sheet -- -- --json`. See
`docs/PHASE_94_OPERATOR_VALIDATION_RUN_SHEET.md` and
`test:operator-validation-run-sheet`.
Phase 95 adds a planning-only O4/O5 hardening plan. It sequences future work for
managed/external custodian readiness and managed KEK custody/rotation
automation, based on the existing Phase 16/21/28/29 and Phase 17/30 scaffolding.
It does not add a real custodian adapter, cloud/vendor SDK, HTTP service,
provider adapter, media-server integration, UI, scheduler, live service call, or
runtime behavior. It does not close O4 or O5. See
`docs/PHASE_95_O4_O5_HARDENING_PLAN.md`. Phase 95.1 adds the docs-only
O4/O5 evidence packet shape in
`docs/PHASE_95_1_O4_O5_EVIDENCE_PACKET.md`; it indexes redaction-safe evidence
labels only and still does not close O4 or O5. Phase 95.2 adds the design-only
external custodian adapter boundary in
`docs/PHASE_95_2_EXTERNAL_CUSTODIAN_ADAPTER_DESIGN.md`; it compares local
sidecar versus managed/external custody directions, records failure modes and
evidence labels, and still does not implement a custodian or close O4. Phase
95.3 adds the design-only O5 managed KEK custody runbook in
`docs/PHASE_95_3_O5_MANAGED_KEK_CUSTODY_RUNBOOK.md`; it documents custody
options, rotation cadence, alert triage, descriptor labels, and the manual
approval boundary for mutating rewrap without implementing managed custody,
scheduling, or rotation automation. Phase 95.4 adds the implementation
authorization gate in `docs/PHASE_95_4_IMPLEMENTATION_AUTHORIZATION_GATE.md`;
it defines the redaction-safe operator decision record and hold conditions
required before any real O4/O5 implementation can begin. The review handoff is
`docs/PHASE_95_REVIEW_HANDOFF.md`; the HOLD-by-default decision template is
`docs/PHASE_95_IMPLEMENTATION_DECISION_TEMPLATE.md`.
Phase 96 adds `docs/PHASE_96_O4_O5_EVIDENCE_DECISION_PACKET.md`,
`docs/PHASE_96_IMPLEMENTATION_DECISION_RECORD.redacted.json`,
`ops:o4-o5-evidence-decision`, and `test:o4-o5-evidence-decision` as the first
authorized O4/O5 evidence-contract slice. It accepts exactly one redaction-safe
decision record plus one O4 descriptor and one O5 descriptor, authorizes only
`contract-harness-expansion-without-live-service-contact`, sets
`runtimeImplementationAuthorized: false`, `liveServiceContactAllowed: false`,
`closesO4: false`, and `closesO5: false`, and keeps O4/O5 open/deferred. No
provider, media-server, playback, download, scraping, live custodian/KMS contact,
managed secret-store client, scheduler, HTTP service, or UI expansion is added.
Phase 97 adds `docs/PHASE_97_OPERATOR_UI_PREVIEW_LAUNCH_PACKET.md`,
`ops:operator-ui-preview-launch-packet`, and `test:operator-ui-preview-launch-packet` as a static
preview launch packet. It keeps `remoteExposureAllowed: false`, `liveDataAllowed: false`, and
`providerContactAllowed: false`, documents local loopback preview and an operator-controlled SSH
tunnel shape for Unraid, and keeps the preview fixture-only. It does not add live DB reads,
provider/media-server data, reverse-proxy exposure, auth/session behavior, production UI, launch
approval, or O4/O5 closure.
Phase 98 adds `docs/PHASE_98_LOCAL_SIDECAR_CUSTODIAN_PROTOTYPE.md`,
`src/core/crypto/local-sidecar-custodian.ts`, and `test:local-sidecar-custodian` as an offline
local-sidecar custodian prototype. It implements a `LocalSidecarCustodianClient` over an injected
transport and runs the shared `KeyCustodian` contract kit with no sockets, no daemon, no Docker,
no env reads, no live service contact, provider/media-server work, or UI. The descriptor uses `external-self-hosted`
and can be ready for review, but O4/O5 remain open/deferred until a real sidecar process,
independent state/custody boundary, operator-run evidence, restore fail-closed proof, and
reviewer/operator acceptance exist.
Phase 99 adds `docs/PHASE_99_SIDECAR_RUNTIME_DESIGN_PACKET.md` and
`ops:sidecar-runtime-design-packet` to select the Unraid self-hosted sidecar runtime shape: separate
local process, Unix domain socket with owner-only filesystem permissions, independent appdata state,
and sidecar-owned attestation. It is design-only: runtimeImplemented: false, liveValidationAllowed:
false, no daemon, no socket listener, no HTTP API, no TCP listener, no Docker topology, no provider
or media-server work, no UI, and no O4/O5 closure.
Phase 100 adds `docs/PHASE_100_SIDECAR_EVIDENCE_HARNESS_PACKET.md` and
`ops:sidecar-evidence-harness-packet` to define the redaction-safe sidecar evidence manifest. The
manifestValuesEchoed: false harness requires labels for runtime design, contract kit,
failure-injection, attestation, redaction, backup/restore, operator acceptance, and reviewer
acceptance, plus true fields such as restoreWithoutSidecarFailsClosed. It can mark evidence ready
for review but never closes O4 or O5.
Phase 101/102 adds `docs/PHASE_101_102_SIDECAR_RUNTIME_PROTOTYPE.md`,
`src/core/crypto/local-sidecar-runtime.ts`, `ops:sidecar-runtime-evidence`, and
`test:sidecar-runtime-prototype` as the first local IPC sidecar runtime prototype. It starts a
temporary local socket runtime only inside the test/evidence command, exercises
`UnixSocketSidecarTransport`, packages Phase 100 evidence labels, and keeps tcpListenerAllowed:
false, httpApiAllowed: false, serviceInstallAllowed: false, liveValidationAllowed: false, and
closesO4: false. It adds no HTTP API, LAN exposure, Docker topology, Unraid service install,
provider/media-server workflow, UI, or O4/O5 closure.
Phase 103/104 adds `docs/PHASE_103_104_DURABLE_SIDECAR_STATE_EVIDENCE.md`,
`ops:sidecar-durable-state-evidence`, and `test:sidecar-durable-state-evidence` to run the local
socket sidecar against sidecar-owned durable state. It proves restartPersistenceExercised: true,
restoreFailClosedExercised: true, sidecarStateValuesEchoed: false, serviceInstallAllowed: false,
and closesO4: false while preserving that FileCustodian remains a hardened reference harness.
Phase 105 adds `docs/PHASE_105_SIDECAR_UNRAID_SERVICE_PLAN.md`,
`ops:sidecar-unraid-service-plan`, and `test:sidecar-unraid-service-plan` as a static Unraid service
wrapper plan. It defines appdata layout, owner-only sidecar directories, local socket readiness
checks, blocked `/boot`/rc.d/service-install actions, and keeps serviceInstalled: false,
serviceStarted: false, mutatesUnraid: false, tcpListenerAllowed: false, httpApiAllowed: false,
lanExposureAllowed: false, and closesO4: false.
Phase 106 adds `docs/PHASE_106_SIDECAR_UNRAID_OPERATOR_SCRIPT_PACKET.md`,
`ops:sidecar-unraid-operator-script-packet`, and `test:sidecar-unraid-operator-script-packet` as
copy/paste-safe operator script shapes. The packet keeps commandExecution: false,
operatorRunRequired: true, mutatesUnraidNow: false, serviceInstalled: false, and closesO4: false.
Phase 107 adds `docs/PHASE_107_SIDECAR_UNRAID_EVIDENCE_CAPTURE.md`,
`ops:sidecar-unraid-evidence-capture`, and `test:sidecar-unraid-evidence-capture` to define the
single-redacted-sidecar-unraid-evidence-json-file bundle expected from an operator run. It keeps
evidenceValuesEchoed: false, commandExecution: false, serviceInstalled: false, and closesO4: false.
Phase 108 adds `docs/PHASE_108_SIDECAR_UNRAID_REVIEW_GATE.md`,
`ops:sidecar-unraid-review-gate`, and `test:sidecar-unraid-review-gate` as a static review gate for
that explicit redacted bundle. It can return reviewReadiness ready-for-review, but keeps
commandExecution: false, evidenceValuesEchoed: false, liveServiceContact: false,
providerContactAllowed: false, closesO4: false, and O4/O5 open.
Phase 109 adds `docs/PHASE_109_SIDECAR_UNRAID_REVIEW_SUMMARY.md`,
`ops:sidecar-unraid-review-summary`, and `test:sidecar-unraid-review-summary` as a summary preflight
for one redacted Phase 108 review-gate JSON file. It keeps inputValuesEchoed: false,
commandExecution: false, serviceInstalled: false, providerContactAllowed: false, closesO4: false,
closesO5: false, and O4/O5 remain open/deferred.
Phase 110 adds `docs/PHASE_110_SIDECAR_UNRAID_ACCEPTANCE_RECORD.md`,
`ops:sidecar-unraid-acceptance-record`, and `test:sidecar-unraid-acceptance-record` as a redaction-safe
acceptance record preflight with fixed decision values. It keeps recordValuesEchoed: false,
commandExecution: false, serviceInstalled: false, serviceStarted: false, providerContactAllowed:
false, closesO4: false, closesO5: false, and O4/O5 remain open/deferred.
Phase 111 adds `docs/PHASE_111_SIDECAR_UNRAID_REVIEW_HANDOFF.md`,
`ops:sidecar-unraid-review-handoff`, and `test:sidecar-unraid-review-handoff` as a static
independent-review handoff packet. It reports awaiting-independent-review, productionReady: false,
serviceInstallApproved: false, providerModeEnabled: false, closesO4: false, closesO5: false, and
O4/O5 remain open/deferred.
Phase 112 adds `docs/PHASE_112_SIDECAR_UNRAID_PRODUCTION_GATE_BLOCKERS.md`,
`ops:sidecar-unraid-production-gate-blockers`, and `test:sidecar-unraid-production-gate-blockers`
as a static blocker packet after the Phase 111 handoff. It enumerates the remaining O4 managed
custodian, independent-review, O5 managed KEK custody, and Unraid service live-validation evidence
labels while keeping productionReady: false, serviceInstallApproved: false, providerModeEnabled:
false, commandExecution: false, closesO4: false, closesO5: false, and O4/O5 remain open/deferred.
Phase 113 adds `docs/PHASE_113_SIDECAR_UNRAID_CUSTODIAN_BOUNDARY_PREFLIGHT.md`,
`ops:sidecar-unraid-custodian-boundary-preflight`, and
`test:sidecar-unraid-custodian-boundary-preflight` as a redaction-safe O4 sidecar custodian
boundary descriptor preflight. It reads one `single-redacted-sidecar-custodian-boundary-json-file`,
requires the `managed-custodian-sidecar-boundary-attestation-redacted` source blocker label, and
keeps descriptorValuesEchoed: false, commandExecution: false, productionReady: false, closesO4:
false, closesO5: false, and O4/O5 remain open/deferred.
Phase 114 adds `docs/PHASE_114_SIDECAR_UNRAID_CUSTODIAN_REVIEW_VERDICT.md`,
`ops:sidecar-unraid-custodian-review-verdict`, and
`test:sidecar-unraid-custodian-review-verdict` as a redaction-safe independent-review verdict
preflight for the Phase 113 O4 sidecar custodian boundary packet. It reads one
`single-redacted-sidecar-custodian-review-verdict-json-file`, accepts fixed verdicts `GO`, `HOLD`,
or `REJECTED`, and keeps verdictValuesEchoed: false, rawReviewerNotesIncluded: false,
productionReady: false, closesO4: false, closesO5: false, and O4/O5 remain open/deferred.
Phase 115 adds `docs/PHASE_115_SIDECAR_UNRAID_O4_CLOSURE_GATE.md`,
`ops:sidecar-unraid-o4-closure-gate`, and `test:sidecar-unraid-o4-closure-gate` as a redaction-safe
O4 closure gate preflight over the Phase 113 boundary report and Phase 114 review verdict report.
It can report ready-for-final-o4-authorization and closure-ready-pending-final-authorization, but
keeps inputValuesEchoed: false, commandExecution: false, productionReady: false, closesO4: false,
closesO5: false, and O5 remains open/deferred.
Phase 116 adds `docs/PHASE_116_SIDECAR_UNRAID_O4_FINAL_AUTHORIZATION.md`,
`ops:sidecar-unraid-o4-final-authorization`, and `test:sidecar-unraid-o4-final-authorization` as a
redaction-safe final authorization record over the Phase 115 closure gate. It can report
authorizationStatus: o4-authorized, o4Status: closed/authorized, and O4 closure for the
o4-managed-custodian-boundary-only scope while keeping inputValuesEchoed: false, commandExecution:
false, productionReady: false, closesO5: false, and O5 remains open/deferred.
Phase 117 adds `docs/PHASE_117_O5_KEK_REVIEW_VERDICT.md`, `ops:o5-kek-review-verdict`, and
`test:o5-kek-review-verdict` as a redaction-safe independent-review verdict preflight for the
Phase 30 O5 KEK evidence preflight. It accepts fixed verdicts `GO`, `HOLD`, or `REJECTED`, can
report ready-for-o5-closure-gate, and keeps verdictValuesEchoed: false, rawReviewerNotesIncluded:
false, productionReady: false, closesO4: false, closesO5: false, and O5 remains open/deferred.
Phase 118 adds `docs/PHASE_118_O5_KEK_CLOSURE_GATE.md`, `ops:o5-kek-closure-gate`, and
`test:o5-kek-closure-gate` as a redaction-safe O5 closure gate preflight over the Phase 30 KEK
preflight report and Phase 117 review verdict report. It can report ready-for-final-o5-authorization
and closure-ready-pending-final-authorization, but keeps inputValuesEchoed: false, commandExecution:
false, productionReady: false, closesO4: false, closesO5: false, and O5 remains open until final
authorization.
Phase 119 adds `docs/PHASE_119_O5_KEK_FINAL_AUTHORIZATION.md`, `ops:o5-kek-final-authorization`,
and `test:o5-kek-final-authorization` as a redaction-safe final authorization record over the Phase
118 closure gate. It can report authorizationStatus: o5-authorized, o5Status: closed/authorized,
and O5 closure for the o5-managed-kek-custody-only scope while keeping inputValuesEchoed: false,
commandExecution: false, productionReady: false, closesO4: false, and FileCustodian remains a
hardened reference harness.
Phase 120 adds `docs/PHASE_120_UNRAID_OPERATOR_READINESS_BUNDLE.md`,
`ops:unraid-operator-readiness-bundle`, and `test:unraid-operator-readiness-bundle` as a
redaction-safe Unraid planning bundle over the authorized O4/O5 evidence. It reports
UNRAID_OPERATOR_READINESS_BUNDLE, o4Status: closed/authorized, o5Status: closed/authorized, and
remaining redacted production gates while keeping commandExecution: false, serviceInstallApproved:
false, providerModeEnabled: false, productionReady: false, closesO4: false, closesO5: false, and
FileCustodian remains a hardened reference harness.
Phase 121 adds `docs/PHASE_121_UNRAID_SERVICE_INSTALL_RUNBOOK.md`,
`ops:unraid-service-install-runbook`, and `test:unraid-service-install-runbook` as a redaction-safe
draft install and rollback runbook over the Phase 120 readiness bundle. It reports
UNRAID_SERVICE_INSTALL_RUNBOOK, runbookReviewStatus: draft-pending-operator-review,
o4Status: closed/authorized, and o5Status: closed/authorized while keeping inputValuesEchoed:
false, commandExecution: false, scriptGenerated: false, serviceInstallApproved: false,
serviceInstalled: false, serviceStarted: false, productionReady: false, closesO4: false,
closesO5: false, and FileCustodian remains a hardened reference harness.
Phase 122 adds `docs/PHASE_122_UNRAID_SERVICE_RUNBOOK_APPROVAL_GATE.md`,
`ops:unraid-service-runbook-approval-gate`, and `test:unraid-service-runbook-approval-gate` as a
redaction-safe approval gate over the Phase 121 draft runbook and one explicit review record. A GO
review can report runbookApprovalStatus: ready-for-future-install-authorization and
readyForInstallAuthorization: true while keeping inputValuesEchoed: false, rawReviewerNotesIncluded:
false, commandExecution: false, scriptGenerated: false, serviceInstallApproved: false,
serviceInstalled: false, serviceStarted: false, productionReady: false, closesO4: false,
closesO5: false, and FileCustodian remains a hardened reference harness.
Phase 123 adds `docs/PHASE_123_UNRAID_SERVICE_INSTALL_AUTHORIZATION.md`,
`ops:unraid-service-install-authorization`, and `test:unraid-service-install-authorization` as a
redaction-safe final authorization record over the Phase 122 approval gate. A valid authorization can
report installAuthorizationStatus: install-window-authorized and serviceInstallApproved: true while
keeping inputValuesEchoed: false, rawAuthorizationNotesIncluded: false, commandExecution: false,
scriptGenerated: false, serviceInstalled: false, serviceStarted: false, productionReady: false,
launchApproved: false, closesO4: false, closesO5: false, and FileCustodian remains a hardened
reference harness.
Phase 124 adds `docs/PHASE_124_UNRAID_INSTALL_EVIDENCE_MANIFEST.md`,
`ops:unraid-install-evidence-manifest`, and `test:unraid-install-evidence-manifest` as a
redaction-safe manifest for evidence captured after the authorized operator-run install window. It
reports UNRAID_INSTALL_EVIDENCE_MANIFEST, evidenceManifestStatus: ready-for-operator-capture, and
serviceInstallApproved: true while keeping inputValuesEchoed: false, commandExecution: false,
scriptGenerated: false, serviceInstalled: false, serviceStarted: false, providerModeEnabled: false,
productionReady: false, launchApproved: false, closesO4: false, closesO5: false, and FileCustodian
remains a hardened reference harness.
Phases 125-127 add `docs/PHASE_125_127_UNRAID_PRODUCTION_GATES.md`,
`ops:unraid-install-evidence-capture-gate`, `ops:unraid-post-install-validation-review`,
`ops:unraid-production-readiness-decision`, and `test:unraid-production-gates` as the final
redaction-safe Unraid evidence/review/decision gate chain. Phase 127 can report
productionReadinessDecisionStatus: ready-for-final-human-production-approval while keeping
productionReady: false, launchApproved: false, commandExecution: false, scriptGenerated: false,
serviceInstalled: false, serviceStarted: false, providerModeEnabled: false, and FileCustodian
remains a hardened reference harness.
Phase 128 adds `docs/PHASE_128_UNRAID_FINAL_HUMAN_APPROVAL_TEMPLATE.md`,
`ops:unraid-final-human-approval-template`, and `test:unraid-final-human-approval-template` as a
redaction-safe template for the explicit final human production approval record. It reports
UNRAID_FINAL_HUMAN_APPROVAL_TEMPLATE, finalHumanApprovalStatus: awaiting-explicit-human-approval,
and required record phase-128-unraid-final-human-production-approval-record while keeping
productionReady: false, launchApproved: false, commandExecution: false, scriptGenerated: false,
serviceInstalled: false, serviceStarted: false, providerModeEnabled: false, and FileCustodian
remains a hardened reference harness.
Phase 129 adds `docs/PHASE_129_UNRAID_FINAL_HUMAN_APPROVAL_RECORD.md`,
`ops:unraid-final-human-approval-record`, and `test:unraid-final-human-approval-record` as a
redaction-safe preflight for one explicit final human approval record. It reports
phase-129-unraid-final-human-approval-record-preflight and can mark the record
ready-for-operator-production-switch only when the supplied record has verdict: GO, while keeping
productionReady: false, launchApproved: false, commandExecution: false, scriptGenerated: false,
serviceInstalled: false, serviceStarted: false, providerModeEnabled: false, and FileCustodian
remains a hardened reference harness.
Phase 130 adds `docs/PHASE_130_UNRAID_PRODUCTION_SWITCH_RUNBOOK.md`,
`ops:unraid-production-switch-runbook`, and `test:unraid-production-switch-runbook` as a
redaction-safe runbook packet for the explicit operator production switch window. It consumes a
Phase 129 preflight, references `unraid-live-operating-test-2026-07-08.redacted.md`, uses
`docker-compose.unraid.yml`, and can report ready-for-explicit-operator-window while keeping
productionReady: false, launchApproved: false, commandExecution: false, scriptGenerated: false,
serviceInstalled: false, serviceStarted: false, providerModeEnabled: false, and FileCustodian
remains a hardened reference harness.
Phase 131 adds `docs/PHASE_131_UNRAID_SWITCH_EVIDENCE_CAPTURE.md`,
`ops:unraid-switch-evidence-capture`, and `test:unraid-switch-evidence-capture` as a
redaction-safe capture packet for evidence after an explicit operator switch. It reports
phase-131-unraid-switch-evidence-capture, points to phase-130-unraid-production-switch-runbook,
requires ready-for-explicit-operator-window, references `unraid-live-operating-test-2026-07-08.redacted.md`,
and defines post-switch-doctor-redacted-json while keeping productionReady: false,
launchApproved: false, commandExecution: false, scriptGenerated: false, serviceInstalled: false,
serviceStarted: false, providerModeEnabled: false, and FileCustodian remains a hardened reference
harness.
Phase 132 adds `docs/PHASE_132_UNRAID_SWITCH_EVIDENCE_REVIEW.md`,
`ops:unraid-switch-evidence-review`, and `test:unraid-switch-evidence-review` as a redaction-safe
review gate for one operator-supplied switch evidence JSON file. It reports
phase-132-unraid-switch-evidence-review, requires phase-132-unraid-switch-evidence-record,
phase-131-unraid-switch-evidence-capture, and phase-130-unraid-production-switch-runbook, and can
report service-evidence-present plus ready-for-final-production-disposition while keeping
productionReady: false, launchApproved: false, commandExecution: false, scriptGenerated: false,
providerModeEnabled: false, and FileCustodian remains a hardened reference harness.
Phase 133 adds `docs/PHASE_133_UNRAID_PRODUCTION_DISPOSITION.md`,
`ops:unraid-production-disposition`, and `test:unraid-production-disposition` as a redaction-safe
operator disposition gate. It reports phase-133-unraid-production-disposition, requires
phase-133-unraid-production-disposition-record, phase-132-unraid-switch-evidence-review,
ready-for-final-production-disposition, service-evidence-present, and can report
ready-for-launch-readiness-decision for verdict: GO while keeping productionReady: false,
launchApproved: false, commandExecution: false, scriptGenerated: false, providerModeEnabled: false,
and FileCustodian remains a hardened reference harness.
Phase 134 adds `docs/PHASE_134_UNRAID_LAUNCH_READINESS_DECISION.md`,
`ops:unraid-launch-readiness-decision`, and `test:unraid-launch-readiness-decision` as a
redaction-safe launch-readiness gate for one Phase 133 production disposition JSON file. It reports
phase-134-unraid-launch-readiness-decision, requires phase-133-unraid-production-disposition,
verdict: GO, and ready-for-launch-readiness-decision, and can report
ready-for-final-launch-approval-record while keeping productionReady: false, launchApproved: false,
commandExecution: false, scriptGenerated: false, providerModeEnabled: false, and FileCustodian
remains a hardened reference harness.
Phase 135 adds `docs/PHASE_135_UNRAID_FINAL_LAUNCH_APPROVAL_RECORD.md`,
`ops:unraid-final-launch-approval-record`, and `test:unraid-final-launch-approval-record` as a
redaction-safe final approval record gate. It requires phase-134-unraid-launch-readiness-decision,
ready-for-final-launch-approval-record, verdict: GO, APPROVE_UNRAID_PRODUCTION_SWITCH, and
approvedByHuman: true, then reports ready-for-production-switch-execution-packet with
launchApproved: true while keeping productionReady: false, commandExecution: false,
scriptGenerated: false, serviceInstalled: false, serviceStarted: false, providerModeEnabled: false,
and FileCustodian remains a hardened reference harness.
Phase 136 adds `docs/PHASE_136_UNRAID_PRODUCTION_SWITCH_EXECUTION_PACKET.md`,
`ops:unraid-production-switch-execution-packet`, and
`test:unraid-production-switch-execution-packet` as the redaction-safe final execution packet for
the real Unraid switch. It requires phase-135-unraid-final-launch-approval-record,
ready-for-production-switch-execution-packet, and launchApproved: true, then reports
ready-for-real-unraid-production-switch while keeping productionReady: false,
commandExecution: false, scriptGenerated: false, mutatesUnraid: false, serviceInstalled: false,
serviceStarted: false, providerModeEnabled: false, and FileCustodian remains a hardened reference
harness.
Phase 137 adds `docs/PHASE_137_UNRAID_POST_SWITCH_EVIDENCE_REVIEW.md`,
`ops:unraid-post-switch-evidence-review`, and `test:unraid-post-switch-evidence-review` as a
redaction-safe review of the live Unraid switch evidence. It requires
phase-136-unraid-production-switch-execution-packet, ready-for-real-unraid-production-switch,
deployed commit `7e2db7c8b6b9ac68272e01ee51e6c63399fc0ef3`, healthy `repo-postgres-1`, no
published ports, APP_ENV production, and a post-switch doctor with 12 pass, 2 warn, and 0 fail. It
reports service-running-with-open-hardening-warnings with serviceInstalled: true,
serviceStarted: true, launchApproved: true, o4Status: open-warning, and o5Status: open-warning
while keeping productionReady: false, commandExecution: false, scriptGenerated: false,
providerModeEnabled: false, and FileCustodian remains a hardened reference harness.
Phase 138 adds `docs/PHASE_138_UNRAID_POST_SWITCH_MAINTENANCE_REVIEW.md`,
`ops:unraid-post-switch-maintenance-review`, and
`test:unraid-post-switch-maintenance-review` as a redaction-safe review of post-switch maintenance
evidence. It requires phase-137-unraid-post-switch-evidence-review,
service-running-with-open-hardening-warnings, patched User Scripts that preserve persistent
`repo-postgres-1`, completed doctor/backup-verify/KEK-plan scripts, zero plaintext backup
candidates, no published ports, and healthy service state after maintenance. It reports
post-switch-maintenance-evidence-accepted with serviceInstalled: true, serviceStarted: true, and
launchApproved: true while keeping productionReady: false, commandExecution: false,
scriptGenerated: false, providerModeEnabled: false, and FileCustodian remains a hardened reference
harness.
Phase 139 adds `docs/PHASE_139_UNRAID_RESTART_PERSISTENCE_REVIEW.md`,
`ops:unraid-restart-persistence-review`, and `test:unraid-restart-persistence-review` as a
redaction-safe review of live Unraid restart persistence evidence. It requires
phase-138-unraid-post-switch-maintenance-review, post-switch-maintenance-evidence-accepted,
deployed commit `8ddf3f3`, a Compose-level restart of `repo-postgres-1`, healthy service state
before and after restart, post-restart doctor ok: true, schema version 3, persisted
completion-secret match, and custodian reachability after restart. It reports
restart-persistence-evidence-accepted with serverRebooted: false, serviceInstalled: true,
serviceStarted: true, and launchApproved: true while keeping productionReady: false,
commandExecution: false, scriptGenerated: false, providerModeEnabled: false, and FileCustodian
remains a hardened reference harness.
Phase 140 adds `docs/PHASE_140_CONTROL_SURFACE_COMPOSE_BOUNDARY.md`,
`ops:control-surface-compose-boundary`, and `test:control-surface-compose-boundary` as the static
stop line before the Arcane/DockHand control-surface Compose section. It requires
phase-139-unraid-restart-persistence-review and reports readyForComposeSection: true plus
requiresHumanLoopBeforeCompose: true while keeping composeStarted: false, arcaneSelected: false,
dockhandControlsInstalled: false, commandExecution: false, scriptGenerated: false,
mutatesUnraid: false, providerModeEnabled: false, productionReady: false, and FileCustodian
remains a hardened reference harness.
Phase 141 adds `docs/PHASE_141_SINGLE_UNRAID_COMPOSE.md` and `docker-compose.unraid.yml` as the
single canonical Unraid Compose file. It merges the hardened deploy topology with Unraid appdata
bind mounts and secret-file paths so normal Unraid operations use one command shape:
`docker compose -f docker-compose.unraid.yml ...`. At Phase 141 it published no ports and did not
install Arcane/DockHand controls or start a new UI; Phase 147 later adds the intentional read-only
operator `app` port `8099:8099`.
Phase 142 adds `docs/PHASE_142_UNRAID_LAUNCHER_RUNTIME_COMPOSE.md` and
`docker-compose.unraid.runtime.yml` for Arcane/launcher deployments that cannot use the repository
directory as a Docker build context. The runtime file uses `image: repo-ops:latest`, keeps the same
Unraid appdata binds and secrets, and documents that `ops` is a one-shot container expected to exit
after commands complete; Phase 147 later adds the long-running read-only `app` service on port
`8099`.
Phase 143 adds `docs/PHASE_143_UNRAID_OPS_LAUNCHERS.md` and
`deploy/unraid-ops-launcher.sh` so Arcane custom commands and Unraid User Scripts can run short
runtime-compose-backed commands for doctor, migrate, backup, KEK rewrap planning, status, and
starting Postgres without hand-pasting long `docker run` commands.
Phase 144 adds `docs/PHASE_144_RUNTIME_IMAGE_OVERRIDE.md` and changes the runtime compose image to
`${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}`. The default still works on the current Unraid
host, while future public deployments can set a published image name without editing the compose
file.
Phase 145 adds `docs/PHASE_145_IMAGE_PUBLISHING_READINESS.md`, `.dockerignore`, and local image
verification scripts (`image:build:local`, `image:inspect:local`) so a future published ops image can
be prepared without pushing to a registry or changing runtime behavior.
Phase 146 adds `docs/PHASE_146_LONG_RUNNING_SERVICE_BOUNDARY.md`,
`ops:long-running-service-boundary`, and `test:long-running-service-boundary` as the reviewed
boundary for the first always-on API plus minimal operator UI. It frames Catalog Authority as the
backend orchestration rail, not a streaming product, selects local-admin-token-file auth, redacted
system/operation/connector logs, planned operator port 8099, read-only-first data exposure, and
keeps providers, scraping, downloading, playback, and media-server mutation forbidden until later
reviewed connector phases. It does not change Compose or publish a port.
Phase 147 adds `docs/PHASE_147_OPERATOR_UI_SERVICE.md`, `ops:operator-ui-server`, and
`test:operator-ui-service` as the first long-running read-only operator API/UI. The Unraid compose
files now include an `app` service using `OPERATOR_UI_TOKEN_FILE=/run/secrets/operator_ui_token`,
publishing only `8099:8099`, serving `/healthz`, `/api/status`, and `/api/logs`, and preserving the
backend orchestration rail boundary with no provider contact, scraping, downloading, playback,
command execution, or media-server mutation.
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

No Plex, no RD provider integration, no TorBox provider-mode integration, no Hermes, no externally bound/live HTTP service, no job queue, no frontend, and **no live network in
automated tests**. Phase 70/71 is the only HTTP exception: a hardened `127.0.0.1` fixture-only static preview shell, not a dashboard, API, packet source, DB reader, provider surface, playback surface, download surface, scraping surface, or media-server surface. (Phases 7–13 add adapter *boundaries* + erasure policy + Jellyfin find/revoke/outbox +
smoke validation; Phase 31 adds TorBox boundary research only; Phase 32 adds a local fake TorBox
contract only; Phase 33 adds a TorBox real-client design gate only; Phase 34 adds an injected
fixture-transport read-only client only; Phase 35 adds operator-run TorBox smoke evidence and future
operator UI examples only; Phase 36 adds the future live-smoke acceptance contract only; Phase 37
adds the refused-by-default TorBox smoke CLI shell only; Phase 38 adds deterministic local fixture
execution only; Phase 39 adds deterministic local transport acceptance only; Phase 40 adds static
TorBox smoke readiness descriptor preflight only; Phase 41 adds static TorBox endpoint mapping review
only; Phase 42 adds a live-capable injected TorBox transport only, with no CI live network, provider-mode integration, downloading, or playback; real network is strictly operator-gated + smoke-validated; Phase 43 adds the operator-only TorBox live smoke CLI wiring for that transport, still outside CI and still detached from provider mode, downloading, and playback; Phase 44 adds static saved-report evidence preflight only, with no live network or credential reads; Phase 45 adds a static placeholder-only operator command plan, with no command execution.)
