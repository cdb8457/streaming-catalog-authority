# Unraid Bind-Mount Validation Evidence - Redacted

## Scope

- Evidence label: unraid-bind-mount-validation-2026-07-06
- Host label: Tower
- Host type: Unraid
- Repository path label: `/mnt/user/appdata/catalog/repo`
- Repository commit: 057405ac5e96bbbe123361626ab8f77a4a195e6a
- Compose files: `docker-compose.deploy.yml` plus `docker-compose.unraid-bind.yml`
- Bind-mount layout: explicit appdata paths for Postgres data, keystore, backups, and secrets
- Redaction status: no secret values, database URLs, secret file contents, or artifact contents are retained here

## Commands And Results

| Command shape | Result | Redacted summary |
|---|---:|---|
| `docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml run --rm ops ops:init` | PASS | migrations applied, completion secret provisioned, embedded doctor OK |
| `docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml run --rm ops ops:doctor` | PASS | standalone doctor OK |
| `docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml run --rm ops ops:doctor -- --json` | PASS | JSON report `ok=true`, reportVersion 1 |
| `docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml down` | PASS | Postgres container and Compose network removed |

## Doctor Summary

- Overall `ok`: true
- Report version: 1
- PASS count: 12
- WARN count: 0
- FAIL count: 0
- FAIL checks observed: none
- WARN checks observed: none

## Doctor Check Labels

| Check label | Status |
|---|---:|
| environment | PASS |
| db-owner-reachable | PASS |
| db-app-reachable | PASS |
| schema-migrated | PASS |
| completion-secret | PASS |
| schema-version | PASS |
| publish-revocations | PASS |
| publish-intents | PASS |
| runtime-least-privileged | PASS |
| runtime-cannot-touch-secret | PASS |
| custodian-reachable | PASS |
| keystore | PASS |

## Boundary

- This validates the explicit Unraid bind-mount deployment layout.
- This still does not close O4 managed/external custodian evidence.
- This still does not close O5 managed KEK custody or rotation automation evidence.
- This does not approve launch, production readiness, a release candidate, or a production release by itself.

