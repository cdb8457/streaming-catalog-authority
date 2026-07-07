# Unraid Schedule And Retention Evidence - Redacted

## Scope

- Evidence label: unraid-schedule-retention-plan-2026-07-06
- Host label: Tower
- Host type: Unraid
- Repository path label: `/mnt/user/appdata/catalog/repo`
- Repository commit: 057405ac5e96bbbe123361626ab8f77a4a195e6a
- Status: schedule plan documented; installation/automation not yet proven
- Redaction status: no secret values, database URLs, notification tokens, webhook URLs, raw paths beyond app labels, backup contents, or raw logs are retained here

## Proposed Cadence

| Operation | Proposed cadence | Evidence retained |
|---|---|---|
| `ops:doctor -- --json` | every 15-60 minutes | latest redacted doctor JSON summary and alert status |
| `ops:backup -- dump <artifact>` | daily, plus before upgrades | artifact label, timestamp, command status |
| `ops:verify-backup -- <artifact>` | after every backup | pass/fail, table count, timestamp |
| `ops:rehearse-restore -- <artifact>` | monthly and before major upgrades | rehearsal label, pass/fail, isolated DB confirmation |
| `ops:rewrap-kek -- --plan --json` | monthly and before planned KEK rotation | `mutates:false`, count summary, timestamp |

## Known Passing Manual Evidence

| Evidence area | Current result |
|---|---:|
| Unraid bind-mounted `ops:init` / `ops:doctor` | PASS |
| Backup dump | PASS |
| Offline backup verification | PASS |
| Isolated restore rehearsal | PASS |
| KEK rewrap plan preflight | PASS |

## Retention Rules

- Retain command shape, pass/fail status, timestamps, fixed labels, and aggregate counts only.
- Retain backup artifact labels, not artifact contents.
- Retain rehearsal labels, not rehearsal database URLs.
- Retain doctor check labels and statuses, not raw command environments.
- Keep DB backup artifacts separate from keystore, KEK, completion secret, and secret files.
- Encrypt backup artifacts at rest through operator-controlled storage or wrapping.

## Installation Status

- Unraid schedule installation: not yet proven.
- Alerting integration: not yet proven.
- Backup artifact encryption at rest: not yet proven.
- Restore rehearsal cleanup policy: manually tested; recurring policy not yet proven.

## Hold Triggers

- Any scheduled command exits non-zero without alerting.
- Backup verify is not run after backup dump.
- Restore rehearsal targets production DB instead of isolated throwaway DB.
- Evidence retains secret values, database URLs, raw logs, backup contents, or raw identity.
- Backup artifacts are co-located with keystore, KEK, completion secret, or secret files.
- O4 or O5 are described as closed without separate accepted evidence.

## Boundary

- This documents the intended operational cadence and retention rules.
- This does not prove Unraid User Scripts or cron jobs are installed.
- This does not prove notification/alerting works.
- This does not close O4 managed/external custodian evidence.
- This does not close O5 managed KEK custody or rotation automation evidence.
- This does not approve launch, production readiness, a release candidate, or a production release by itself.

