# Phase 204: Jellyfin Read-Only Smoke

Report id: `phase-204-jellyfin-read-only-smoke`

Decision date: `2026-07-13`

Phase type: read-only boundary implementation, artifact, and test work. This phase adds the first
Jellyfin smoke rung from Phase 203. It does not enable live Jellyfin by default, does not add a
Jellyfin service to Compose, does not write to Jellyfin, does not change custody runtime, and does
not enable Plex, Emby, providers, downloads, scraping, playback, or media-server mutation.

## Source Boundary

This phase consumes `docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md`
(`phase-203-media-player-boundary-selection`, commit `d5c5b13`, tag `phase-203`). Phase 203 selected
Jellyfin as the first media-player target and defined Rung 1 as read-only smoke only.

## Scope

Status: `JELLYFIN_READ_ONLY_SMOKE_READY`

The read-only smoke proves only:

- the operator intentionally enabled the opt-in Jellyfin network gate;
- the configured base URL and API key can read Jellyfin server information;
- the library lookup endpoint can be queried and matched locally by provider refs;
- output remains redaction-safe.

The smoke does not prove write-capable publishing, disposable collection cleanup, Plex readiness,
Emby readiness, provider availability, download readiness, playback readiness, or scraping behavior.

## Allowed Endpoint Set

Rung 1 allows exactly these Jellyfin endpoint shapes:

- `GET /System/Info`
- `GET /Items?Recursive=true&Fields=ProviderIds&IncludeItemTypes=Movie,Series&StartIndex=<n>&Limit=<n>`

Forbidden operations in Phase 204:

- `POST`, `PUT`, `PATCH`, or `DELETE`;
- collection create, collection delete, metadata refresh, playback session control, download,
  provider/debrid calls, scraping, or catalog mutation.

## Implementation Record

Implemented code paths:

- `src/core/adapters/jellyfin/mapping.ts` exposes `buildSystemInfoRequest()` for `GET /System/Info`.
- `src/core/adapters/jellyfin/http-client.ts` exposes `getServerInfo()` over the existing injected
  transport and sends the API key only as the `X-Emby-Token` header.
- `src/core/adapters/jellyfin/smoke.ts` runs `server-info` before library lookup. If server-info
  fails, the smoke stops before `GET /Items` and reports a redaction-safe failure.
- `src/ops/jellyfin-smoke-cli.ts` keeps the opt-in `JELLYFIN_ENABLE_NETWORK=true` gate and reports
  the read-only endpoint intent.

Credential handling:

- `JELLYFIN_ENABLE_NETWORK` defaults off and must be set intentionally.
- `JELLYFIN_API_KEY_FILE` is the preferred credential path for operator use.
- `JELLYFIN_API_KEY` remains supported by the existing parser for local/manual testing, but secrets
  must not be committed to docs, tests, evidence, or Compose.
- `JELLYFIN_BASE_URL` is operator-supplied configuration and is not committed with a live hostname.

## Operator Command Shape

Read-only smoke:

```bash
JELLYFIN_ENABLE_NETWORK=true \
JELLYFIN_API_KEY_FILE=<operator-secret-file> \
JELLYFIN_BASE_URL=<operator-designated-test-instance> \
npm run smoke:jellyfin -- <refType> <refValue>
```

The command must produce redaction-safe evidence only: step status, counts, report IDs, and digests.
It must not include API keys, item titles, raw provider refs, Jellyfin item IDs, hostnames, database
URLs, KEK material, DEK material, or custody secrets.

## Verification Matrix

| Checkpoint | Expected result | Proof |
| --- | --- | --- |
| Phase 203 dependency | Satisfied | `d5c5b13` / `phase-203` selected Jellyfin and defined Rung 1. |
| Server info | Satisfied in fixture transport | `test:jellyfin-http`, `test:jellyfin-smoke`, and `test:jellyfin-readonly-smoke` cover `GET /System/Info`. |
| Library lookup | Satisfied in fixture transport | `test:jellyfin-http` covers paged `GET /Items` and local provider-id matching. |
| No writes in Rung 1 | Satisfied | `test:jellyfin-readonly-smoke` asserts only `GET` methods and no write-capable endpoint in read-only smoke. |
| Network default off | Satisfied | Existing real-factory tests and Phase 204 guard assert fail-closed default. |
| Evidence redaction | Satisfied | Phase 204 guard checks docs and smoke failure output for secret leakage. |

No live Jellyfin server evidence is committed in this phase because no operator-designated Jellyfin
instance and secret file were provided. Live read-only smoke can be run later with the command shape
above and retained as redaction-safe operator evidence for Phase 205.

## Status Boundaries

- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Phase 204 does not alter sidecar custody or Unraid runtime.
- Phase 205 is unblocked only for read-only mapping evidence after a designated Jellyfin test target
  exists.
