# Phase 210: Jellyfin Live Evidence Capture Preflight

Report id: `phase-210-jellyfin-live-evidence-capture-preflight`

Decision date: `2026-07-13`

Phase type: live evidence capture preflight and operator setup gate. This phase checks whether the
existing Jellyfin server can be used for the Phase 209 live read-only smoke. It does not install
Jellyfin, does not add a Jellyfin container, does not bind ports, does not change Compose, does not
change sidecar custody, does not enable writes, and does not run a live Jellyfin smoke without a
secret file.

## Source Boundary

Inputs:

- Phase 209 live read-only runner: `981ba0f` / `phase-209`
- Existing Jellyfin target shape from Phase 208: `http://<unraid-host>:8096`
- Current Unraid preflight observation: Jellyfin listener present on port `8096`
- Current Unraid preflight observation: Catalog Authority operator UI remains on port `8099`
- Current Unraid preflight observation: Plex remains on port `32400`
- Current Unraid preflight observation: Jellyfin API key secret file missing

The host address, API key, raw provider ref value, raw Jellyfin item IDs, titles, and raw response
payloads are intentionally not committed.

## Status

Status: `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`

The existing Jellyfin service is reachable at the expected port boundary, but the required secret file
is not present:

```bash
/mnt/user/appdata/catalog/secrets/jellyfin_api_key
```

Because the Phase 209 command requires `JELLYFIN_API_KEY_FILE` and refuses direct `JELLYFIN_API_KEY`,
no live smoke was run in this phase.

## Operator Secret Setup

Create a Jellyfin API key in Jellyfin with read-only/operator-smoke intent, then place only the key
value into the Unraid secret file. Do not paste the key into Arcane button definitions, shell history,
docs, retained evidence, screenshots, or logs.

Safe setup shape:

```bash
mkdir -p /mnt/user/appdata/catalog/secrets
umask 077
printf '%s\n' '<paste-jellyfin-api-key-here>' > /mnt/user/appdata/catalog/secrets/jellyfin_api_key
chmod 600 /mnt/user/appdata/catalog/secrets/jellyfin_api_key
```

Validation shape, without printing the key:

```bash
test -s /mnt/user/appdata/catalog/secrets/jellyfin_api_key
stat -c '%a %U:%G' /mnt/user/appdata/catalog/secrets/jellyfin_api_key
```

Expected mode is `600` or stricter.

## Capture Command

After the secret file exists, run the Phase 209 read-only smoke from the canonical Unraid repo path:

```bash
cd /mnt/user/appdata/catalog/repo
JELLYFIN_ENABLE_NETWORK=true \
JELLYFIN_BASE_URL=http://<unraid-host>:8096 \
JELLYFIN_API_KEY_FILE=/mnt/user/appdata/catalog/secrets/jellyfin_api_key \
npm run ops:jellyfin-live-readonly-smoke -- --ref-type <type> --ref-value <value> \
  > /mnt/user/appdata/catalog/evidence/phase-210-jellyfin-live-readonly-smoke.json
```

The `<type>` and `<value>` pair should point at a known library item, such as a TMDB or IMDB provider
reference already present in the Jellyfin library. The retained JSON must be reviewed before any
integration status changes.

## Evidence Review Requirements

The retained JSON must satisfy all of these before Phase 207 can be revisited:

- `report` equals `phase-209-jellyfin-live-readonly-smoke`;
- `ok` is `true`;
- `status` is `JELLYFIN_LIVE_READONLY_SMOKE_PASS`;
- target contains scheme and port only, with `hostEchoed: false`;
- credential boundary shows `JELLYFIN_API_KEY_FILE` and `apiKeyEchoed: false`;
- operation boundary shows `writeMode: false` and allowed method `GET`;
- steps include `server-info` and `find`;
- `evidenceDigest` is present;
- no API key, private host address, raw provider ref value, raw Jellyfin item ID, item title, database
  URL, KEK material, DEK material, or custody secret appears.

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

Decision status: `LIVE_EVIDENCE_CAPTURE_READY_AFTER_SECRET_SETUP`

The system is ready for a live read-only Jellyfin smoke after the operator creates the secret file.
No live evidence was captured in this phase because the secret was missing. Integration remains
deferred until a retained live evidence file passes review.

## Status Boundaries

- Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`.
- Phase 209 remains `LIVE_READONLY_SMOKE_RUNNER_READY_NO_EVIDENCE_CAPTURED`.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Default Compose files must not enable Jellyfin networking or write mode.

