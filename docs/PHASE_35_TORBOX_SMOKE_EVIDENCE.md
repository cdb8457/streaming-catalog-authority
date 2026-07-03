# Phase 35 - TorBox Operator-Run Smoke Evidence Design

Phase 35 is operator-run smoke design and evidence shape only. It is not a live TorBox transport,
not a real client, not a UI, and not a proof that TorBox works against a real account.

This phase prepares the next safe review step before any live TorBox transport by defining the
authorization gates, read-only probe boundary, redaction rules, evidence retention shape, and future
operator dashboard examples. Real transport and live smoke remain a future separately authorized and
reviewed phase.

Phase 36 follows this with `docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md`, an acceptance contract for
the future live smoke command. Phase 36 still adds no live transport, no operator CLI, no SDK
dependency, and no provider mode.

## Scope

Included:

- documentation for a future operator-run TorBox smoke;
- a redaction-safe evidence template at `docs/templates/TORBOX_SMOKE_EVIDENCE.md`;
- future operator dashboard examples at `docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md`;
- static tests that prove the Phase 35 docs, template, and package wiring preserve the boundary.

Not included:

- no live TorBox calls;
- no real TorBox transport implementation;
- no `@torbox/torbox-api` dependency or import;
- no global fetch, Node network modules, browser automation, Docker invocation, HTTP service, UI
  runtime, UI build tooling, scraping, downloading, playback, Plex, Jellyfin, Real-Debrid, or
  provider expansion;
- no browser automation;
- no environment-variable reads, secret-file reads, token handling, token-in-URL examples, DB
  writes, event-log writes, provider payload persistence, `ADAPTER_MODE` wiring, or adapter-factory
  mode for TorBox;
- no create-download, request-download-link, request-permalink, user list, user data, control,
  delete, export, CDN, or permalink URL behavior.

## Future Smoke Prerequisites

A future live smoke may only proceed after a separate phase explicitly authorizes live TorBox access.
That future phase must provide and review:

- a real transport injected into the already-gated read-only client boundary;
- out-of-CI execution only, with no deterministic test depending on provider credentials or network;
- read-only mode confirmation before any probe is attempted;
- secret indirection through an operator-owned mechanism, without recording secret values or secret
  file paths in evidence;
- a bounded timeout for each probe and an operator-visible total run bound;
- fail-closed categories for auth, quota, timeout, transport, parse, unsupported ref, empty ref,
  ambiguous response, and policy block;
- redaction review before evidence is shared or attached to a release handoff.

If any prerequisite is missing, the future smoke must fail closed before contacting TorBox.

## Allowed Future Smoke Probes

Only these read-only probes are eligible for a future operator-run smoke:

| Probe | Scope | Evidence allowed |
|---|---|---|
| Service status | TorBox service reachability/status category | fixed status/category only |
| Hoster metadata | Hoster capability/status metadata | count and category summary only |
| Cache availability | One scoped ref at a time | aggregate hit/miss/unknown counts only |

The cache-availability probe must run with one scoped ref at a time. Evidence must never include the
raw ref, catalog identity, provider payload, or item id used to trigger the probe.

The following remain forbidden: download links, create/download workflows, request-download-link,
request-permalink, user list, user data, control, delete, export, CDN, permalink, playback, scraping,
and any operation that opens provider content rather than reporting advisory availability.

## Redaction Rules

Evidence and logs must never record:

- tokens, API keys, bearer values, cookies, credentials, or secret-file paths;
- URLs with credentials, raw endpoint URLs, CDN URLs, permalink URLs, or download-link URLs;
- raw refs, infohashes, digests, link-derived inputs, NZB-derived inputs, or scoped-ref values;
- raw response bodies, provider payloads, request payloads, headers, or SDK diagnostics;
- catalog titles, years, metadata, external ids, item ids, or media-server identifiers.

Public output is limited to fixed summary statuses, counts, operation names, and fail-closed
categories. Any unexpected provider response shape is captured only as `ambiguous-response` or
`parse` without a raw snippet.

## Evidence Retention

The Phase 35 template keeps evidence to:

- commit or build id;
- read-only smoke confirmation;
- explicit gate checklist status;
- probe summary counts and fixed statuses;
- redaction-safe failure categories;
- operator and reviewer signoff.

The retained artifact must not include raw provider data. Operators may retain local private debug
notes outside the shareable evidence package, but those notes are not Phase 35 evidence and must not
be attached to release review.

## Readiness Meaning

A successful future smoke result would only show that the reviewed read-only probes returned
redaction-safe summaries during one operator-run execution. It would not prove production readiness,
would not validate downloading or playback, and would not close:

- O4, which remains open/deferred until a production external custodian/KMS adapter is accepted;
- O5, which remains open/deferred until managed KEK custody and scheduling evidence is accepted.

`FileCustodian` remains a hardened reference harness, not production KMS.
