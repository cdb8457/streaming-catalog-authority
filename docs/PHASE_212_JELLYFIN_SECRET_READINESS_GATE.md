# Phase 212: Jellyfin Secret Readiness Gate

Report id: `phase-212-jellyfin-secret-readiness-gate`

Decision date: `2026-07-13`

Phase type: secret-file readiness command and guard. This phase adds a no-network command that
checks whether the Jellyfin API key secret file is ready for the Phase 211 live evidence capture.
It does not create a Jellyfin API key, does not print a secret value, does not contact Jellyfin, does
not install Jellyfin, does not change Compose, does not change sidecar custody, and does not enable
write mode.

## Source Boundary

Inputs:

- Phase 210 capture preflight: `f376a5c` / `phase-210`
- Phase 211 capture command: `f51d8fa` / `phase-211`
- Current known blocker: `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`

The secret value and private host address are intentionally not committed or echoed.

## Status

Status: `JELLYFIN_SECRET_READINESS_GATE_READY`

The readiness command is:

```bash
JELLYFIN_API_KEY_FILE=/mnt/user/appdata/catalog/secrets/jellyfin_api_key \
npm run ops:jellyfin-secret-readiness
```

The command emits JSON with report id `phase-212-jellyfin-secret-readiness`. It checks:

- direct `JELLYFIN_API_KEY` is absent;
- `JELLYFIN_API_KEY_FILE` is present;
- the file is readable and non-empty;
- the path is a regular file;
- file permissions are owner-only (`600` or stricter) where POSIX modes are authoritative.

The report sets `secretValueEchoed: false` and `secretPathEchoed: false`. Findings mention only
environment variable names and readiness states, never the key value.

## Expected Current Result

On Unraid, mode `600` or stricter is required. Until the operator creates `/mnt/user/appdata/catalog/secrets/jellyfin_api_key`, the command should
return nonzero and report:

```text
JELLYFIN_SECRET_NOT_READY
```

That is an expected blocked state, not a runtime failure.

## Unlock Path

After the readiness command reports `JELLYFIN_SECRET_READY`, run the Phase 211 capture command:

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

## Forbidden Actions

This phase forbids:

- printing, committing, or logging the Jellyfin API key;
- using direct `JELLYFIN_API_KEY` for retained evidence;
- contacting Jellyfin;
- installing Jellyfin;
- adding Jellyfin to a Catalog Authority Compose file;
- binding port `8096`, `8920`, `8099`, or `32400`;
- setting `JELLYFIN_ALLOW_LIVE_PUBLISH=true`;
- writing collections, deleting collections, playback control, downloads, provider/debrid contact,
  scraping, or catalog mutation;
- changing Catalog Authority runtime mode or sidecar custody.

## Decision

Decision status: `SECRET_READINESS_COMMAND_READY_LIVE_CAPTURE_STILL_BLOCKED`

Phase 212 makes the blocker check repeatable and safe. It does not claim live evidence has been
captured and does not change the Phase 210 blocked state until the operator creates the secret file.

## Status Boundaries

- Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`.
- Phase 210 remains `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`.
- Phase 211 remains `LIVE_EVIDENCE_CAPTURE_COMMAND_READY_AWAITING_SECRET`.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Default Compose files must not enable Jellyfin networking or write mode.
