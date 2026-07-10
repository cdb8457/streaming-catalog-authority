# Phase 145 - Image Publishing Readiness

Phase 145 prepares the repository for a future published ops image without publishing anything.

Planned public image name:

```text
ghcr.io/OWNER/catalog-authority-ops:TAG
```

Current local image remains:

```text
repo-ops:latest
```

Local build verification:

```bash
npm run image:build:local
npm run image:inspect:local
```

Future publish checklist:

1. Run `npm run ci`.
2. Build a local image with `npm run image:build:local`.
3. Run the Unraid runtime compose using the local default image.
4. Choose an immutable public tag, not only `latest`.
5. Tag the image as `ghcr.io/OWNER/catalog-authority-ops:TAG`.
6. Push only after explicit release approval.
7. Set `CATALOG_AUTHORITY_OPS_IMAGE=ghcr.io/OWNER/catalog-authority-ops:TAG` in launcher/runtime environments.
8. Run `deploy/unraid-ops-launcher.sh doctor` and retain redacted evidence.

`.dockerignore` excludes local agent evidence, git metadata, embedded Postgres data directories,
`node_modules`, temporary bundles, and redacted evidence files from the Docker build context.

This phase does not publish an image, contact a registry, add provider mode, expose ports, add a UI,
or change the one-shot `ops` behavior.
