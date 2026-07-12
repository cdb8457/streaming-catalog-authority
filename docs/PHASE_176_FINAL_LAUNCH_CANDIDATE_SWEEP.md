# Phase 176 - Final Launch Candidate Sweep

Report id: `phase-176-final-launch-candidate-sweep`

Phase 176 defines the final evidence sweep for a Catalog Authority Launch v1 candidate. The launch
candidate is the self-hosted catalog/operator backend only. It does not include provider adapters,
Real-Debrid/TorBox live mode, Plex/Jellyfin mutation, scraping, downloading, playback, or media
library orchestration.

## Required Sweep

Run and retain redaction-safe evidence for:

```bash
npm run test:deploy
npm run typecheck
git diff --check
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh status
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review <saved-ui-evidence.json>
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-evidence-capture
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-packet-review <saved-o4-o5-packet.json>
```

Optional operator checks:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh doctor
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-logs
```

## Pass Criteria

- local deploy guard passes with zero failures;
- TypeScript typecheck passes;
- Git diff whitespace check passes;
- Unraid `postgres` and `app` containers are running and healthy;
- live UI check reports `ok=true`;
- saved UI evidence review reports `ok=true`;
- saved O4/O5 packet review reports `ok=true`;
- GitHub `master` and local `master` are aligned;
- launch tags are present for the final candidate phases.

## Open Gates

O4 remains open. O5 remains open. Launch v1 must be described as a validated backend/operator
launch with open managed-custody warnings, not as a managed-custody production closure.

This phase does not close O4 and does not close O5.
