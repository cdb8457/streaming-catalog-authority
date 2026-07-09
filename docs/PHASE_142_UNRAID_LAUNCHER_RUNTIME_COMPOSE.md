# Phase 142 - Unraid Launcher Runtime Compose

Phase 142 adds `docker-compose.unraid.runtime.yml` for launchers that cannot use the repository
directory as a Docker build context.

There are now two supported Unraid operator paths:

- Repository clone path: use `docker-compose.unraid.yml`. It keeps `build: .` and is correct when
  the operator runs Docker Compose from `/mnt/user/appdata/catalog/repo`.
- Launcher/runtime path: use `docker-compose.unraid.runtime.yml`. It uses
  `${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}` so Arcane-style launchers do not need to
  resolve the repository as a build context and can later point at a published image.

Both paths use the same Unraid appdata locations:

- Postgres data: `/mnt/user/appdata/catalog/pgdata`
- FileCustodian keystore: `/mnt/user/appdata/catalog/keystore`
- Backups: `/mnt/user/appdata/catalog/backups`
- Secrets: `/mnt/user/appdata/catalog/secrets/*`

Launcher expected steady state:

- `catalogauthority-postgres-1` stays running and healthy.
- `catalogauthority-ops-1` exits with code 0 after commands such as `ops:migrate`; this is expected.

This phase does not add provider mode, publish ports, install Arcane/DockHand controls, or start a
new UI. It only makes the launcher path explicit so operators do not have to delete `build: .` from
the repository compose file.
