# Unraid Backup And Restore Evidence - Redacted

## Scope

- Evidence label: unraid-backup-restore-validation-2026-07-06
- Host label: Tower
- Host type: Unraid
- Repository path label: `/mnt/user/appdata/catalog/repo`
- Repository commit: 057405ac5e96bbbe123361626ab8f77a4a195e6a
- Compose files: `docker-compose.deploy.yml`, `docker-compose.unraid-bind.yml`, and temporary `docker-compose.rehearsal.yml`
- Redaction status: no secret values, database URLs, secret file contents, backup artifact contents, row dumps, or raw identity are retained here

## Backup And Verify Results

| Command shape | Result | Redacted summary |
|---|---:|---|
| `docker compose ... run --rm ops ops:backup -- dump <artifact>` | PASS | backup dump completed |
| `docker compose ... run --rm ops ops:verify-backup -- <artifact>` | PASS | offline structural check passed |
| `docker compose ... down` | PASS | validation container/network removed |

## Backup Artifact Label

- Artifact label: `catalog-20260706-213318.json`
- Artifact summary: 5 tables; ciphertext only; no key material
- Verification summary: OK; 5 tables; offline structural check passed
- Retention note: artifact should be encrypted at rest by the operator

## Restore Rehearsal Results

| Step label | Result | Redacted summary |
|---|---:|---|
| rehearsal-postgres startup | PASS | isolated throwaway Postgres service started |
| migrate | PASS | rehearsal schema applied |
| provision-secret | PASS | completion secret set in rehearsal DB |
| restore | PASS | artifact restored; integrity gate passed |
| sample-read | PASS | no present item to sample in empty/forgotten backup |
| cleanup | PASS | rehearsal and live validation containers/network removed |

## Restore Rehearsal Label

- Rehearsal label: `20260706-213435`
- Overall result: `rehearse-restore: OK`
- Production database targeted: no
- Throwaway database used: yes

## Boundary

- This validates backup dump, offline structural verification, and isolated restore rehearsal on Unraid.
- This does not prove scheduled backup automation is installed.
- This does not prove backup artifact encryption at rest is configured.
- This still does not close O4 managed/external custodian evidence.
- This still does not close O5 managed KEK custody or rotation automation evidence.
- This does not approve launch, production readiness, a release candidate, or a production release by itself.

