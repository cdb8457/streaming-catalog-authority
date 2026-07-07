# Unraid Validation Evidence - Redacted

## Scope

- Evidence label: unraid-compose-validation-2026-07-06
- Host label: Tower
- Host type: Unraid
- Kernel label: Linux 6.12.54-Unraid x86_64
- Docker version: 27.5.1
- Docker Compose version: v2.40.3
- Repository path label: `/mnt/user/appdata/catalog/repo`
- Repository commit: 057405ac5e96bbbe123361626ab8f77a4a195e6a
- Secret handling: Unraid-local validation secret files were generated under the repo's gitignored `secrets/` directory
- Redaction status: no secret values, database URLs, secret file contents, raw private paths beyond the app label, or artifact contents are retained here

## Commands And Results

| Command shape | Result | Redacted summary |
|---|---:|---|
| `docker compose -f docker-compose.deploy.yml run --rm ops ops:migrate` | PASS | migration complete |
| `docker compose -f docker-compose.deploy.yml run --rm ops ops:init` | PASS | migrations applied, completion secret provisioned, embedded doctor OK |
| `docker compose -f docker-compose.deploy.yml run --rm ops ops:doctor` | PASS | standalone doctor OK |
| `docker compose -f docker-compose.deploy.yml run --rm ops ops:doctor -- --json` | PASS | JSON report `ok=true`, reportVersion 1 |
| `docker compose -f docker-compose.deploy.yml down` | PASS | Postgres container and Compose network removed |

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

## Deployment Caveat

- This validation used `docker-compose.deploy.yml` as written.
- That Compose file uses Docker named volumes: `repo_pgdata`, `repo_keystore`, and `repo_backups`.
- A final Unraid production configuration should bind DB data, keystore, backups, and secrets to explicit separated Unraid paths according to the Unraid template/runbook.
- This evidence proves the Unraid host can build and run the catalog authority Compose path successfully; it does not by itself prove the final explicit Unraid volume mapping.

## Boundary

- This does not close O4 managed/external custodian evidence.
- This does not close O5 managed KEK custody or rotation automation evidence.
- This does not approve launch, production readiness, a release candidate, or a production release by itself.

