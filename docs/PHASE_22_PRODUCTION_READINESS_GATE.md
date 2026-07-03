# Phase 22 — Production Readiness Gate (authoritative)

The **single authoritative checklist** a self-hosted Streaming Catalog Authority deployment on Unraid
must satisfy before anyone claims "production ready." It **consolidates** the readiness, custody, KEK
rotation, backup, ops-evidence, scheduling, and acceptance work from Phases 3, 5, 6, 9, 12, 15–17, and
19–21 — it does not replace them; each row points to the existing source of truth. **Docs/spec only —
this phase adds no runtime behavior.**

## Verdict (read this first)

The **core is production-ready in-repo**, but a full production deployment is **GATED**: it requires
**operator-provided evidence** for several rows and has **two intentionally-deferred open gates**
(O4, O5). Do **not** advertise "production ready" as turnkey. The honest state is:

- **Production-ready (in-repo, met):** deployment topology, `ops:doctor` + warning gates, backup/restore
  tooling, CI determinism, privacy/redaction enforcement, KEK-rewrap tooling.
- **Production-gated pending operator evidence:** external custodian live validation, scheduled operator
  tasks, backup-retention execution, and Jellyfin live-publish validation — each ships docs + a
  redaction-safe template; the operator must run it and retain the evidence.
- **Intentionally deferred (open gates, visible, not hidden):** **O4** (managed/external production
  custodian) and **O5** (managed age-KEK custody + rotation automation/scheduling). Both are *narrowed*
  by acceptance harnesses but **remain open** and are surfaced as `ops:doctor` WARN gates in production.
- **Blocked:** none. (`CUSTODIAN_MODE=memory` in production is CLOSED/enforced — a hard FAIL.)

## Status legend
- **met** — satisfied in-repo (code + CI); no operator action to *achieve*, only to *deploy*.
- **operator-provided** — the mechanism ships; the **operator must run it and retain the evidence** (the
  expected evidence is named per row). Not satisfiable inside this repo/CI.
- **deferred** — an intentionally-open future gate; visible, not hidden.
- **blocked** — cannot proceed. (None here.)

## The gate

| # | Criterion | Status | Evidence source (in repo) | Expected operator evidence (if operator-provided) |
|---|---|---|---|---|
| 1 | **Deployment / Unraid config** — one-shot CLI topology (Postgres + ops), keystore on a volume separate from DB/backups, secrets via `*_FILE`, no HTTP/ports | **met** | `docs/PHASE_3_DEPLOYMENT.md` §Topology/§Volumes/§`*_FILE`; `docker-compose.deploy.yml`; `deploy/unraid-catalog-authority.xml`; CI: `test/deploy.ts` (`smoke:compose` is opt-in, **not** CI) | — |
| 2 | **External custodian / KMS (O4)** — managed custodian implementing `KeyCustodian` outside the app trust boundary | **deferred (O4 open)** | `docs/PHASE_16_EXTERNAL_CUSTODIAN_READINESS.md`; `docs/PHASE_21_EXTERNAL_CUSTODIAN_ACCEPTANCE.md`; `test/helpers/custodian-contract-kit.ts`; `npm run test:custodian-acceptance`; doctor `production-gate-o4-external-custodian` (WARN) | Adapter passes the acceptance kit against the real KMS; redaction-safe acceptance record per Phase 16/21 |
| 3 | **KEK rotation (O5)** — rewrap tooling + preflight; managed custody/scheduling automation | **met (tooling) / deferred (O5 automation open)** | `docs/PHASE_17_KEK_ROTATION_READINESS.md`; `ops:rewrap-kek` (mutate) + `ops:rewrap-kek -- --plan` (preflight, `mutates:false`); doctor `production-gate-o5-managed-kek` (WARN); CI: `test/kek-rewrap.ts`; `docs/PHASE_5_RUNBOOK.md` §5 | Redaction-safe rewrap **plan** (`needsRewrap`/`alreadyCurrent`/`total`) before each rotation; rotation record |
| 4 | **Backup/restore + retention** — ciphertext-only dump (key material excluded), guarded restore integrity gate, offline verify, throwaway-DB rehearsal, retention on independent media | **met (tooling) / operator-provided (retention execution)** | `docs/PHASE_2_BACKUP_POLICY.md`; `ops:backup`/`ops:verify-backup`/`ops:rehearse-restore`; CI: `test/backup.ts`,`backup-ops.ts`,`backup-verify.ts`,`ops-rehearse.ts`; retention: `docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md` §Retention; DR: `docs/PHASE_5_RUNBOOK.md` §7 | Verified backups on independent media at the documented cadence; a periodic restore-rehearsal record |
| 5 | **ops:doctor / warning gates** — read-only self-check, stable JSON contract, fail-closed on probe error, O4/O5 as non-failing WARN | **met** | `src/ops/doctor.ts` (15 checks; `DOCTOR_REPORT_VERSION=1`; `ok` = no FAIL); CI: `test/ops-doctor.ts`; interpretation: `docs/PHASE_19_PRODUCTION_READINESS_EVIDENCE.md` §Doctor | — |
| 6 | **Scheduled operator tasks** — cadence for doctor/backup/verify/rehearse/rewrap-plan + alert triage (no repo-owned scheduler by design) | **operator-provided** | `docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md` §Cadence/§Cron examples/§Alert triage; `docs/PHASE_6_LIFECYCLE.md` §Unattended healthcheck | Unraid User Scripts / cron installed per the cadence; alerting on `ops:doctor --json` non-zero |
| 7 | **Jellyfin validation evidence** — operator-run read-only + double-gated `--write` smoke; redaction-safe; never in CI | **operator-provided / deferred (mapping provisional)** | `docs/PHASE_15_JELLYFIN_VALIDATION_EVIDENCE.md`; template `docs/templates/JELLYFIN_VALIDATION_EVIDENCE.md`; `smoke:jellyfin` (`src/ops/jellyfin-smoke-cli.ts`, **not** CI); `docs/PHASE_13/14` | A completed evidence sheet with the `--write` round-trip `OK` on the operator's server; until then real publishing is **not** proven |
| 8 | **CI / test expectations** — deterministic; no Docker/network/live services; single runtime dep | **met** | `package.json` `ci = typecheck && test` (33 suites); no `smoke:*` in the chain; deps: `pg` only; `README` §"Not in this slice" | — |
| 9 | **Privacy / redaction** — no secrets/KEK/DEK/completion-secret, raw identity, provider refs, media titles, Jellyfin ids/tokens, DB URLs, or secret paths in any output/evidence/log | **met** | `src/ops/doctor.ts` header + `formatDoctorJson`; `src/core/redaction/noleak.ts`; CI: `test/adapter-privacy.ts`,`publisher-privacy.ts`,`jellyfin-privacy.ts`,`publish-erasure.ts`; redaction rules in Phases 15/16/19/20/21 | — |

## What "production ready" means for this system (do not overstate)

A deployment may be described as **production-ready** only when **every** row is either **met** or has its
**operator-provided evidence collected and retained**, AND the operator has explicitly accepted the two
**deferred** gates (O4, O5) as understood residual risk (FileCustodian is a hardened *reference harness*,
not a managed KMS; KEK rotation is manual, not scheduled). Until then the correct description is
**"production-gated pending operator evidence,"** with O4/O5 shown as `ops:doctor` WARN gates. Deferred and
operator-provided items are listed above precisely so they are **never hidden**.

## CI / test expectation (authoritative)

`npm run ci` = `npm run typecheck` then `npm run test` (33 embedded-PostgreSQL suites). The authoritative
signal is a **green run with 0 failures** — not a fixed pass count (the total grows as suites/assertions
are added; it was **369** at `phase-22`, up from 368 at the `phase-21` base). No Docker, no live network,
no live services in CI; the only runtime dependency is `pg`. `smoke:compose` and `smoke:jellyfin` are
opt-in operator tools and are **not** in the CI chain.

## Reconciled stale references (do not repeat these)

- The `README.md` "86 passed" figure was the **Phase-1-era** breakdown; the current authoritative total is
  a **green `npm run ci` with 0 failures** (33 suites; 369 at `phase-22`). Updated in README as part of this phase.
- `docs/PHASE_19` referenced "the Phase 18 production gate warnings" — there is **no Phase 18 doc**; the
  gate warnings are the two `ops:doctor` checks `production-gate-o4-external-custodian` /
  `production-gate-o5-managed-kek`. Corrected as part of this phase.
- The single source of truth for **gate status** is `docs/PHASE_3_DEPLOYMENT.md` §"Production gates"
  (O4 open / O5 open / memory CLOSED), mirrored by the two doctor WARN checks. This gate consolidates but
  does not override it.

## Redaction (applies to every row + all evidence)

Fill the shareable bundle in `docs/templates/PRODUCTION_READINESS_EVIDENCE.md` (and the Jellyfin sheet in
`docs/templates/JELLYFIN_VALIDATION_EVIDENCE.md`). Record **only** statuses, counts, timestamps, and
opaque ids **where the referenced template explicitly asks for them** — **never** API keys, KEKs/DEKs, the
completion secret, database URLs, secret file paths, raw media titles, provider-ref values, or **Jellyfin
IDs / collection handles / tokens**.

## Out of scope (unchanged)

No Plex, no provider/debrid adapters, no scraping/downloading/playback, no HTTP daemon/UI, **no live
network in CI**, no new runtime dependencies. No changes to encryption, custodian, KEK-rotation, or
Jellyfin behavior. Docs/spec/test only.
