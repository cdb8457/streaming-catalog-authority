# Phase 179 - Launch v1 Release Package

Report id: `phase-179-launch-v1-release-package`

Phase 179 updates the public release package for Launch v1. The release is the self-hosted
Catalog Authority backend/operator foundation on Unraid with visible O4/O5 open warnings.

## Release Identity

- release tag: `launch-v1`;
- phase tags included through `phase-178`;
- canonical compose: `docker-compose.unraid.runtime.yml`;
- canonical repo path: `/mnt/user/appdata/catalog/repo`;
- canonical appdata path: `/mnt/user/appdata/catalog`;
- local image: `repo-ops:latest`;
- operator UI port: `8099`.

## Launch v1 Scope

Included:

- Postgres runtime service;
- one-shot ops service;
- read-only operator UI service;
- Arcane/User Scripts launcher commands;
- UI evidence save/review;
- O4/O5 packet capture/review;
- redaction-safe launch-candidate checks.

Excluded:

- provider contact;
- Real-Debrid/TorBox live provider mode;
- scraping;
- downloading;
- playback;
- Plex/Jellyfin mutation;
- media-server library writes;
- O4 closure;
- O5 closure;
- claims that managed custody is closed.

## Quick Start

```bash
mkdir -p /mnt/user/appdata/catalog/repo
cd /mnt/user/appdata/catalog/repo
git clone https://github.com/cdb8457/streaming-catalog-authority.git . 2>/dev/null || git pull --ff-only origin master
npm run image:build:local
docker compose -f docker-compose.unraid.runtime.yml up -d postgres app
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check
```

## Final Validation

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review <saved-ui-evidence.json>
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-evidence-capture
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-packet-review <saved-o4-o5-packet.json>
```

O4 remains open. O5 remains open. Launch v1 does not close O4 and does not close O5.
