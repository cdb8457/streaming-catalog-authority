# Phase 144 - Runtime Image Override

Phase 144 makes the launcher/runtime compose image configurable without editing the compose file.

`docker-compose.unraid.runtime.yml` now uses:

```yaml
image: ${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}
```

Default behavior is unchanged for the current Unraid deployment: if `CATALOG_AUTHORITY_OPS_IMAGE`
is not set, the runtime stack uses the locally built `repo-ops:latest` image.

Future public image deployments can set:

```bash
export CATALOG_AUTHORITY_OPS_IMAGE=ghcr.io/OWNER/catalog-authority-ops:TAG
docker compose -f docker-compose.unraid.runtime.yml up -d postgres
```

Arcane or another launcher can set the same environment variable in its stack environment when a
published image is available.

This phase does not publish an image, contact a registry, add provider mode, expose ports, add a UI,
or change the one-shot `ops` behavior.
