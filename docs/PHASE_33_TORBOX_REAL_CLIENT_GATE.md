# Phase 33 - TorBox Real Client Gate Design

Phase 33 is a design gate, not a live client. It records the repo-native contract a future real
TorBox client must satisfy, while keeping TorBox disabled by default and impossible to enable in this
phase.

The static contract lives in `src/core/adapters/torbox-real-client-gate.ts`. It defines an injected
transport only, bounded timeout/backoff policy data, allowed read-only operation names, future-gated
operation names, and redaction-safe gate errors. It does not construct a network client.

Phase 34 builds on this contract with `src/core/adapters/torbox-readonly-client.ts` and
`test:torbox-readonly-client`, using an in-memory injected fixture transport only. That phase makes
request mapping, strict fixture parsing, fail-closed behavior, and redaction executable without live
TorBox enablement.

Phase 35 adds `docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md`,
`docs/templates/TORBOX_SMOKE_EVIDENCE.md`, and `docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md` as
operator-run smoke evidence design and future UI-readiness examples only. It adds no live transport,
SDK, provider mode, or UI runtime.

## Scope

Included:

- injected transport only, with no implementation;
- no SDK dependency or import (`@torbox/torbox-api` remains documented only);
- disabled plan / fail-closed gate helpers only;
- read-only operation contract for cache, status, and hoster checks;
- redaction-safe errors exposing operation, status, and category only;
- bounded timeout/backoff policy data for future review.

Not included:

- no live TorBox calls;
- no global fetch or Node transport modules;
- no environment-variable reads or secret-file reads in TorBox modules;
- no DB writes, event-log writes, provider payload persistence, Docker invocation, HTTP service, UI,
  scraping, downloading, playback, Plex, Jellyfin, or Real-Debrid expansion;
- no ADAPTER_MODE wiring and no adapter-factory mode for TorBox.

## Future Authorization

A future real client must be separately authorized/reviewed before any provider mode exists. That
future phase must decide whether to use the official SDK package or keep an injected transport, then
review endpoint mapping, credential handling, timeout/retry behavior, redaction, rate-limit handling,
and fail-closed semantics.

Live smoke must be operator-run outside CI. CI must remain deterministic and must not require TorBox
credentials, network access, provider accounts, SDK installation, Docker, or browser automation.
Phase 34 does not change this: real transport/smoke remains separately authorized and operator-run
outside CI.
Phase 35 documents the evidence template for that future operator-run smoke, but still does not
authorize or implement live smoke.

## Allowed Read-Only Operations

Only these operation categories are allowed in the Phase 33 contract:

- cache checks: `torrent-cache-check`, `webdl-cache-check`, `usenet-cache-check`;
- service status: `status-check`;
- hoster capability/status metadata: `hoster-list`.

These are still design names only. They do not call TorBox and do not prove real TorBox works.

## Future-Gated Operations

The following remain outside this phase:

- create/download workflows;
- request-download-link/token-query/permalink/CDN flows;
- user list or user data access;
- provider control, delete, or export flows.

Request-download-link/token-query/permalink/CDN flows remain high risk because they may open metered
links, create revocation obligations, or expose credential-bearing provider surfaces. They require a
separate durable outbox/idempotency/revocation review before any implementation.

## Error And Redaction Rules

Gate errors expose only:

- operation;
- optional status;
- category.

They must never expose credentials, endpoint strings, raw refs, titles, years, metadata, raw response
bodies, CDN locations, permalink locations, or provider payloads.

## Production Gates

O4 remains open/deferred. O5 remains open/deferred. FileCustodian remains a hardened reference harness,
not production KMS.
