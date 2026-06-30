# Phase 3 — Deployment (Stage 3.4)

Catalog/privacy core only. **CLI/library model — no HTTP server, no long-running app daemon.**
Deployment is Postgres + on-demand one-shot ops containers (`migrate`, `backup`). Artifacts:
`docker-compose.deploy.yml`, the `ops:*` npm scripts, and the `*_FILE` secret indirection from
Stage 3.1/3.2.

## Topology

| Service | Role |
|---------|------|
| `postgres` | PostgreSQL 16; data on the `pgdata` volume; `pg_isready` healthcheck; password via `POSTGRES_PASSWORD_FILE`. |
| `ops` | One-shot CLI container (`entrypoint: npm run`). No ports, no daemon. Runs `ops:migrate` / `ops:backup` on demand. |

```bash
docker compose -f docker-compose.deploy.yml run --rm ops ops:migrate
docker compose -f docker-compose.deploy.yml run --rm ops ops:backup -- dump    /backups/cat.json
docker compose -f docker-compose.deploy.yml run --rm ops ops:backup -- restore /backups/cat.json
```

## Volume mappings (keep key material separate)

| Volume | Mounted at | Holds | Backed up by `BackupPolicy`? |
|--------|-----------|-------|------------------------------|
| `pgdata` | `/var/lib/postgresql/data` | DB (ciphertext + key-control) | the DB dump — **ciphertext only** |
| `keystore` | `/var/lib/catalog/keystore` | FileCustodian wrapped DEKs + tombstones | **NO — excluded by design** |
| `backups` | `/backups` | emitted backup artifacts | n/a (operator-encrypted at rest) |

The keystore is a **separate volume** from `pgdata`, so a Postgres backup can never include the
wrapped DEKs. This is the deployment-level enforcement of the Stage 3b key-material exclusion.

## Secret delivery (`*_FILE`)

No secret values appear in compose env or the image. Each is a file consumed via `*_FILE`:

| Secret file (`./secrets/…`) | Consumed as | By |
|------------------------------|-------------|----|
| `postgres_password` | `POSTGRES_PASSWORD_FILE` | postgres image |
| `admin_database_url` | `ADMIN_DATABASE_URL_FILE` | owner/migrator |
| `database_url` | `DATABASE_URL_FILE` | runtime role |
| `completion_secret` | `COMPLETION_SECRET_FILE` | custodian + DB `crypto_config` (must match) |
| `custodian_kek` | `CUSTODIAN_KEK_FILE` | FileCustodian (base64 32-byte KEK) |

Create `./secrets/*` (gitignored) before running. The restore **preflight** (Stage 3.3) verifies
the DB is reachable, the custodian is reachable, and `completion_secret` matches `crypto_config` —
refusing the restore otherwise.

## Operator-owned age wrapping (KEK)

The chosen first KEK direction is an **age-encrypted-file KEK**, handled **operator-side**, not
in-process (no age dependency is bundled). The KEK is stored age-encrypted at rest; the operator
decrypts it just before deploy and mounts the plaintext base64 KEK as `./secrets/custodian_kek`:

```bash
age --decrypt -i ~/.age/key.txt custodian_kek.age > ./secrets/custodian_kek   # operator step
```

The application only ever sees the decrypted KEK via `CUSTODIAN_KEK_FILE`. Backup artifacts are
likewise encrypted at rest by the operator (e.g. `... ops:backup -- dump /backups/cat.json` then
`age -r <recipient> /backups/cat.json > cat.json.age`); the erasure guarantee comes from
key-material exclusion, not artifact encryption.

## Unraid notes

- Add the **Postgres** container (Community Apps) with its `pgdata` mapped to
  `/mnt/user/appdata/catalog/pgdata`.
- Map the **keystore** to a **distinct** share path, e.g. `/mnt/user/appdata/catalog/keystore`
  (never the same dataset you back up the DB to).
- Put the secret files under a protected path (e.g. `/mnt/user/appdata/catalog/secrets/…`) and
  point the `*_FILE` env vars at them.
- The `ops` container is a **User Script / one-shot** invocation (migrate, scheduled backup), not
  an always-on container — there is no HTTP port to expose.

## Compose smoke test (opt-in / manual)

`npm run smoke:compose` runs a real migrate through compose. It is **NOT part of CI**: this repo's
test suite boots an **embedded PostgreSQL 16** specifically so CI needs no Docker daemon, and the
build/CI environment here has **no Docker available** (`docker: command not found`). Run the smoke
manually on a Docker host after creating `./secrets/*`:

```bash
npm run smoke:compose   # docker compose -f docker-compose.deploy.yml run --rm ops ops:migrate
```

A dependency-free **structural** check of these deployment artifacts runs in CI as `test/deploy.ts`
(asserts the services, healthcheck, separate volumes, `*_FILE` secrets, and the no-HTTP/no-ports
shape) so the topology is verified even where Docker is unavailable.

## Remaining production gates (open)

These are explicitly **open** and must be resolved (or formally accepted) before relying on this
deployment in production:

- **O4 — managed-KMS production custodian adapter (OPEN).** `FileCustodian` is a reference harness,
  not a managed KMS. The production custodian — a managed KMS implementing the `KeyCustodian`
  interface, run *outside* the app trust boundary — provides the real deletion/secrecy guarantee and
  is not built here; it would add a new `CUSTODIAN_MODE`.
- **O5 — age KEK rotation / rewrap automation (OPEN).** The KEK arrives operator-side (age-decrypted
  to `CUSTODIAN_KEK_FILE`). Versioned KEK rotation and the ciphertext rewrap workflow are not yet
  automated; rotating the KEK is a manual operator procedure for now.
- **`CUSTODIAN_MODE=memory` is dev/test ONLY — production guard OPEN.** The in-process memory
  custodian loses all keys on restart and enforces no trust boundary. An explicit application-level
  guard (refuse `memory` outside dev) or a firm operator prohibition is still open and applicable;
  until then it is the operator's responsibility never to run `memory` in production.

## Out of scope (unchanged)

No provider adapters / Real-Debrid / TorBox / Plex / Jellyfin, no scraping / downloading /
playback, no web or mobile UI, no HTTP framework, no cloud KMS SDK, and no in-process age
integration. Managed-KMS (design **O4**) remains the open production custodian gate.
