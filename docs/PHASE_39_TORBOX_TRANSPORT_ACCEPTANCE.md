# Phase 39 - TorBox Transport Acceptance Harness

Phase 39 adds a deterministic transport acceptance harness for the future TorBox read-only transport.
It does not add a live TorBox transport. It still does not add SDK integration, provider mode,
environment reads, or proof that TorBox works against a real account.

The harness lives at `src/ops/torbox-transport-acceptance.ts` and is covered by
`test:torbox-transport-acceptance`. It exercises the existing injected `TorBoxReadOnlyClient`
against local fixture transports only.

## Scope

Included:

- deterministic transport acceptance harness for read-only TorBox operations;
- local fixture coverage for `available`, `unavailable`, `unknown`, `auth`, `quota`, `timeout`,
  `parse`, and `ambiguous-response`;
- acceptance evidence limited to operation ids, route ids, fixed categories, statuses, and counts;
- deterministic tests in `test:torbox-transport-acceptance`;
- deploy guard wiring that keeps the harness in CI while keeping operator live smoke out of CI.

Not included:

- no live TorBox calls;
- no real TorBox transport implementation;
- no `@torbox/torbox-api` dependency or import;
- no global fetch, Node network modules, browser automation, Docker invocation, HTTP service,
  frontend runtime, UI build tooling, scraping, downloading, playback, Plex, Jellyfin, Real-Debrid,
  or provider expansion;
- no environment-variable reads, secret-file reads, token handling, token-in-URL examples, DB
  writes, event-log writes, provider payload persistence, `ADAPTER_MODE` wiring, or adapter-factory
  mode for TorBox;
- no adapter-factory mode for TorBox;
- no create-download, request-download-link, request-permalink, user list, user data, control,
  delete, export, CDN, permalink URL, library-management, or media-server behavior.

## Acceptance Meaning

Phase 39 proves that a future reviewed transport must satisfy the read-only injected contract before
it can be considered for an operator-run live smoke command. The harness checks:

- the transport is supplied by injection;
- only read-only operations are exercised;
- local fixtures can model hit, miss, unknown, auth, quota, timeout, parse, and ambiguous provider
  response cases;
- public evidence does not retain raw refs, tokens, credential URLs, secret values, secret file
  paths, raw endpoint URLs, raw response bodies, provider payloads, titles, years, item ids, CDN
  URLs, or permalink URLs.

The harness deliberately places secret-looking raw refs and provider payloads inside local fixtures
and proves that the public report does not expose them.

## Readiness Meaning

Phase 39 is a safety gate, not live enablement. It does not prove live TorBox availability,
downloading, playback, media-server sync, or production readiness.

Phase 40 builds on this with a static `ops:torbox-smoke-readiness-preflight` descriptor check for
future operator smoke readiness review. That preflight remains descriptor-only: no live TorBox calls,
no real TorBox transport, no SDK, no environment-variable reads, no `ADAPTER_MODE` wiring, and no
live-smoke authorization.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.
