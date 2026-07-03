# Phase 23 - Operator Evidence Packaging

Phase 23 packages the Phase 22 production-readiness gate into a redaction-safe evidence map for a
self-hosted or Unraid operator. It adds no runtime behavior, scheduler, Docker default, service,
provider integration, Jellyfin behavior, KMS adapter, or network requirement.

Use this document with the authoritative gate in `docs/PHASE_22_PRODUCTION_READINESS_GATE.md` and the
report template in `docs/templates/PRODUCTION_READINESS_EVIDENCE.md`. Store only redacted summaries,
status records, and operator conclusions. Keep raw command output, backup artifacts, key material,
database URLs, secret file paths, full environments, and live service credentials out of the
shareable evidence bundle.

## Storage And Retention

Suggested operator-controlled layout:

```text
<operator-evidence-root>/
  phase-22-readiness/
    YYYY-MM-DD/
      README.redacted.md
      01-deployment-unraid.redacted.md
      02-external-custodian-o4.redacted.md
      03-kek-rotation-o5.redacted.md
      04-backup-restore-retention.redacted.md
      05-doctor-warning-gates.redacted.json
      06-scheduled-operator-tasks.redacted.md
      07-jellyfin-validation.redacted.md
      08-ci-test-expectations.redacted.md
      09-privacy-redaction.redacted.md
      production-readiness-evidence.redacted.md
```

Keep this directory on operator-controlled media with the same retention policy as other operational
evidence. Do not place it inside the main DB backup artifact. Do not co-locate DB backup artifacts
with the FileCustodian keystore, KEK, completion secret, or secret files; those belong on independent
media and separate failure domains as described in `docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md`.

## Phase 22 Gate Evidence Map

| # | Phase 22 criterion | Status | Command shape or evidence source | Suggested redacted artifact | Retention location | Never paste or retain in the evidence bundle |
|---|---|---|---|---|---|---|
| 1 | Deployment / Unraid config | in-repo met | Review `docker-compose.deploy.yml`, `deploy/unraid-catalog-authority.xml`, `docs/PHASE_3_DEPLOYMENT.md`; optional local static check: `npm run test:deploy` | `01-deployment-unraid.redacted.md` | `<operator-evidence-root>/phase-22-readiness/YYYY-MM-DD/` | Real `*_FILE` target paths, database URLs, secret values, local mount names that reveal private layout, or full compose overrides |
| 2 | External custodian / KMS (O4) | deferred; operator-provided only when a real adapter is validated | Deterministic harness: `npm run test:custodian-acceptance`; live/manual adapter validation per `docs/PHASE_21_EXTERNAL_CUSTODIAN_ACCEPTANCE.md` | `02-external-custodian-o4.redacted.md` | Same readiness directory; keep any live raw adapter logs outside the shareable bundle | KMS credentials, API keys, tokens, request/response bodies, endpoints if sensitive, raw key ids if classified sensitive, secret paths, raw harness debug output |
| 3 | KEK rotation (O5) | met for tooling; deferred for managed custody/scheduling automation | `npm run ops:rewrap-kek -- --plan --json`; rotation record if a manual rotation is performed | `03-kek-rotation-o5.redacted.md` | Same readiness directory; retain with release/rotation records | KEK values, wrapping keys, age identities, private keys, secret file paths, command environments, or mutation logs containing secrets |
| 4 | Backup/restore + retention | met for tooling; operator-provided for retention execution | `npm run ops:backup -- dump <artifact>`; `npm run ops:verify-backup -- <artifact>`; `REHEARSAL_ADMIN_DATABASE_URL=<throwaway-db> npm run ops:rehearse-restore -- <artifact>`; retention record from Phase 20 | `04-backup-restore-retention.redacted.md` | Same readiness directory; actual backup artifacts stay in the operator backup store | Backup artifact contents, ciphertext payloads, row dumps, database URLs, credential-bearing paths, production rehearsal targets, keystore/KEK/completion-secret material |
| 5 | `ops:doctor` / warning gates | in-repo met | `npm run ops:doctor -- --json`; summarize PASS/WARN/FAIL and the two production-gate WARN checks | `05-doctor-warning-gates.redacted.json` | Same readiness directory; rotate with health evidence cadence | Full environments, secret paths, database URLs, unreviewed raw logs, or any local wrapper output that adds sensitive context |
| 6 | Scheduled operator tasks | operator-provided | Unraid User Scripts or cron entries based on `docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md`; alert triage record for `ops:doctor --json` non-zero | `06-scheduled-operator-tasks.redacted.md` | Same readiness directory; retain current schedule plus recent execution history | Real notification tokens, webhook URLs, local secret paths, full shell history, raw alert payloads, or private mount topology |
| 7 | Jellyfin validation evidence | operator-provided; mapping remains provisional until live evidence exists | `npm run smoke:jellyfin -- <kind> <id>` for read-only validation; gated `npm run smoke:jellyfin -- --write <kind> <id>` only when operator intends a live round trip; use `docs/templates/JELLYFIN_VALIDATION_EVIDENCE.md` | `07-jellyfin-validation.redacted.md` | Same readiness directory; keep separate from Jellyfin server exports/logs | Jellyfin tokens, item ids, collection handles, media titles, screenshots, server URLs if sensitive, raw provider refs, or write-smoke cleanup logs with identity |
| 8 | CI / test expectations | in-repo met | `npm run ci` for deterministic local validation; `npm run typecheck`; `npm run test:deploy`; confirm `smoke:*` scripts are not in CI | `08-ci-test-expectations.redacted.md` | Same readiness directory; retain with release evidence | Network credentials, Docker daemon logs, live-service output, production database credentials, or claims that opt-in smoke tests are CI requirements |
| 9 | Privacy / redaction | in-repo met | Review redaction-sensitive outputs and completed evidence sheets; relevant deterministic suites are in `npm run ci` | `09-privacy-redaction.redacted.md` | Same readiness directory; retain with the evidence bundle | Secrets, KEKs, DEKs, completion secrets, HMAC secrets, API keys, tokens, credentials, raw identity, provider refs, media titles, Jellyfin ids/handles/tokens, DB URLs, secret paths, artifact contents, full env dumps, screenshots containing identity |

## Packaging Steps

1. Start from a clean checkout of the commit being reviewed and record only the commit or build id.
2. Run deterministic in-repo checks as needed: `npm run test:deploy`, `npm run typecheck`, and
   optionally `npm run ci`. These must not require Docker, network, live Jellyfin, live external
   custodian, cloud services, age tooling, production databases, or operator credentials.
3. Run operator-owned commands only on the intended deployment and collect redacted summaries into
   the artifact filenames above.
4. Complete `docs/templates/PRODUCTION_READINESS_EVIDENCE.md` as
   `production-readiness-evidence.redacted.md`.
5. Review O4 and O5 explicitly. O4 remains open unless a real external/managed custodian adapter has
   passed live operator validation and that evidence is reviewed. O5 remains open unless managed age
   KEK custody plus rotation automation/scheduling has separate evidence or is formally accepted as
   residual risk.
6. Retain the completed package on operator-controlled media according to the Phase 20 retention
   policy. Do not commit local evidence packages to this repository.

## Review Boundary

`FileCustodian` is a hardened reference harness, not a production KMS. Its deterministic tests and
acceptance harness support review, but they do not by themselves close O4. The KEK rewrap plan is a
non-mutating preflight; it does not by itself close O5.

The correct readiness phrase before all operator-provided evidence is collected and O4/O5 are
resolved or formally accepted is: production-gated pending operator evidence.
