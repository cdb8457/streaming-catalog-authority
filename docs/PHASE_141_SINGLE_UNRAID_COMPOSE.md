# Phase 141 - Single Unraid Compose File

Phase 141 makes `docker-compose.unraid.yml` the single canonical Compose file for the Unraid deployment.

The file merges the generic production topology with the Unraid appdata bind mounts:

- Postgres data: `/mnt/user/appdata/catalog/pgdata`
- FileCustodian keystore: `/mnt/user/appdata/catalog/keystore`
- Backups: `/mnt/user/appdata/catalog/backups`
- Secrets: `/mnt/user/appdata/catalog/secrets/*`

Operators should use:

```bash
cd /mnt/user/appdata/catalog/repo
docker compose -f docker-compose.unraid.yml ps -a
docker compose -f docker-compose.unraid.yml run --rm ops ops:doctor -- --json
```

This does not add provider mode, publish ports, install Arcane/DockHand controls, or start a new UI. It only removes the need to layer `docker-compose.deploy.yml` with an Unraid override for normal Unraid operations.
