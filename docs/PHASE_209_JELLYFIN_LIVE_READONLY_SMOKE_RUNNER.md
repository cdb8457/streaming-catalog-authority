# Phase 209: Jellyfin Live Read-Only Smoke Runner

Report id: `phase-209-jellyfin-live-readonly-smoke-runner`

Decision date: `2026-07-13`

Phase type: live read-only evidence command and safety guard. This phase adds a reusable operator
command for the existing Jellyfin server discovered in Phase 208. It does not install Jellyfin, does
not add a Jellyfin container, does not bind Jellyfin ports, does not change Compose, does not enable
Catalog Authority runtime integration, does not change sidecar custody, and does not enable writes.

## Source Boundary

Inputs:

- Phase 208 existing-server preflight: `447c4ec` / `phase-208`
- Phase 204 read-only endpoint boundary: `GET /System/Info` and `GET /Items`
- Existing Jellyfin target shape: `http://<unraid-host>:8096`

The host address, API key, raw provider ref value, raw Jellyfin item IDs, titles, and raw response
payloads are intentionally not committed.

## Status

Status: `JELLYFIN_LIVE_READONLY_SMOKE_RUNNER_READY`

The runner command is:

```bash
JELLYFIN_ENABLE_NETWORK=true \
JELLYFIN_BASE_URL=http://<unraid-host>:8096 \
JELLYFIN_API_KEY_FILE=<operator-secret-file> \
npm run ops:jellyfin-live-readonly-smoke -- --ref-type <type> --ref-value <value>
```

The command refuses direct `JELLYFIN_API_KEY`, requires `JELLYFIN_API_KEY_FILE`, and refuses `JELLYFIN_ALLOW_LIVE_PUBLISH=true`.
This keeps the live evidence path read-only and secret-file only.

## Evidence Shape

The command emits JSON with:

- report id `phase-209-jellyfin-live-readonly-smoke`;
- status `JELLYFIN_LIVE_READONLY_SMOKE_PASS` or `JELLYFIN_LIVE_READONLY_SMOKE_FAIL`;
- target scheme and port only, with `hostEchoed: false`;
- credential source `JELLYFIN_API_KEY_FILE` and `apiKeyEchoed: false`;
- allowed method set `GET`;
- allowed endpoint shapes `GET /System/Info` and `GET /Items`;
- step pass/fail details from the redaction-safe read-only smoke;
- summary counts and `evidenceDigest`.

The JSON must not include API keys, internal hostnames, private IP addresses, raw provider ref values,
raw Jellyfin item IDs, item titles, database URLs, KEK material, DEK material, or custody secrets.

## Arcane Button

Add this as an operator-run button only after the API key file exists:

```bash
docker compose -f /mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml run --rm \
  -e JELLYFIN_ENABLE_NETWORK=true \
  -e JELLYFIN_BASE_URL=http://<unraid-host>:8096 \
  -e JELLYFIN_API_KEY_FILE=/run/secrets/jellyfin_api_key \
  app npm run ops:jellyfin-live-readonly-smoke -- --ref-type <type> --ref-value <value>
```

The button definition must not contain the API key value. The secret file mount must be added only
through an operator-reviewed secret path; this phase does not change Compose.

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

## Verification Matrix

| Checkpoint | Expected result | Proof |
| --- | --- | --- |
| Existing-server dependency | Satisfied | `447c4ec` / `phase-208` recorded `8096` as the discovered target shape. |
| Secret-file-only credential | Satisfied | `test:jellyfin-live-readonly-smoke-runner` rejects direct `JELLYFIN_API_KEY`. |
| Read-only endpoint set | Satisfied | `test:jellyfin-live-readonly-smoke-runner` observes only `GET /System/Info` and `GET /Items`. |
| Redaction-safe evidence | Satisfied | The runner emits hostless/keyless/ref-valueless JSON with an `evidenceDigest`. |
| No launch decision | Satisfied | Phase 207 remains deferred until retained live evidence is captured and reviewed. |

## Decision

Decision status: `LIVE_READONLY_SMOKE_RUNNER_READY_NO_EVIDENCE_CAPTURED`

The command is ready for live read-only evidence capture against the existing Jellyfin service, but
this phase does not claim that live evidence has been captured. Integration remains deferred until a
retained Phase 209 JSON report is reviewed in the next evidence-review phase.

## Status Boundaries

- Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Default Compose files must not enable Jellyfin networking or write mode.
