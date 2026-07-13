# Phase 213: Jellyfin Container Command Shape Fix

Report id: `phase-213-jellyfin-container-command-shape-fix`

Decision date: `2026-07-13`

Phase type: operator command correction. This phase corrects the Phase 210 through Phase 212 host
command shape: Unraid should run Jellyfin evidence commands inside the `repo-ops:latest` image, not
directly on the Unraid host. It does not install Jellyfin, does not add a Jellyfin container, does
not bind ports, does not change Compose, does not change sidecar custody, does not create the
Jellyfin API key, and does not run live evidence.

## Source Boundary

Inputs:

- Phase 211 capture command: `f51d8fa` / `phase-211`
- Phase 212 secret readiness gate: `90cb85a` / `phase-212`
- Current observed Unraid result: direct host `npm run ops:jellyfin-secret-readiness` exits `127`
  because `tsx` is not available on the host.

The secret value and private host address are intentionally not committed or echoed.

## Status

Status: `JELLYFIN_CONTAINER_COMMAND_SHAPE_READY`

The correct Unraid execution pattern is:

1. Use host shell only for file-existence checks and Docker invocation.
2. Run Node/tsx commands inside `repo-ops:latest`.
3. Mount the Jellyfin secret file only after it exists.
4. Mount the evidence directory only for the capture command.

## Secret Readiness Command

Before the secret exists, this safe not-ready check can run without mounting a missing host path:

```bash
docker run --rm \
  -e JELLYFIN_API_KEY_FILE=/run/secrets/jellyfin_api_key \
  repo-ops:latest \
  npm run ops:jellyfin-secret-readiness
```

Expected result while the secret is absent: nonzero exit and `JELLYFIN_SECRET_NOT_READY`.

After the secret file exists, run the real readiness check with a read-only bind mount:

```bash
docker run --rm \
  -v /mnt/user/appdata/catalog/secrets/jellyfin_api_key:/run/secrets/jellyfin_api_key:ro \
  -e JELLYFIN_API_KEY_FILE=/run/secrets/jellyfin_api_key \
  repo-ops:latest \
  npm run ops:jellyfin-secret-readiness
```

Expected result after setup: zero exit and `JELLYFIN_SECRET_READY`.

## Live Evidence Capture Command

After secret readiness passes:

```bash
docker run --rm \
  -v /mnt/user/appdata/catalog/secrets/jellyfin_api_key:/run/secrets/jellyfin_api_key:ro \
  -v /mnt/user/appdata/catalog/evidence:/evidence \
  -e JELLYFIN_ENABLE_NETWORK=true \
  -e JELLYFIN_BASE_URL=http://<unraid-host>:8096 \
  -e JELLYFIN_API_KEY_FILE=/run/secrets/jellyfin_api_key \
  repo-ops:latest \
  npm run ops:jellyfin-live-evidence-capture -- \
    --ref-type <type> \
    --ref-value <value> \
    --out /evidence/phase-211-jellyfin-live-readonly-smoke.json
```

This uses the existing Jellyfin listener on `8096`, writes only the retained JSON evidence, and does not expose or publish any new port.

## Forbidden Actions

This phase forbids:

- running repo `npm` commands directly on Unraid host as the documented path;
- mounting a missing secret path, because Docker may create a directory at that path;
- printing, committing, or logging the Jellyfin API key;
- using direct `JELLYFIN_API_KEY` for retained evidence;
- installing Jellyfin or adding Jellyfin to Compose;
- binding port `8096`, `8920`, `8099`, or `32400`;
- setting `JELLYFIN_ALLOW_LIVE_PUBLISH=true`;
- playback, downloads, provider/debrid contact, scraping, catalog mutation, or custody changes.

## Decision

Decision status: `CONTAINER_COMMAND_SHAPE_FIXED_SECRET_STILL_MISSING`

Phase 213 fixes the operator command shape. Live evidence remains blocked until the operator creates
`/mnt/user/appdata/catalog/secrets/jellyfin_api_key`.

## Status Boundaries

- Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`.
- Phase 210 remains `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`.
- Phase 211 remains `LIVE_EVIDENCE_CAPTURE_COMMAND_READY_AWAITING_SECRET`.
- Phase 212 remains `JELLYFIN_SECRET_READINESS_GATE_READY`.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
