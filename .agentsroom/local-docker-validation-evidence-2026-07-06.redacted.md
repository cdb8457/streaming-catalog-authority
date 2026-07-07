# Local Docker Validation Evidence - Redacted

## Scope

- Evidence label: local-docker-desktop-compose-validation-2026-07-06
- Collection timestamp: 2026-07-06T20:41:25.5875687-05:00
- Host type: Windows Docker Desktop local validation
- Deployment type: Docker Compose, local development only
- Repository branch: master
- Commit: 057405ac5e96bbbe123361626ab8f77a4a195e6a
- Secret handling: local development secret files were generated under the gitignored `secrets/` directory
- Redaction status: no secret values, database URLs, secret file contents, raw logs, or private paths are retained here

## Commands And Results

| Command shape | Result | Redacted summary |
|---|---:|---|
| `npm run test:operator-validation-run-sheet` | PASS | 6 passed, 0 failed |
| `npm run smoke:compose` | PASS | Compose migration completed |
| `docker compose -f docker-compose.deploy.yml run --rm ops ops:init` | PASS | Migrations idempotently applied, completion secret provisioned, embedded doctor OK |
| `docker compose -f docker-compose.deploy.yml run --rm ops ops:doctor` | PASS | Standalone doctor OK |
| `docker compose -f docker-compose.deploy.yml run --rm ops ops:doctor -- --json` | PASS | JSON report `ok=true`, reportVersion 1 |

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

## Cleanup

- Compose services were stopped with `docker compose -f docker-compose.deploy.yml down`.
- Project containers/network were removed.
- Docker volumes were not deleted.
- Git working tree remained clean on `master` after validation.

## Boundary

- This is local Docker Desktop validation only.
- This does not replace Unraid host validation.
- This does not close O4 managed/external custodian evidence.
- This does not close O5 managed KEK custody or rotation automation evidence.
- This does not approve launch, production readiness, a release candidate, or a production release.

