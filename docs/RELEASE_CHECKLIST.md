# Release / Upgrade Checklist (operator)

Self-hosted catalog/privacy core. One-shot CLIs only. Details: `docs/PHASE_6_LIFECYCLE.md`.

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
- [ ] `ops:doctor` — **all green** (schema-version, runtime least-privilege, secret match, custodian, keystore).

## Post-upgrade
- [ ] `ops:doctor --json` wired into the unattended healthcheck (cron / Unraid User Scripts).
- [ ] Smoke: read a known item; run a fresh `ops:backup -- dump`.

## Rollback (if the new version misbehaves)
- [ ] Redeploy the previous image.
- [ ] `ops:backup -- restore /backups/pre-upgrade-YYYY-MM-DD.json` (preflight + integrity gate).
- [ ] `ops:doctor` — confirm green.

> No down-migrations exist by design — **rollback = restore the pre-upgrade backup**. That is why
> the pre-upgrade backup + rehearsal steps are mandatory.
