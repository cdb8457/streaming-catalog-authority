# Unraid Validation Checklist - Redacted

## Scope

- Evidence label: unraid-target-validation-pending
- Purpose: repeat the validated Docker Desktop deployment path on the intended Unraid host
- Boundary: catalog/privacy core only; no provider adapters, scraping, downloading, playback, UI, or HTTP service
- Retention rule: keep only command shapes, pass/fail statuses, counts, timestamps, and redacted labels

## Required Host Setup

- PostgreSQL 16 container is available for the catalog database.
- DB data is mapped to a dedicated path such as `/mnt/user/appdata/catalog/pgdata`.
- FileCustodian keystore is mapped to a separate path such as `/mnt/user/appdata/catalog/keystore`.
- Backup artifacts are mapped to a separate path such as `/mnt/user/appdata/catalog/backups`.
- Secret files are stored under a protected path such as `/mnt/user/appdata/catalog/secrets`.
- No secret values are placed directly in environment variables or compose files.

## Required Secret File Labels

Do not record contents or real paths in evidence.

| File label | Purpose |
|---|---|
| `postgres_password` | PostgreSQL superuser password file |
| `admin_database_url` | owner/migrator connection string file |
| `database_url` | least-privileged runtime connection string file |
| `completion_secret` | shred-completion attestation secret file |
| `custodian_kek` | decrypted base64 32-byte FileCustodian KEK file |

## One-Shot Validation Order

Run equivalent commands through the Unraid ops container or from a repo checkout on the Unraid host.

| Step | Command shape | Expected result |
|---:|---|---|
| 1 | `ops:migrate` | migration complete |
| 2 | `ops:init` | doctor OK after provisioning completion secret |
| 3 | `ops:doctor` | doctor OK |
| 4 | `ops:doctor -- --json` | `ok=true`, PASS/WARN/FAIL counts retained |

## Docker Compose Equivalent

If validating from a checkout using Compose on the Unraid host:

```bash
docker compose -f docker-compose.deploy.yml run --rm ops ops:migrate
docker compose -f docker-compose.deploy.yml run --rm ops ops:init
docker compose -f docker-compose.deploy.yml run --rm ops ops:doctor
docker compose -f docker-compose.deploy.yml run --rm ops ops:doctor -- --json
docker compose -f docker-compose.deploy.yml down
```

## Evidence To Retain

- Date/time.
- Host label: Unraid target validation.
- Commit or build label.
- Command shapes run.
- Pass/fail status for each command.
- Doctor report version.
- Doctor overall `ok`.
- PASS count.
- WARN count.
- FAIL count.
- Doctor check labels and statuses.
- Confirmation that secrets, DB URLs, real secret paths, raw logs, and artifact contents were not retained.

## Hold Triggers

- Any command exits non-zero.
- Any doctor check is FAIL.
- `database_url` uses an owner/superuser role instead of the least-privileged runtime role.
- `completion_secret` mismatch appears.
- Keystore, DB data, backups, and secrets are not on separate intended paths.
- Evidence contains secret values, database URLs, raw paths, raw logs, backup contents, media identity, provider refs, or tokens.
- O4 or O5 are described as closed without separate accepted evidence.

## Boundary Notes

- Passing Unraid validation supports target-host deployment readiness.
- It still does not close O4 managed/external custodian evidence.
- It still does not close O5 managed KEK custody or rotation automation evidence.
- It does not approve launch, production readiness, a release candidate, or a production release by itself.

