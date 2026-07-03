# Release / Upgrade Checklist (operator)

Self-hosted catalog/privacy core. One-shot CLIs only. Details: `docs/PHASE_6_LIFECYCLE.md`.
Coordinator merge/tag gates for future phases are in `docs/PHASE_24_COORDINATOR_RELEASE_GATE.md`;
`ops:release-guard` / `docs/PHASE_27_RELEASE_GUARD.md` provides advisory read-only support, not approval.
Future production custodian adapter metadata must also satisfy the static Phase 28 contract in
`docs/PHASE_28_PRODUCTION_CUSTODIAN_CONTRACT.md` / `npm run test:production-custodian-contract`.
Use `docs/PHASE_29_CUSTODIAN_EVIDENCE_PREFLIGHT.md` / `ops:custodian-evidence-preflight` to preflight
one redaction-safe descriptor JSON file before O4 evidence review; it does not close O4.

## Before upgrading
- [ ] **Backup** the current DB: `ops:backup -- dump /backups/pre-upgrade-YYYY-MM-DD.json`
- [ ] **Verify** it offline: `ops:verify-backup -- /backups/pre-upgrade-YYYY-MM-DD.json`
- [ ] **Rehearse** the restore into a throwaway DB (recommended):
      `REHEARSAL_ADMIN_DATABASE_URL=<throwaway> ops:rehearse-restore -- /backups/pre-upgrade-YYYY-MM-DD.json`
- [ ] Confirm keystore + KEK + completion secret are backed up on **independent media**.

## Upgrade
- [ ] Deploy the new image.
- [ ] `ops:migrate` (idempotent; records the new schema version).
- [ ] `ops:version` — db == expected.
- [ ] `ops:doctor` — no FAIL checks; review any WARN checks. Expected O4/O5 production WARNs
      must be recorded in the readiness evidence bundle.
- [ ] O4/O5 remain visible: Phase 28 descriptor checks do not close O4, and managed KEK custody /
      scheduling remains open/deferred until separately accepted.
- [ ] If a production custodian descriptor is being reviewed, run
      `ops:custodian-evidence-preflight -- -- <descriptor.json> --json` and retain only the
      redaction-safe report; confirm `closesO4:false`.

## Post-upgrade
- [ ] `ops:doctor --json` wired into the unattended healthcheck (cron / Unraid User Scripts).
- [ ] Smoke: read a known item; run a fresh `ops:backup -- dump`.
- [ ] If production readiness is being reviewed, complete
      `docs/templates/PRODUCTION_READINESS_EVIDENCE.md` using
      `docs/PHASE_19_PRODUCTION_READINESS_EVIDENCE.md` and package it with
      `docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md`; keep live evidence manual/operator-run and
      redaction-safe.
- [ ] Optional pre-review rehearsal: run `ops:readiness-plan` and `ops:evidence-rehearsal` to confirm
      the Phase 22/23 artifact labels, package shape, and redaction boundaries before collecting real
      evidence.
- [ ] If recurring operations are being configured, use
      `docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md` as operator-owned schedule/retention guidance;
      do not add repo-owned cron, daemon, or default scheduling behavior.

## Rollback (if the new version misbehaves)
- [ ] Redeploy the previous image.
- [ ] `ops:backup -- restore /backups/pre-upgrade-YYYY-MM-DD.json` (preflight + integrity gate).
- [ ] `ops:doctor` — confirm no FAIL checks; review WARNs.

> No down-migrations exist by design — **rollback = restore the pre-upgrade backup**. That is why
> the pre-upgrade backup + rehearsal steps are mandatory.
