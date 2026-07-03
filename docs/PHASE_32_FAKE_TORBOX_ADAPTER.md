# Phase 32 - Local Fake TorBox Adapter Contract

Phase 32 adds a local fake contract only for a future TorBox ref-resolver. It is executable through
`test:torbox-fake-adapter`, but it is still offline/local only: no live TorBox, no SDK dependency,
no network transport, no credentials, no provider mode, no provider payload persistence, no
downloading, and no playback.

This phase derives from the Phase 31 boundary contract and the Phase 7 `ProviderAdapter` shape. The
fake adapter receives only `AdapterRefView`: an opaque `itemId` plus exactly one scoped
`{ refType, refValue }`. It never receives title, year, external ids, metadata, raw catalog
identity, raw provider ref fanout, URLs, tokens, or provider payloads.

## Local Contract

`src/core/adapters/fake-torbox-adapter.ts` implements `ProviderAdapter` directly. It is intentionally
not wired into `ADAPTER_MODE`; tests instantiate it directly so the production adapter factory stays
closed to TorBox.

Supported local fake ref types are limited to the Phase 31 cache-check boundary:

- `infohash`
- `hash-digest`
- `link-derived-digest`
- `nzb-derived-digest`

The fake returns advisory `AdapterResult` values only:

- `available` with an opaque local locator for configured fake hits;
- `unavailable` for supported local refs not configured as fake hits;
- `unknown` for unsupported ref types or empty refs.

Locators are non-reversible local handles derived from the opaque item id and ref type only. They do
not include raw refs, titles, URLs, tokens, provider payloads, CDN strings, or permalink strings.
Details are fixed redaction-safe strings.

## What This Does Not Prove

This does not prove real TorBox works. It does not validate TorBox credentials, endpoint mapping,
availability semantics, rate limits, auth behavior, token handling, CDN/permalink behavior, or any
real provider response shape.

The value of this phase is narrower: it proves that a TorBox-shaped local contract can satisfy the
Phase 7 adapter privacy boundary before a separately gated real client exists.

## Future Gates

A real TorBox client remains a separate future phase. That phase must choose SDK vs injected
transport, add bounded timeouts, fail-closed network/auth/quota/parse behavior, redaction-safe
errors, secret indirection, and live smoke validation outside CI.

Phase 33 adds `docs/PHASE_33_TORBOX_REAL_CLIENT_GATE.md` and
`src/core/adapters/torbox-real-client-gate.ts` as a design gate, not a live client. It keeps
injected transport only, no SDK dependency, no ADAPTER_MODE wiring, and says any future real client
must be separately authorized/reviewed.
Phase 34 adds `docs/PHASE_34_TORBOX_READONLY_FIXTURE.md` and
`src/core/adapters/torbox-readonly-client.ts` as an executable read-only fixture client over an
in-memory injected test transport only. It is not a live client, does not prove real TorBox works,
and does not add ADAPTER_MODE wiring.

Create/download-link/token-query flows remain future-gated/high risk. They can create provider-side
state or produce metered CDN/permalink/token-bearing URLs, so they require a separate durable
outbox/idempotency/revocation review before any implementation.

O4 remains open/deferred. O5 remains open/deferred. FileCustodian remains a hardened reference harness,
not production KMS.
