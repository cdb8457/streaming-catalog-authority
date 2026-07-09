# Phase 143 - Unraid Ops Launchers

Phase 143 adds `deploy/unraid-ops-launcher.sh`, a short command wrapper for Arcane custom commands
and Unraid User Scripts.

The launcher uses `docker-compose.unraid.runtime.yml`, not hand-built `docker run` commands, so it
matches the Arcane/runtime deployment path from Phase 142.

Supported commands:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh start-postgres
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh migrate
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh doctor
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh backup
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh rewrap-plan
```

Command meanings:

- `start-postgres`: starts the long-running Postgres service.
- `status`: shows the runtime compose stack.
- `migrate`: runs schema migration and exits.
- `doctor`: runs the read-only JSON health check and exits non-zero on FAIL checks.
- `backup`: writes a catalog backup under `/mnt/user/appdata/catalog/backups` unless a target file
  is provided.
- `rewrap-plan`: runs the redaction-safe KEK rewrap planning command without changing keys. It
  requires the temporary previous KEK file
  `/mnt/user/appdata/catalog/secrets/custodian_kek_previous`; create that file only for the planned
  KEK rotation window and remove it after review.

Expected steady state remains unchanged:

- `catalogauthority-postgres-1` stays running and healthy.
- `catalogauthority-ops-1` exits after each command; this is success for one-shot ops commands.

This phase does not add provider mode, publish ports, install a UI, or start a long-running API
service.
