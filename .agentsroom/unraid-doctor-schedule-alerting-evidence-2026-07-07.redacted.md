# Unraid Doctor Schedule And Alerting Evidence - Redacted

## Scope

- Evidence label: unraid-doctor-schedule-alerting-2026-07-07
- Host label: Tower
- Host type: Unraid
- User Script label: `catalog-doctor`
- Evidence path label: `/mnt/user/appdata/catalog/evidence`
- Redaction status: no secret values, database URLs, raw logs, notification tokens, or raw identity are retained here

## Schedule Evidence

- Scheduled cadence: hourly
- Evidence files observed from scheduled runs:
  - `doctor-20260707-024702.redacted.json`
  - `doctor-20260707-034701.redacted.json`
  - `doctor-20260707-044701.redacted.json`
  - `doctor-20260707-054701.redacted.json`
  - `doctor-20260707-064701.redacted.json`

## Alerting Wiring

- Unraid notify command available: yes
- `catalog-doctor` script includes `NOTIFY="/usr/local/emhttp/webGui/scripts/notify"`: yes
- Failure path writes redacted failure marker: yes
- Failure path invokes Unraid notification: yes
- Forced failure notification test performed: no

## Boundary

- This proves the hourly doctor schedule is producing redacted evidence.
- This proves the doctor script has an Unraid notification failure path wired.
- This does not prove a forced failure notification was received.
- This does not close O4 managed/external custodian evidence.
- This does not close O5 managed KEK custody or rotation automation evidence.
- This does not approve launch, production readiness, a release candidate, or a production release by itself.

