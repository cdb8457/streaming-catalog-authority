# Phase 95 - O4/O5 Hardening Review Handoff

Phase 95 is a planning-only O4/O5 hardening package. It converts existing O4/O5 readiness,
descriptor preflight, Unraid operations evidence, and crypto-shredding boundaries into a staged
review plan.

This handoff does not add implementation, runtime behavior, SDKs, services, schedulers, provider
integrations, media-server workflows, UI, or live-service contact. It does not close O4 or O5.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Included Documents

- `docs/PHASE_95_O4_O5_HARDENING_PLAN.md`
  - Overall sequence and scope boundary.
- `docs/PHASE_95_1_O4_O5_EVIDENCE_PACKET.md`
  - Label-only O4/O5 readiness packet shape and redaction-safe examples.
- `docs/PHASE_95_2_EXTERNAL_CUSTODIAN_ADAPTER_DESIGN.md`
  - External custodian adapter design boundary, candidate directions, failure-mode matrix, and
    evidence plan.
- `docs/PHASE_95_3_O5_MANAGED_KEK_CUSTODY_RUNBOOK.md`
  - O5 KEK custody runbook, rotation cadence, alert triage labels, and manual approval boundary.
- `docs/PHASE_95_4_IMPLEMENTATION_AUTHORIZATION_GATE.md`
  - Required operator decision record and hold conditions before any implementation can start.

## Local Evidence Notes

The following `.agentsroom` files are local evidence notes and should remain uncommitted unless the
operator explicitly decides otherwise:

- `.agentsroom/unraid-mcp-readonly-inspection-2026-07-07.redacted.md`
- `.agentsroom/unraid-ssh-deployment-checkpoint-2026-07-07.redacted.md`

They record MCP/SSH inspection and deployment checks without secret contents, raw logs, database URLs,
passphrases, KEKs, DEKs, backup contents, or artifact contents.

## Current Verified Baseline

- Unraid MCP was reachable and healthy.
- SSH access was enabled and verified with a dedicated local key.
- Catalog deployment root was found at `/mnt/user/appdata/catalog`.
- Expected User Scripts were present:
  - `catalog-doctor`
  - `catalog-backup-verify`
  - `catalog-kek-rewrap-plan`
- `ops:doctor -- --json` passed all checks on Unraid.
- `ops:rewrap-kek -- --plan --json` returned ready, non-mutating status with zero live key files.
- The three catalog User Scripts were run once and produced fresh redacted evidence labels.
- Backup directory contained encrypted backup artifacts only; no plaintext backup JSON candidates were
  observed after the script run.

## Review Checklist

Before merging or using Phase 95 as the basis for implementation planning, confirm:

- all Phase 95 docs describe planning/design/runbook/gate work only;
- no adapter implementation was added;
- no cloud/vendor SDK was added;
- no HTTP service, daemon, scheduler, network client, or Unraid service was added;
- no provider/debrid/Plex/Jellyfin/scraping/downloading/playback/UI work was added;
- O4 and O5 are still open/deferred;
- `FileCustodian` is still described as a reference harness, not production KMS;
- evidence examples are label-only and redaction-safe;
- implementation remains blocked until the Phase 95.4 decision record exists.

## Suggested Reviewer Focus

Reviewer should check:

- whether Stage 95.1 label requirements match Phase 29 and Phase 30 preflight semantics;
- whether Stage 95.2 failure modes are complete enough for the first custodian implementation slice;
- whether Stage 95.3 manual approval boundary is strong enough to prevent accidental mutating rewrap;
- whether Stage 95.4 hold conditions are strict enough to prevent scope creep;
- whether README and `test/deploy.ts` guard the docs-only boundary.

## Post-Review Next Step

If Phase 95 is accepted, the next action is not implementation by default. The next action is an
operator decision record under Phase 95.4 choosing one narrow implementation slice or explicitly
deferring implementation.

If that decision record is missing, continue planning/review only.
