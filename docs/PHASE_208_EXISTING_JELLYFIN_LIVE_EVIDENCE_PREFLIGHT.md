# Phase 208: Existing Jellyfin Live Evidence Preflight

Report id: `phase-208-existing-jellyfin-live-evidence-preflight`

Decision date: `2026-07-13`

Phase type: live evidence preflight plan and safety record. This phase records that Jellyfin already
exists on the Unraid host and defines the safe live-evidence capture path. It does not install
Jellyfin, does not create a Jellyfin container, does not bind any Jellyfin ports, does not change
Compose, does not enable Catalog Authority runtime integration, and does not change sidecar custody.

## Source Boundary

Inputs:

- Phase 207 decision: `ddc8d0a` / `phase-207`
- Current Unraid preflight observation: existing Jellyfin listener found on port `8096`
- Current Unraid preflight observation: Jellyfin HTTPS port `8920` not open
- Current Unraid preflight observation: Catalog Authority operator UI remains on port `8099`
- Current Unraid preflight observation: Plex remains on port `32400`

The host address is intentionally not committed. Operators should substitute their own Unraid host
or DNS name at execution time.

## Status

Status: `EXISTING_JELLYFIN_DISCOVERED_LIVE_EVIDENCE_PREFLIGHT_READY`

Phase 208 changes the next step from "find or install Jellyfin" to "use the existing Jellyfin
instance carefully." The correct target shape for live evidence is:

- base URL: `http://<unraid-host>:8096`
- HTTPS port `8920`: do not assume available unless a fresh scan proves it
- no new Jellyfin service definition
- no new Jellyfin port mapping
- no Docker install or image pull for Jellyfin

## Port Safety Rule

Before any live evidence run, repeat the port preflight:

```bash
ss -ltnp
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

Required interpretation:

- if `8096` is already owned by Jellyfin, use that existing service;
- if `8096` is owned by something else, stop and investigate;
- if `8920` is closed, do not switch the evidence command to HTTPS;
- if Catalog Authority is using `8099`, do not reuse that port;
- if Plex is using `32400`, do not reuse that port;
- never start a second Jellyfin instance to run the smoke.

## Secret Handling

The API key must be supplied by secret file:

```bash
JELLYFIN_API_KEY_FILE=<operator-secret-file>
```

The key value must not appear in shell history, committed files, retained evidence, logs, screenshots,
or Arcane button definitions. `JELLYFIN_BASE_URL` may point at the existing Unraid Jellyfin service,
but committed docs and tests must not contain the operator's private host address.

## Evidence Capture Order

Run only after the port preflight confirms the existing listener:

1. Phase 204 read-only smoke against `http://<unraid-host>:8096`.
2. Phase 205 read-only mapping against the same Jellyfin target.
3. Optional Phase 206 disposable write proof only if the operator intentionally accepts the write test
   and sets both `JELLYFIN_ENABLE_NETWORK=true` and `JELLYFIN_ALLOW_LIVE_PUBLISH=true`.
4. Phase 207 evidence review can then be repeated against the retained live evidence.

Retained evidence must be summarized by report ID, status, timestamp, counts, and digest only. Do not
commit raw evidence payloads.

## Forbidden Actions

This phase forbids:

- installing Jellyfin;
- pulling a Jellyfin image;
- adding Jellyfin to any Catalog Authority Compose file;
- binding port `8096`, `8920`, `8099`, or `32400` for a new test service;
- changing Catalog Authority runtime mode;
- changing sidecar custody;
- enabling provider/debrid mode;
- scraping, downloading, playback, or media-server orchestration.

## Decision

Decision status: `LIVE_EVIDENCE_PREFLIGHT_READY_NO_INSTALL`

Jellyfin live evidence is ready to be collected only through the existing Jellyfin service after a
fresh port preflight and secret-file setup. Integration remains deferred until retained live evidence
is captured and reviewed.

Integration remains deferred until retained live evidence is captured and reviewed.

## Status Boundaries

- Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Default Compose files must not enable Jellyfin networking or write mode.
