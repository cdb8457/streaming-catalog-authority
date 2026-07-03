# Phase 42 - TorBox Live Transport

Phase 42 adds the first live-capable TorBox transport for a future operator-run read-only smoke. It
does not run by default, is not wired into `ADAPTER_MODE`, is not in CI as a live network command,
does not import the TorBox SDK, and does not read environment variables or secret files.

The transport lives at `src/ops/torbox-live-transport.ts` and is covered by
`test:torbox-live-transport`. Tests use injected fake fetch functions only; they never contact
TorBox.

## Scope

Included:

- an injected-fetch `createTorBoxLiveTransport` implementation of the existing `TorBoxTransport`
  contract;
- GET-only mapping for the Phase 41 reviewed read-only endpoints;
- bearer-header authentication for cache checks only;
- unauthenticated status and public hoster probes;
- bounded timeout and bounded retry;
- response normalization to fixed `availability` plus fixed categories only;
- deterministic fake-fetch tests and deploy guard wiring.

Not included:

- no TorBox SDK dependency or import;
- no default live smoke execution;
- no `globalThis.fetch` construction in this module;
- no environment-variable reads, secret-file reads, DB writes, event-log writes, provider payload
  persistence, `ADAPTER_MODE` wiring, or adapter-factory mode for TorBox;
- no request-download-link, request-permalink, token-query download route, CDN URL, permalink URL,
  create-download, user-list, user-data, control, delete, export, downloading, playback, Plex,
  Jellyfin, Real-Debrid, HTTP service, frontend runtime, or UI behavior.

## Reviewed Endpoints

| Operation id | Path | Method | Auth | Query |
|---|---|---|---|---|
| `status-check` | `/` | `GET` | none | none |
| `hoster-list` | `/v1/api/webdl/hosters` | `GET` | none | none |
| `torrent-cache-check` | `/v1/api/torrents/checkcached` | `GET` | Authorization Bearer header | `hash`, `format=object`, `list_files=false` |
| `webdl-cache-check` | `/v1/api/webdl/checkcached` | `GET` | Authorization Bearer header | `hash`, `format=object`, `list_files=false` |
| `usenet-cache-check` | `/v1/api/usenet/checkcached` | `GET` | Authorization Bearer header | `hash`, `format=object`, `list_files=false` |

The bearer credential is supplied by the caller. Phase 42 does not define where an operator stores
that secret and does not read it from the environment or filesystem. The transport rejects empty
tokens and non-HTTPS base URLs.

## Redaction And Output

The transport never returns raw provider response bodies. It maps successful responses into:

- `available`
- `unavailable`
- `unknown`

Failures use only fixed categories:

- `auth`
- `quota`
- `timeout`
- `transport`
- `parse`
- `ambiguous-availability`
- `forbidden-operation`

Public evidence must still come from the Phase 35 evidence shape. A later operator CLI may call this
transport only after Phase 36 ordering is preserved: explicit operator authorization, out-of-CI
execution, read-only acknowledgement, secret indirection, bounded timeout, and redaction mode before
network contact.

## Still Future-Gated

These remain outside Phase 42 and require a separate explicit phase:

- request-download-link, request-permalink, and token-query download routes such as `requestdl`;
- CDN and permalink URLs;
- create, control, edit, delete, user-data, user-list, export, library-management, downloading, and
  playback behavior;
- adapter-factory/`ADAPTER_MODE` enablement;
- any automatic scheduler, daemon, UI, or CI live-network requirement.

Phase 42 does not prove TorBox works against a real account. It proves only that the live-capable
transport construction is narrow, injected, GET-only, redaction-normalized, and reviewable.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.
