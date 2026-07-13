# Phase 211: Jellyfin Live Evidence Capture Command

Report id: `phase-211-jellyfin-live-evidence-capture-command`

Decision date: `2026-07-13`

Phase type: guarded capture command and operator automation. This phase adds one command that runs
the Phase 209 read-only Jellyfin smoke and saves the retained JSON evidence to disk. It does not
install Jellyfin, does not add a Jellyfin container, does not bind ports, does not change Compose,
does not change sidecar custody, does not enable writes, and does not bypass the missing secret-file
blocker recorded in Phase 210.

## Source Boundary

Inputs:

- Phase 209 live read-only runner: `981ba0f` / `phase-209`
- Phase 210 capture preflight: `f376a5c` / `phase-210`
- Existing Jellyfin target shape: `http://<unraid-host>:8096`
- Current known blocker: `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`

The host address, API key, raw provider ref value, raw Jellyfin item IDs, titles, and raw response
payloads are intentionally not committed.

## Status

Status: `JELLYFIN_LIVE_EVIDENCE_CAPTURE_COMMAND_READY_SECRET_BLOCKED`

The command is ready, but the live run remains blocked until this secret file exists:

```bash
/mnt/user/appdata/catalog/secrets/jellyfin_api_key
```

The command fails before writing evidence if `JELLYFIN_API_KEY_FILE` is missing, direct
`JELLYFIN_API_KEY` is used, network opt-in is absent, or `JELLYFIN_ALLOW_LIVE_PUBLISH=true`.

## Command Shape

Run from the canonical Unraid repo path after creating the Jellyfin API key credential:

```bash
cd /mnt/user/appdata/catalog/repo
JELLYFIN_ENABLE_NETWORK=true \
JELLYFIN_BASE_URL=http://<unraid-host>:8096 \
JELLYFIN_API_KEY_FILE=/mnt/user/appdata/catalog/secrets/jellyfin_api_key \
npm run ops:jellyfin-live-evidence-capture -- \
  --ref-type <type> \
  --ref-value <value> \
  --out /mnt/user/appdata/catalog/evidence/phase-211-jellyfin-live-readonly-smoke.json
```

The command writes the Phase 209 smoke JSON to the `--out` file and prints only a redaction-safe
capture summary:

- `report`: `phase-211-jellyfin-live-evidence-capture`;
- `smokeReport`: `phase-209-jellyfin-live-readonly-smoke`;
- `smokeStatus`;
- `evidenceDigest`;
- `bytesWritten`;
- output file path.

The output file is created with mode `600` where supported by the filesystem.

## Arcane Button

Add this button only after the secret file exists:

```bash
docker compose -f /mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml run --rm \
  -e JELLYFIN_ENABLE_NETWORK=true \
  -e JELLYFIN_BASE_URL=http://<unraid-host>:8096 \
  -e JELLYFIN_API_KEY_FILE=/mnt/user/appdata/catalog/secrets/jellyfin_api_key \
  app npm run ops:jellyfin-live-evidence-capture -- \
    --ref-type <type> \
    --ref-value <value> \
    --out /mnt/user/appdata/catalog/evidence/phase-211-jellyfin-live-readonly-smoke.json
```

The button definition must not contain the API key value or a raw private host address in committed
docs. The operator substitutes the host at runtime.

## Verification Matrix

| Checkpoint | Expected result | Proof |
| --- | --- | --- |
| Secret-file gate | Satisfied | `test:jellyfin-live-evidence-capture` proves missing/direct secret inputs fail before writing. |
| Read-only boundary | Satisfied | The command calls the Phase 209 runner, which allows only `GET /System/Info` and `GET /Items`. |
| Evidence persistence | Satisfied | `test:jellyfin-live-evidence-capture` writes a redaction-safe JSON report and summary. |
| Current live blocker | Preserved | Phase 210 still records `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`. |
| No launch decision | Satisfied | Phase 207 remains deferred until retained live evidence is captured and reviewed. |

## Forbidden Actions

This phase forbids:

- installing Jellyfin;
- pulling a Jellyfin image;
- adding Jellyfin to a Catalog Authority Compose file;
- binding port `8096`, `8920`, `8099`, or `32400`;
- setting `JELLYFIN_ALLOW_LIVE_PUBLISH=true`;
- using direct `JELLYFIN_API_KEY` for retained evidence;
- writing collections, deleting collections, metadata refresh, playback control, downloads,
  provider/debrid contact, scraping, or catalog mutation;
- changing Catalog Authority runtime mode or sidecar custody.

## Decision

Decision status: `LIVE_EVIDENCE_CAPTURE_COMMAND_READY_AWAITING_SECRET`

Phase 211 removes command-shape friction for the live read-only Jellyfin evidence capture. It does
not claim live evidence has been captured. Phase 211 does not claim live evidence has been captured.
Integration remains deferred until the saved evidence file exists and passes review.

## Status Boundaries

- Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`.
- Phase 210 remains `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Default Compose files must not enable Jellyfin networking or write mode.
