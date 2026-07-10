# Phase 3 — Deployment (Stage 3.4)

Catalog/privacy core plus the Phase 147 read-only operator service. Deployment is Postgres, a
long-running operator API/UI container, and on-demand one-shot ops containers (`migrate`, `backup`).
Artifacts:
`docker-compose.deploy.yml`, `docker-compose.unraid.yml`, `docker-compose.unraid.runtime.yml`, the
`ops:*` npm scripts, and the `*_FILE` secret indirection from Stage 3.1/3.2. For Unraid, operators
choose one file for their launch path; they should not need layered `-f` compose files.

## Topology

| Service | Role |
|---------|------|
| `postgres` | PostgreSQL 16; data on the `pgdata` volume; `pg_isready` healthcheck; password via `POSTGRES_PASSWORD_FILE`. |
| `ops` | One-shot CLI container (`entrypoint: npm run`). No ports, no daemon. Runs `ops:migrate` / `ops:backup` on demand. |
| `app` | Long-running read-only operator API/UI (`ops:operator-ui-server`) on intentional port `8099`; token-protected status/log APIs. |

```bash
docker compose -f docker-compose.deploy.yml run --rm ops ops:migrate
docker compose -f docker-compose.deploy.yml run --rm ops ops:backup -- dump    /backups/cat.json
docker compose -f docker-compose.deploy.yml run --rm ops ops:backup -- restore /backups/cat.json
```

On Unraid from a cloned repository, use the single merged stack file:

```bash
cd /mnt/user/appdata/catalog/repo
docker compose -f docker-compose.unraid.yml up -d postgres app
docker compose -f docker-compose.unraid.yml ps -a
docker compose -f docker-compose.unraid.yml run --rm ops ops:doctor -- --json
```

For Arcane or other launchers that cannot use the repository directory as a build context, use the
runtime variant instead:

```bash
docker compose -f docker-compose.unraid.runtime.yml up -d postgres app
```

The runtime variant defaults to the locally built ops image:

```bash
CATALOG_AUTHORITY_OPS_IMAGE=repo-ops:latest
```

When a public image is published, point launchers at it without editing YAML:

```bash
export CATALOG_AUTHORITY_OPS_IMAGE=ghcr.io/OWNER/catalog-authority-ops:TAG
docker compose -f docker-compose.unraid.runtime.yml up -d postgres app
```

Image publishing is not automatic. Use the local verification scripts first:

```bash
npm run image:build:local
npm run image:inspect:local
```

See `docs/PHASE_145_IMAGE_PUBLISHING_READINESS.md` before pushing any public image.

Arcane custom commands or Unraid User Scripts can call the bundled launcher:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh start-postgres
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh doctor
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh backup
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh rewrap-plan
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
| `operator_ui_token` | `OPERATOR_UI_TOKEN_FILE` | Phase 147 operator API/UI local admin auth |

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

- Use **`docker-compose.unraid.yml`** when running from a cloned repo on Unraid.
- Use **`docker-compose.unraid.runtime.yml`** for Arcane/launcher paste-in flows where `build: .`
  would fail because the launcher cannot see the repo path.
- It maps `pgdata` to `/mnt/user/appdata/catalog/pgdata`.
- It maps the keystore to `/mnt/user/appdata/catalog/keystore`, separate from DB data and backups.
- It maps backups to `/mnt/user/appdata/catalog/backups`.
- It reads secret files from `/mnt/user/appdata/catalog/secrets/...`.
- `custodian_kek_previous` is not part of the steady-state compose file. The launcher mounts it only
  for `rewrap-plan` / KEK rotation windows; remove the file after review or rotation.
- The `ops` container is a **User Script / one-shot** invocation (migrate, scheduled backup), not an always-on container.
- The `app` container is the first always-on service. It exposes only `8099:8099` for the read-only operator API/UI and requires `X-Operator-UI-Secret` for `/api/status` and `/api/logs`.
- Use `deploy/unraid-ops-launcher.sh` for short Arcane/User Scripts commands backed by
  `docker-compose.unraid.runtime.yml`.

## Compose smoke test (opt-in / manual)

`npm run smoke:compose` runs a real migrate through compose. It is **NOT part of CI**: this repo's
test suite boots an **embedded PostgreSQL 16** specifically so CI needs no Docker daemon, and the
build/CI environment here has **no Docker available** (`docker: command not found`). Run the smoke
manually on a Docker host after creating `./secrets/*`:

```bash
npm run smoke:compose   # docker compose -f docker-compose.deploy.yml run --rm ops ops:migrate
```

A dependency-free **structural** check of these deployment artifacts runs in CI as `test/deploy.ts`
(asserts the services, healthchecks, separate volumes, `*_FILE` secrets, one-shot `ops`, and the
single intentional `app` port) so the topology is verified even where Docker is unavailable.

## Production gates

**Still open** (must be resolved or formally accepted before production):

- **O4 — managed-KMS production custodian adapter (OPEN).** `FileCustodian` is a reference harness,
  not a managed KMS. The production custodian — a managed KMS implementing the `KeyCustodian`
  interface, run *outside* the app trust boundary — provides the real deletion/secrecy guarantee and
  is not built here; it would add a new `CUSTODIAN_MODE`. Phase 16 narrows the acceptance boundary
  and required redaction-safe evidence in `docs/PHASE_16_EXTERNAL_CUSTODIAN_READINESS.md`; live
  external custodian validation remains operator-run and must not become a CI requirement.
- **O5 — age KEK rotation *automation* (OPEN).** The rewrap **tooling exists** — `ops:rewrap-kek`
  re-wraps every live DEK from `CUSTODIAN_KEK_PREVIOUS` to `CUSTODIAN_KEK` (resumable; identity
  ciphertext untouched; see the runbook), and Phase 17 adds a non-mutating
  `ops:rewrap-kek -- --plan` preflight with redaction-safe aggregate counts. What remains open is
  **automation / managed rotation** (scheduling, age-key custody, zero-touch re-keying); rotating
  the KEK is still an explicit manual operator procedure today.

**Closed / enforced** (no longer an open gate):

- **`CUSTODIAN_MODE=memory` production guard — CLOSED (enforced, Phase 4).** The in-process memory
  custodian is dev/test only (it loses all keys on restart and enforces no trust boundary).
  `CUSTODIAN_MODE=memory` is now **refused in production** (`APP_ENV`/`NODE_ENV=production`) by
  `loadCustodianConfig`; the only override is the explicit `CUSTODIAN_ALLOW_INSECURE_MEMORY=true`
  (not recommended). `ops:doctor` also fails the durability check if `memory` is used in production.

`ops:doctor` now makes the open O4/O5 gates visible to operators in text and `--json` output
without making them hard failures. In production, `CUSTODIAN_MODE=file` emits
`production-gate-o4-external-custodian` as WARN to state that `FileCustodian` is still a reference
harness, and every production report emits `production-gate-o5-managed-kek` as WARN until managed
age KEK custody/scheduling exists. The O5 warning points operators to the redaction-safe preflight
path: `ops:rewrap-kek -- --plan`.

## Out of scope (unchanged)

No provider adapters / Real-Debrid / TorBox / Plex / Jellyfin, no scraping / downloading /
playback, no web or mobile UI, no HTTP framework, no cloud KMS SDK, and no in-process age
integration. Managed-KMS (design **O4**) remains the open production custodian gate.
