# Phase 41 - TorBox Endpoint Mapping Review

Phase 41 records the current TorBox endpoint mapping needed before any future live read-only smoke
transport can be authorized. It is a static review artifact only: no TorBox calls, no SDK install,
no real transport implementation, no environment-variable reads, and no provider mode wiring.

Reviewed on 2026-07-03 from official TorBox sources:

- `https://api.torbox.app/openapi.json`
- `https://api.torbox.app/docs`
- `https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/TorrentsService.md`
- `https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/WebDownloadsDebridService.md`
- `https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/UsenetService.md`
- `https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/GeneralService.md`

## Reviewed Read-Only Mapping

| Operation id | SDK service method | OpenAPI path | Method | Auth | Phase 41 decision |
|---|---|---|---|---|---|
| `status-check` | `GeneralService.getUpStatus` | `/` | `GET` | none | Allowed for future reachability smoke only. Retain fixed status/category/counts only. |
| `torrent-cache-check` | `TorrentsService.getTorrentCachedAvailability` | `/v1/api/torrents/checkcached` | `GET` | `OAuth2PasswordBearer` via Authorization Bearer header | Allowed only as a future reviewed read-only cache check. Use one scoped infohash/hash digest and retain no raw provider payload. |
| `webdl-cache-check` | `WebDownloadsDebridService.getWebDownloadCachedAvailability` | `/v1/api/webdl/checkcached` | `GET` | `OAuth2PasswordBearer` via Authorization Bearer header | Allowed only as a future reviewed read-only cache check. Use one scoped link-derived digest and retain no raw provider payload. |
| `usenet-cache-check` | `UsenetService.getUsenetCachedAvailability` | `/v1/api/usenet/checkcached` | `GET` | `OAuth2PasswordBearer` via Authorization Bearer header | Allowed only as a future reviewed read-only cache check. Use one scoped NZB/link/file-derived digest and retain no raw provider payload. |
| `hoster-list` | `WebDownloadsDebridService.getHosterList` | `/v1/api/webdl/hosters` | `GET` | none for public hoster status | Allowed only for unauthenticated aggregate/public hoster status. Authenticated user-specific usage metrics are excluded from first smoke. |

OpenAPI also exposes `POST` variants for the cache-check paths. Phase 41 allows `GET` only for the
first future live-smoke transport because the official SDK mapping documents `GET` for those methods
and a smaller first surface is easier to review and redact.

## Required Request Rules

- Cache-check authentication must use the Authorization Bearer header through secret indirection.
- Query-string tokens are forbidden for cache checks.
- Future smoke evidence must never retain raw hashes, raw links, raw NZB material, raw endpoint URLs,
  raw provider response bodies, provider payloads, titles, years, item ids, CDN URLs, or permalink
  URLs.
- Output must stay limited to operation ids, route ids, fixed categories, statuses, and counts.
- The operator smoke command remains outside CI and still needs explicit authorization before any
  live TorBox contact.

## Future-Gated Or Excluded Endpoints

These endpoint families are not allowed by Phase 41 and require a later explicit phase:

- `/v1/api/torrents/requestdl`, `/v1/api/webdl/requestdl`, and `/v1/api/usenet/requestdl` because
  they require token query parameters and can expose CDN/permalink URLs.
- create-download, create-torrent, create-web-download, create-usenet-download, control, edit,
  delete, user-list, user-data, export-provider-data, library-management, downloading, and playback
  flows.
- `/v1/api/torrents/torrentinfo`; even though it is documented as unauthenticated, it is excluded
  from the first smoke surface because it returns torrent metadata and may perform provider-side
  metadata lookup behavior outside a simple cache-readiness check.
- authenticated hoster-list user metrics; the first smoke may only use public aggregate hoster
  status.

## Scope Boundary

Phase 41 does not add:

- no live TorBox calls;
- no real TorBox transport implementation;
- no `@torbox/torbox-api` dependency or import;
- no global fetch, Node network modules, browser automation, Docker invocation, HTTP service,
  frontend runtime, UI build tooling, scraping, downloading, playback, Plex, Jellyfin, Real-Debrid,
  or provider expansion;
- no environment-variable reads, secret-file reads, token handling, token-in-URL examples, DB writes,
  event-log writes, provider payload persistence, `ADAPTER_MODE` wiring, or adapter-factory mode for
  TorBox.

Phase 41 does not prove TorBox works against a real account and does not authorize live smoke.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.
