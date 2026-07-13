# Phase 215: Jellyfin Live Capture Launcher

Report id: `phase-215-jellyfin-live-capture-launcher`

Decision date: `2026-07-13`

Phase type: guarded operator launcher. This phase adds a single Unraid shell launcher for the
post-secret Jellyfin read-only live evidence sequence. It does not create the Jellyfin API key,
does not contact Jellyfin during tests, does not install Jellyfin, does not add a Jellyfin container, does
not publish ports, does not change Compose, does not change custody mode, and does not enable
playback, downloads, provider/debrid contact, scraping, or catalog mutation.

## Inputs

- Phase 211 capture command: `f51d8fa` / `phase-211`
- Phase 212 secret readiness gate: `90cb85a` / `phase-212`
- Phase 213 container command shape fix: `bb5f281` / `phase-213`
- Phase 214 secret install operator packet: `5a4bb6c` / `phase-214`
- Current Unraid blocker: `/mnt/user/appdata/catalog/secrets/jellyfin_api_key` is absent.

## Status

Status: `JELLYFIN_LIVE_CAPTURE_LAUNCHER_READY`

Decision status: `LAUNCHER_READY_SECRET_STILL_REQUIRED`

The launcher is `deploy/unraid-jellyfin-live-capture.sh`. It is intentionally inert until an operator
invokes it after installing the Jellyfin API key file.

## Launcher Behavior

The launcher:

1. Requires `<ref-type>` and `<ref-value>`.
2. Refuses to run unless `/mnt/user/appdata/catalog/secrets/jellyfin_api_key` exists as a regular
   non-empty file.
3. Runs `ops:jellyfin-secret-readiness` inside `repo-ops:latest` with the secret mounted read-only.
4. Runs `ops:jellyfin-live-evidence-capture` only after readiness passes.
5. Writes redaction-safe JSON evidence to
   `/mnt/user/appdata/catalog/evidence/phase-211-jellyfin-live-readonly-smoke.json` by default.

Example after the secret exists:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-jellyfin-live-capture.sh tmdb 603
```

The default in-container Jellyfin URL is `http://host.docker.internal:8096` with Docker's
`host-gateway` mapping. Operators may override it with `JELLYFIN_BASE_URL` if their Unraid Docker
networking requires a different route.

## Safety Boundaries

The launcher preserves the Phase 203 through Phase 214 boundaries:

- read-only Jellyfin evidence only;
- secret-file only, mounted read-only;
- no direct `JELLYFIN_API_KEY`;
- no secret value output;
- no Jellyfin install;
- no new Jellyfin container;
- does not publish ports;
- no public ports or host network;
- no Compose changes;
- no custody changes;
- no provider/debrid contact, scraping, downloading, playback, or catalog mutation.

## Status Boundaries

- Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`.
- Phase 210 remains `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING` until the operator installs the secret.
- Phase 211 remains `LIVE_EVIDENCE_CAPTURE_COMMAND_READY_AWAITING_SECRET`.
- Phase 212 remains `JELLYFIN_SECRET_READINESS_GATE_READY`.
- Phase 213 remains `JELLYFIN_CONTAINER_COMMAND_SHAPE_READY`.
- Phase 214 remains `JELLYFIN_SECRET_INSTALL_PACKET_READY`.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
