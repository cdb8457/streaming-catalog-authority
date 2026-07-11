# Phase 163 - Release Snapshot

Report id: `phase-163-release-snapshot`

Current release snapshot:

- GitHub branch: `master`
- GitHub commit: `a1649c24`
- Unraid repo: `/mnt/user/appdata/catalog/repo`
- Unraid commit: `a1649c24c`
- runtime compose: `/mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml`
- Arcane project path: `/mnt/user/projects/CatalogAuthority`
- operator UI URL: `http://192.168.1.31:8099/`
- current local image: `repo-ops:latest`
- latest verified evidence file:
  `/mnt/user/appdata/catalog/backups/evidence/operator-ui-live-check-20260711T201523Z.json`

Validated release state:

- local `master` and `origin/master` were even at the final test pass;
- `phase-152`, `phase-153`, `phase-154`, `phase-155`, `phase-161`, and `phase-162` tags are pushed;
- `catalogauthority-postgres-1` is running and healthy;
- `catalogauthority-app-1` is running and healthy;
- live operator evidence review returned `ok=true`.

Open gates:

- O4 remains open: FileCustodian is a hardened reference harness, not managed/external production
  custodian evidence.
- O5 remains open: KEK rewrap tooling exists, but managed KEK custody/scheduling automation is not
  built.
- Provider, scraping, download, playback, and media-server integration remain outside this release.
