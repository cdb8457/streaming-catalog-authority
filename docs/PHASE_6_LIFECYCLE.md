# Phase 6 — Operational Lifecycle (upgrade / verify / rehearse / recover)

Catalog/privacy core, CLI/library/docs only — **no HTTP, no UI**. Builds on the Phase 5 runbook
(`docs/PHASE_5_RUNBOOK.md`) and deployment (`docs/PHASE_3_DEPLOYMENT.md`).

## Schema version + upgrade safety

The DB records its migration generation in owner-only `schema_meta.version`; the build declares the
expected `MIGRATION_VERSION` (`src/db/schema-version.ts`). Check alignment any time:

```bash
npm run ops:version      # db=<n> expected=<n> — OK / MISMATCH (run ops:migrate)
npm run ops:doctor       # includes a schema-version check (FAIL on mismatch)
```

**Rollback model (accepted):** there are **no down-migrations**. The supported rollback is to
**restore the pre-upgrade backup**. So the upgrade procedure is backup-first:

### Upgrade procedure
1. `npm run ops:backup -- dump /backups/pre-upgrade-$(date +%F).json`  — the rollback point.
2. `npm run ops:verify-backup -- /backups/pre-upgrade-...json`  — offline sanity.
3. *(recommended)* `REHEARSAL_ADMIN_DATABASE_URL=... npm run ops:rehearse-restore -- /backups/pre-upgrade-...json` — prove it actually restores.
4. Deploy the new image; `npm run ops:migrate` (idempotent; records the new `MIGRATION_VERSION`).
5. `npm run ops:doctor` — must have no FAIL checks; review WARN checks.

### Rollback procedure (if the new version misbehaves)
1. Redeploy the previous image.
2. `npm run ops:backup -- restore /backups/pre-upgrade-...json` (preflight + integrity gate).
3. `npm run ops:doctor` — confirm no FAIL checks; review WARNs.

## Backup verification & restore rehearsal

- **Offline** (fast, no DB, no secrets): `npm run ops:verify-backup -- <file>` — structural sanity
  (version, tables, item-heads backed by events, no dangling refs/key-control).
- **Full rehearsal** (DB-backed proof): `REHEARSAL_ADMIN_DATABASE_URL=<throwaway-db> npm run
  ops:rehearse-restore -- <file>` — migrates the throwaway DB, restores through the **real**
  integrity gate, and reads a sample. It **never touches production** and **hard-refuses** if the
  rehearsal DB resolves to a production DB (same `host:port/dbname` as `ADMIN_DATABASE_URL` or
  `DATABASE_URL`). Use a genuinely separate database. `memory` custodian cannot decrypt in a
  rehearsal — use the `file` custodian (real keys).

For a shareable production-readiness evidence bundle, use
`docs/PHASE_19_PRODUCTION_READINESS_EVIDENCE.md` and
`docs/templates/PRODUCTION_READINESS_EVIDENCE.md`. The bundle records doctor JSON, offline backup
verification, restore rehearsal, and KEK rewrap-plan evidence without including secrets, raw
identity, provider refs, key material, full env dumps, or production database URLs.

For operator-owned Unraid User Scripts or cron cadence examples, retention guidance, and alert
triage, use `docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md`. The repo does not install or run any
scheduler.

## Unattended healthcheck (Unraid / cron)

`ops:doctor --json` emits a stable contract (`{ reportVersion, ok, checks[] }`, redaction-safe) and
exits non-zero on any failure — suitable for scheduled monitoring. Unraid User Scripts example
(cron), alerting on failure:

```bash
#!/bin/bash
cd /path/to/app
OUT=$(npm run --silent ops:doctor -- --json) || {
  echo "catalog-authority doctor FAILED: $OUT" | /usr/local/emhttp/webGui/scripts/notify -e "catalog doctor" -s "doctor failed" -i alert
  exit 1
}
```

An *unexpected* inability to run the runtime-privilege probes is a **hard fail** (fail-closed), so a
broken probe can never mask an over-privileged `DATABASE_URL`.

## Disaster-recovery rehearsal checklist

Rehearse DR **before** you need it — on a schedule, against a throwaway DB:

1. `ops:verify-backup` the latest artifact (offline).
2. `ops:rehearse-restore` it into a fresh throwaway DB with the **real** KEK + completion secret.
3. Confirm the rehearsal report has no FAIL outcome (migrate → provision-secret → restore → sample-read).
4. Drop the throwaway DB.

If the rehearsal fails, the backup or the key material is not recoverable — fix it **now**. Keep the
DB backup and the keystore/KEK on **independent media** (a single location holding both defeats
crypto-shredding). Full DR matrix: `docs/PHASE_5_RUNBOOK.md`.

## Out of scope (unchanged)
No provider adapters / Real-Debrid / TorBox / Plex / Jellyfin / Hermes, no scraping / downloading /
playback, no web/mobile UI, no HTTP daemon, no cloud KMS SDK. Open gates: **O4** managed-KMS, **O5**
age KEK rotation *automation* (rewrap tooling exists via `ops:rewrap-kek`).
