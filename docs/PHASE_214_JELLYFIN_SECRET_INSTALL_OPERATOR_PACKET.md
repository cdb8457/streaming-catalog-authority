# Phase 214: Jellyfin Secret Install Operator Packet

Report id: `phase-214-jellyfin-secret-install-operator-packet`

Decision date: `2026-07-13`

Phase type: operator secret-install packet. This phase documents the exact redaction-safe Unraid
procedure for creating the Jellyfin API key file that unblocks Phase 211 live read-only evidence
capture. It does not create the secret, does not print or commit the secret, does not contact Jellyfin,
does not install Jellyfin, does not add a Jellyfin container, does not bind ports, does not change
Compose, and does not change custody mode.

## Inputs

- Phase 211 capture command: `f51d8fa` / `phase-211`
- Phase 212 secret readiness gate: `90cb85a` / `phase-212`
- Phase 213 container command shape fix: `bb5f281` / `phase-213`
- Current Unraid blocker: `/mnt/user/appdata/catalog/secrets/jellyfin_api_key` is absent.

No Jellyfin API key value is recorded in this document.

## Status

Status: `JELLYFIN_SECRET_INSTALL_PACKET_READY`

Decision status: `SECRET_INSTALL_PACKET_READY_LIVE_CAPTURE_STILL_BLOCKED`

This packet is the final operator input before live read-only capture. The expected sequence is:

1. Generate or copy a Jellyfin API key from the existing Jellyfin server administration UI.
2. Install it into the canonical Unraid secret path using the no-echo command below.
3. Run the Phase 213 containerized readiness command.
4. Proceed to Phase 211 live evidence capture only after readiness returns `JELLYFIN_SECRET_READY`.

## Secret Install Command

Run this on the Unraid host shell. It reads the API key without echoing it, writes it to the
canonical secret file with owner-only permissions, and clears the shell variable after the write.

```bash
install -d -m 700 /mnt/user/appdata/catalog/secrets
umask 077
read -rsp 'Jellyfin API key: ' JELLYFIN_KEY
printf '\n'
tmp_secret="$(mktemp /mnt/user/appdata/catalog/secrets/jellyfin_api_key.XXXXXX)"
printf '%s' "$JELLYFIN_KEY" > "$tmp_secret"
unset JELLYFIN_KEY
chown root:root "$tmp_secret"
chmod 600 "$tmp_secret"
mv "$tmp_secret" /mnt/user/appdata/catalog/secrets/jellyfin_api_key
```

Do not use `echo <api-key> > ...`, because that can expose the key through shell history or terminal
scrollback. Do not mount the file into Docker until it exists as a regular non-empty file.

## Readiness Command

After the file exists, run the Phase 213 containerized readiness check:

```bash
docker run --rm \
  -v /mnt/user/appdata/catalog/secrets/jellyfin_api_key:/run/secrets/jellyfin_api_key:ro \
  -e JELLYFIN_API_KEY_FILE=/run/secrets/jellyfin_api_key \
  repo-ops:latest \
  npm run ops:jellyfin-secret-readiness
```

Expected result: zero exit and `JELLYFIN_SECRET_READY`.

If the command returns `JELLYFIN_SECRET_NOT_READY`, stop before live capture and fix the file state.
The most likely causes are missing file, empty file, unreadable file, directory created by an earlier
bad Docker mount, or permissions broader than owner-only.

## Live Capture Remains Gated

Only after `JELLYFIN_SECRET_READY`, use the Phase 213 live capture command:

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

That later command is read-only and uses the existing Jellyfin listener on `8096`. This Phase 214
packet itself performs no network call and does not expose or publish any new port.

## Forbidden Actions

This phase forbids:

- committing, printing, logging, or pasting the Jellyfin API key into docs;
- direct `JELLYFIN_API_KEY` retained evidence usage;
- direct host `npm run ops:jellyfin-secret-readiness`;
- mounting a missing secret path into Docker;
- does not change Compose or custody mode;
- installing Jellyfin, adding Jellyfin to Compose, or changing Jellyfin ports;
- binding port `8096`, `8920`, `8099`, or `32400`;
- setting `JELLYFIN_ALLOW_LIVE_PUBLISH=true`;
- playback, downloads, provider/debrid contact, scraping, catalog mutation, or custody changes.

## Status Boundaries

- Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`.
- Phase 210 remains `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING` until the operator installs the secret.
- Phase 211 remains `LIVE_EVIDENCE_CAPTURE_COMMAND_READY_AWAITING_SECRET`.
- Phase 212 remains `JELLYFIN_SECRET_READINESS_GATE_READY`.
- Phase 213 remains `JELLYFIN_CONTAINER_COMMAND_SHAPE_READY`.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
