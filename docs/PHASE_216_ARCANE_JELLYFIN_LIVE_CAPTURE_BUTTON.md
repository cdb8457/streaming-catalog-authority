# Phase 216: Arcane Jellyfin Live Capture Button

Report id: `phase-216-arcane-jellyfin-live-capture-button`

Decision date: `2026-07-13`

Phase type: Arcane operator button packet. This phase adds the post-secret Jellyfin read-only live
capture launcher to the Arcane/User Scripts operator surface. It does not create or store the
Jellyfin API key, does not contact Jellyfin during tests, does not install Jellyfin, does not add a
Jellyfin container, does not publish ports, does not change Compose, does not change custody mode,
and does not enable playback, downloads, provider/debrid contact, scraping, writes, or catalog
mutation.

## Inputs

- Phase 153 Arcane operator runbook: `docs/PHASE_153_ARCANE_OPERATOR_RUNBOOK.md`
- Phase 214 secret install operator packet: `5a4bb6c` / `phase-214`
- Phase 215 guarded launcher: `13e58de` / `phase-215`
- Current Unraid blocker: `/mnt/user/appdata/catalog/secrets/jellyfin_api_key` is absent.

## Status

Status: `ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON_READY`

Decision status: `BUTTON_READY_SECRET_STILL_REQUIRED`

## Arcane Button

Add this button only after the Jellyfin API key has been installed with the Phase 214 no-echo
operator packet:

| Button | Exact command | Description |
| --- | --- | --- |
| `jellyfin-live-capture` | `/mnt/user/appdata/catalog/repo/deploy/unraid-jellyfin-live-capture.sh tmdb 603` | Runs the guarded read-only Jellyfin evidence capture after secret readiness passes. |

The button must not contain the Jellyfin API key value, direct `JELLYFIN_API_KEY`, a raw private host
address, a Docker Compose edit, or any write-capable Jellyfin command. The launcher itself performs
the missing/empty secret refusal and readiness gate before any live read-only Jellyfin call.

## Optional Output Override

If an operator wants a separate evidence filename for a specific run, use the third positional
argument:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-jellyfin-live-capture.sh tmdb 603 /mnt/user/appdata/catalog/evidence/jellyfin-live-readonly-smoke.json
```

The output file must remain under `/mnt/user/appdata/catalog/evidence` and must not contain raw API
keys, media titles, item IDs, private hostnames, or screenshots.

## Button Boundaries

Allowed:

- one explicit read-only live evidence capture;
- `tmdb 603` as the default smoke reference until an operator chooses another known-safe reference;
- redaction-safe JSON evidence under the canonical evidence directory;
- failure before network contact when the secret is missing, empty, or unreadable.

Forbidden:

- pasting the Jellyfin API key into Arcane button text;
- direct `JELLYFIN_API_KEY`;
- write-capable Jellyfin flags or `JELLYFIN_ALLOW_LIVE_PUBLISH=true`;
- Jellyfin installation, Compose edits, host networking, or public port publication;
- playback, downloads, provider/debrid contact, scraping, catalog mutation, or custody changes.

## Status Boundaries

- Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`.
- Phase 210 remains `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING` until the operator installs the secret.
- Phase 214 remains `JELLYFIN_SECRET_INSTALL_PACKET_READY`.
- Phase 215 remains `JELLYFIN_LIVE_CAPTURE_LAUNCHER_READY`.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
