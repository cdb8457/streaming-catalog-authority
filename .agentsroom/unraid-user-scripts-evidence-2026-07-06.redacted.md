# Unraid User Scripts Evidence - Redacted

## Scope

- Evidence label: unraid-user-scripts-install-proof-2026-07-06
- Host label: Tower
- Host type: Unraid
- User Scripts path label: `/boot/config/plugins/user.scripts/scripts`
- Catalog evidence path label: `/mnt/user/appdata/catalog/evidence`
- Repository commit: 057405ac5e96bbbe123361626ab8f77a4a195e6a
- Redaction status: no secret values, database URLs, notification tokens, backup contents, or raw identity are retained here

## Installed Script Labels

| Script label | Status | Purpose |
|---|---:|---|
| `catalog-doctor` | INSTALLED | run `ops:doctor -- --json` and retain redacted output |
| `catalog-backup-verify` | INSTALLED | dump backup, verify backup, retain redacted label |
| `catalog-kek-rewrap-plan` | INSTALLED | run non-mutating KEK rewrap plan and retain redacted JSON |

## Manual Proof Run

| Script label | Result | Evidence artifact label |
|---|---:|---|
| `catalog-doctor` | PASS | `doctor-20260706-215326.redacted.json` |
| `catalog-backup-verify` | PASS | `backup-verify-20260706-215333.redacted.txt` |
| `catalog-kek-rewrap-plan` | PASS | `kek-rewrap-plan-20260706-215341.redacted.json` |

## Backup Proof Summary

- Backup script completed with artifact label: `catalog-20260706-215333.json`
- Offline verify result: OK
- Table count: 5

## Remaining Schedule Work

- User Scripts entries exist and execute manually.
- Scheduled cadence in the Unraid UI is confirmed in `schedule.json`:
  - `catalog-doctor`: hourly
  - `catalog-backup-verify`: daily
  - `catalog-kek-rewrap-plan`: monthly
- Alerting/notification integration is not yet confirmed.
- Backup artifact encryption at rest is not yet confirmed.

## Boundary

- This proves the User Scripts entries were installed and runnable manually.
- This does not prove recurring schedule execution until the Unraid UI cadence is set and observed.
- This does not close O4 managed/external custodian evidence.
- This does not close O5 managed KEK custody or rotation automation evidence.
- This does not approve launch, production readiness, a release candidate, or a production release by itself.
