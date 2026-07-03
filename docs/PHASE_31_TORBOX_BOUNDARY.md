# Phase 31 - TorBox Adapter Boundary Research

Phase 31 converts the official TorBox API/SDK surface into a repo-native boundary contract for a
future provider/debrid adapter. It is research/specification only: no live TorBox, no downloading,
no playback, no provider mode, no SDK dependency, and no runtime behavior.

## Official Sources Reviewed

- TorBox API docs: https://api-docs.torbox.app/
- Official JavaScript/TypeScript SDK: https://github.com/TorBox-App/torbox-sdk-js
- SDK package documented by TorBox: `@torbox/torbox-api`
- SDK base URL documented by TorBox: `https://api.torbox.app`
- SDK auth model documented by TorBox: token authentication, with service clients for
  `TorrentsService`, `WebDownloadsDebridService`, `UsenetService`, and `GeneralService`.

The static contract is in `src/core/adapters/torbox-boundary.ts`. It records the official surface
without importing the SDK or creating a real adapter. Phase 32 adds
`docs/PHASE_32_FAKE_TORBOX_ADAPTER.md` and `test:torbox-fake-adapter` as a local fake contract only;
it does not prove real TorBox works and does not change the no live provider boundary.
Phase 33 adds `docs/PHASE_33_TORBOX_REAL_CLIENT_GATE.md`,
`src/core/adapters/torbox-real-client-gate.ts`, and `test:torbox-real-client-gate` as a design gate,
not a live client; it keeps injected transport only, no SDK dependency, no ADAPTER_MODE wiring, and
a future real client must be separately authorized/reviewed.
Phase 34 adds `docs/PHASE_34_TORBOX_READONLY_FIXTURE.md`,
`src/core/adapters/torbox-readonly-client.ts`, and `test:torbox-readonly-client` as an executable
injected-transport fixture only. It still makes no live TorBox calls, proves no real TorBox behavior,
and keeps ADAPTER_MODE closed to TorBox.

## Capability Map

| Capability | Official group/surface | Phase 31 status | Boundary decision |
|---|---|---|---|
| `torrent-cache-check` | `TorrentsService.getTorrentCachedAvailability` | allowed as static expectation | Future advisory lookup by one infohash/hash digest only. |
| `webdl-cache-check` | `WebDownloadsDebridService.getWebDownloadCachedAvailability` | allowed as static expectation | Future advisory lookup by one link-derived digest only. |
| `usenet-cache-check` | `UsenetService.getUsenetCachedAvailability` | allowed as static expectation | Future advisory lookup by one NZB/hash digest only. |
| `hoster-list` | `WebDownloadsDebridService.getHosterList` | allowed as static expectation | Future provider metadata/status only; no item identity. |
| `status-check` | `GeneralService.getUpStatus` | allowed as static expectation | Future service health/status only; advisory. |
| `create-download` | create torrent/web download/Usenet download | future-gated | Creates provider-side state and can start download workflows. |
| `request-download-link` | request download link endpoints | future-gated | Produces metered CDN/permalink URLs and token-query risks. |

## Data Crossing Rules

A future TorBox ref-resolver must fit the Phase 7 adapter boundary:

- inbound: opaque `itemId` plus exactly one scoped provider ref;
- acceptable scoped refs: infohash/hash digest, link-derived digest, or NZB-derived digest;
- outbound: advisory availability/status and redaction-safe diagnostics only;
- future opaque handles require a separate gate before persistence or replay.

The following must never cross into a TorBox adapter: title, year, external ids, metadata, raw
catalog identity, raw provider ref fanout, media titles, Plex ids, Jellyfin ids, download URLs, CDN
URLs, or permalink URLs.

## Forbidden In Phase 31

Phase 31 must not:

- install or import `@torbox/torbox-api`;
- call TorBox or any network;
- read `process.env`, secret files, API keys, or tokens;
- create torrents, web downloads, or Usenet downloads;
- request download links or store CDN/permalink URLs;
- retrieve user lists or user data;
- control, delete, or export provider items;
- persist adapter outputs or write catalog DB state;
- add adapter factory mode, scheduler, Docker, HTTP, UI, scraping, downloading, playback, Plex, or
  Jellyfin workflows.

## Credential And Redaction Rules

Future TorBox credentials must be introduced only through secret indirection. Tokens must not appear
in URLs, logs, evidence, thrown messages, persisted outputs, fixtures, or docs examples. Prefer
Authorization Bearer/header auth where the official surface permits it. Any official token-query
surface, including download-link/permalink flows, requires a separate future security gate and is
not allowed in Phase 31.

## Future Sequence

1. Local fake TorBox adapter contract: Phase 32 implements a no-network fake against this capability
   map and the Phase 7 `AdapterRefView` shape.
2. Gated real client design: Phase 33 records injected transport only, timeout, backoff, redaction,
   and fail-closed behavior without enabling a live client or live CI.
3. Injected-transport fixture: Phase 34 executes the read-only request/parse/redaction contract
   against an in-memory test transport only, without live enablement.
4. Operator-run smoke only: if a real client is later approved, live TorBox validation must be
   opt-in and outside CI.
5. Mutating/link flows only after durable orphan-safe design: create-download and
   request-download-link need a separate outbox/idempotency/revocation review before use.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.
