# Phase 154 - Git/Release Packaging

Report id: `phase-154-release-packaging`

Phase 154 defines the external deployment contract for users pulling the Git repository.

Canonical Unraid path:

```text
/mnt/user/appdata/catalog/repo
```

Canonical compose file:

```text
docker-compose.unraid.runtime.yml
```

Canonical appdata root:

```text
/mnt/user/appdata/catalog
```

Image guidance:

- build locally with `npm run image:build:local` to produce `repo-ops:latest`;
- when a registry image is published, use `ghcr.io/catalog-authority/catalog-authority-ops:<tag>`;
- set `CATALOG_AUTHORITY_OPS_IMAGE` only when pulling the published image.

Release files:

- `RELEASE.md` is the short external-user deployment guide;
- `README.md` points public Unraid users at `docker-compose.unraid.runtime.yml`;
- the documented release path uses one compose file.

Release tag:

```text
phase-154
```

Still forbidden:

- provider contact;
- scraping;
- downloading;
- playback;
- media-server mutation;
- token printing;
- UI write actions.
