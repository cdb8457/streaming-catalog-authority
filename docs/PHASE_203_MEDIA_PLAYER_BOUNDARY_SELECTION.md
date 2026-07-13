# Phase 203: Media Player Integration Boundary Selection

Report id: `phase-203-media-player-boundary-selection`

Decision date: `2026-07-13`

Phase type: artifact and test work only. This phase selects the first media-player integration target
and defines the test ladder. It makes no live Jellyfin connection, no runtime Compose change, no
custody-mode change, no provider integration, no scraping, no download orchestration, no playback
control, and no media-server runtime enablement.

## Decision

Selected first media-player target: `Jellyfin`

Selection status: `JELLYFIN_SELECTED_FOR_BOUNDARY_CONTROLLED_TESTING`

Plex status: `DEFERRED`

Emby status: `DEFERRED_LIKELY_FOLLOWS_JELLYFIN_PATTERNS`

Jellyfin is selected first because this repository already has existing Jellyfin boundary work,
fake/local client coverage, injected-transport HTTP scaffolding, smoke-test concepts, and
redaction-safe validation templates. Plex is deferred because no equivalent Plex boundary and client
scaffold exists yet. Emby is deferred because it is expected to follow the Jellyfin-style local-server
pattern later, but it still needs its own boundary record before use.

## Existing Jellyfin Scaffolding Inventory

| Area | Files/modules | Current state | Reusable for |
| --- | --- | --- | --- |
| Publisher boundary | `docs/PHASE_8_PUBLISHER_BOUNDARY.md`, `src/core/adapters/publisher.ts`, `src/core/adapters/publisher-factory.ts`, `test/publisher-contract.ts`, `test/publisher-privacy.ts` | Tested boundary. Future media publishers must declare minimized identity and stay advisory unless explicitly gated. | Phases 205-206 identity minimization and write-boundary review. |
| Fake/local Jellyfin adapter | `docs/PHASE_10_JELLYFIN_ADAPTER.md`, `src/core/adapters/jellyfin/fake-client.ts`, `src/core/adapters/jellyfin/factory.ts`, `src/core/adapters/jellyfin/publisher.ts`, `src/core/adapters/jellyfin/revoker.ts`, `test/jellyfin-contract.ts`, `test/jellyfin-privacy.ts`, `test/jellyfin-client-contract.ts` | Tested fake/local adapter. No real network. Establishes collection curation by provider refs and minimized disclosure of `title` plus `providerRefs`. | Phase 205 mapping evidence and Phase 206 write policy. |
| Config and credential parser | `src/core/adapters/jellyfin/config.ts`, `test/jellyfin-http.ts` | Tested parser/redaction scaffolding. Credentials use `JELLYFIN_API_KEY` or `JELLYFIN_API_KEY_FILE`; errors avoid secret values. | Phase 204 credential handling and redaction checks. |
| Injected HTTP client | `docs/PHASE_11_JELLYFIN_HTTP.md`, `src/core/adapters/jellyfin/http-client.ts`, `src/core/adapters/jellyfin/transport.ts`, `src/core/adapters/jellyfin/real-factory.ts`, `test/jellyfin-http.ts` | Tested with fake injected transport. Network gate defaults off. Client uses caller-supplied fetch only. Find and revoke exist; bare create is disabled. | Phase 204 read-only smoke and Phase 206 gated write review. |
| Endpoint mapping | `src/core/adapters/jellyfin/mapping.ts`, `docs/PHASE_14_JELLYFIN_HARDENING.md`, `test/jellyfin-http.ts` | Tested against fake transport, still provisional against real Jellyfin. Paginates `/Items` and matches provider ids locally. | Phase 204 library lookup and Phase 205 mapping. |
| Smoke-test logic | `docs/PHASE_13_JELLYFIN_VALIDATION.md`, `src/core/adapters/jellyfin/smoke.ts`, `src/ops/jellyfin-smoke-cli.ts`, `test/jellyfin-smoke.ts` | Tested with fake smoke client. Operator CLI is opt-in and uses platform transport only when `JELLYFIN_ENABLE_NETWORK=true`. Current read-only smoke covers library lookup; Phase 204 must add/confirm auth and server-info checks before live use. | Phase 204 read-only smoke and Phase 206 disposable collection proof. |
| Durable write outbox | `src/core/adapters/jellyfin/outbox-target.ts`, `src/core/publish/outbox.ts`, `test/jellyfin-outbox.ts`, `docs/PHASE_12_PUBLISH_OUTBOX.md` | Tested with fixture transport. Write-capable path requires durable intent plus `JELLYFIN_ENABLE_NETWORK=true`, `JELLYFIN_ALLOW_LIVE_PUBLISH=true`, and external-publish consent. | Phase 206 only, after Phase 204 and Phase 205 evidence. |
| Evidence template | `docs/PHASE_15_JELLYFIN_VALIDATION_EVIDENCE.md`, `docs/templates/JELLYFIN_VALIDATION_EVIDENCE.md` | Redaction-safe operator evidence template exists, but predates current O4/O5 launch disposition. Reusable after refreshing labels in Phase 207 if needed. | Phase 207 evidence review and launch decision. |

Inventory verdict: existing Jellyfin scaffolding is reusable. It is tested locally/fake-transport and
gated, but live Jellyfin mapping remains unproven until Phase 204 read-only smoke evidence exists.

## Definition Of "Test"

Testing means a ladder of explicitly bounded operator validation rungs. No rung may be skipped, and
each rung requires the previous rung's redaction-safe evidence before proceeding.

### Rung 1: Phase 204 Read-Only Smoke

Purpose: prove a designated Jellyfin test instance can be reached and queried without writes.

Allowed operations:

- authentication/header validation through a read-only Jellyfin request;
- server information read;
- library item lookup by provider refs.

Allowed endpoint set:

- `GET /System/Info`
- `GET /Items?Recursive=true&Fields=ProviderIds&IncludeItemTypes=Movie,Series&StartIndex=<n>&Limit=<n>`

Forbidden in Rung 1:

- `POST`, `PUT`, `PATCH`, or `DELETE`;
- collection create, collection delete, item mutation, metadata refresh, playback session control,
  download, provider/debrid calls, scraping, or catalog mutation.

### Rung 2: Phase 205 Read-Only Mapping

Purpose: map Catalog Authority items to Jellyfin library items with redaction-safe evidence.

Allowed operations:

- read encrypted/minimized catalog identity only through existing authority privacy boundaries;
- query Jellyfin library items using the Rung 1 read-only endpoint set;
- emit evidence as counts, statuses, report IDs, and digests only.

Forbidden in Rung 2:

- writing to Jellyfin;
- writing catalog events from Jellyfin results;
- persisting Jellyfin item IDs as authoritative catalog truth;
- printing raw titles, provider refs, Jellyfin item IDs, API keys, or database URLs in evidence.

### Rung 3: Phase 206 Optional Write-Capable Disposable Collection

Purpose: prove a confined write round-trip only after read-only evidence has passed.

Disposable means:

- the collection is created by the test itself;
- the collection name is unambiguous and contains an opaque test marker;
- the collection is dedicated to the test and is not user-managed content;
- the test deletes it before completion;
- cleanup is verified by a post-delete lookup;
- if cleanup cannot be confirmed, the result is failed and the operator must manually remove the
  named test collection before any retry.

Allowed write operations:

- create one token-marked disposable collection;
- find that collection by the opaque marker;
- delete that collection;
- verify it is gone.

Forbidden in Rung 3:

- writes outside the disposable collection;
- writes to production/user collections;
- metadata refresh, playback session control, downloads, scraping, provider/debrid calls, or any
  media-file mutation;
- retrying silently after uncertain cleanup.

### Rung 4: Phase 207 Operator Evidence Review And Integration Launch Decision

Purpose: review retained redaction-safe evidence from Rungs 1-3 and decide whether Jellyfin
integration can move from testing to an explicitly scoped integration launch.

Phase 207 may accept, reject, or defer Jellyfin integration. It must not imply Plex, Emby, provider,
download, playback, or scraping readiness.

## Safety Invariants

- The target Jellyfin instance must be non-production or explicitly designated for Catalog Authority
  testing.
- Credentials must use existing secret-file conventions. No API key, token, password, or database URL
  may appear in committed docs, tests, logs, or evidence.
- No rung may exceed its write boundary.
- Every rung is gated on the previous rung's evidence.
- Catalog custody runtime remains sidecar-based and untouched throughout.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Plex and Emby remain deferred until separately authorized.

## Current Configuration Guard

Current committed configuration must remain fail-closed:

- `JELLYFIN_ENABLE_NETWORK` defaults off;
- `JELLYFIN_ALLOW_LIVE_PUBLISH` defaults off;
- `createRealJellyfinClient` requires caller-supplied transport and full config;
- `createRealJellyfinOutboxTarget` requires both network and live-publish gates;
- `JellyfinHttpClient.createCollection` remains disabled for bare creates;
- `smoke:jellyfin --write` refuses without `JELLYFIN_ALLOW_LIVE_PUBLISH=true`;
- no Docker Compose file enables Jellyfin networking or write mode by default.

## Exit

Phase 204 is unblocked only for read-only Jellyfin smoke design/execution. Phase 203 does not enable
live Jellyfin runtime, write-capable Jellyfin runtime, Plex, Emby, provider adapters, downloads,
playback, scraping, or media-server mutation.
