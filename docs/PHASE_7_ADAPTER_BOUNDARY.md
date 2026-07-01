# Phase 7 — Provider Adapter Boundary

The isolation layer for **future** provider/debrid adapters. Phase 7 builds the **contract + a
local fake harness + the privacy bridge + tests** — **no real providers, no network, no HTTP, no
UI**. It mirrors how the custodian boundary was built (interface → fakes → conformance kit) before
the managed-KMS gate.

## What crosses the boundary (and what never does)

An adapter receives **only** an `AdapterRefView`:

```ts
interface AdapterRefView { itemId: string; refType: string; refValue: string; }
```

- `itemId` is an **opaque UUID** — no catalog content leaks through the id channel.
- exactly **one scoped `{ refType, refValue }`** — the single provider ref needed for a lookup.
- **Never** the decrypted identity (title, year, externalIds, metadata), and never more than the
  one ref the caller scoped.

Adapters get **no database handle** and no identity access; `AdapterContext` exposes only a
redaction-safe logger.

## The privacy bridge — `CatalogAuthority.withProviderRef`

```ts
await auth.withProviderRef(itemId, refType, (view) => adapter.resolveRef(view));
```

It decrypts **exactly one** provider ref (via the per-item DEK — never the identity blob),
**registers the decrypted value with the `SecretStore`** for the callback's lifetime (so anything
logged inside is redacted), **deletes the registration afterwards**, and yields the `AdapterRefView`.
It is **fail-closed**: it returns `null` if the lineage isn't active, the custodian reports the key
not active, or the ref is absent, and it re-checks status at the linearization point (like
`readIdentity`). This is the same privacy machinery that guards identity (`withIdentity`), applied
to a single ref.

## Advisory, non-authoritative outputs

```ts
interface AdapterResult { status: 'available' | 'unavailable' | 'unknown'; locator?: string; detail?: string; }
```

Adapter results are **advisory**. The bridge hands `fn`'s return value back to the caller and
**never persists it** — the DB authority (the event log + `cat_*` functions) remains the single
source of truth. If a result should ever change catalog state, that must go through the authority as
a proper event (e.g. a behavioral signal) — **Phase 7 does not wire any such persistence**.

## Selection — `ADAPTER_MODE`

`ADAPTER_MODE=fake|none` (default `none` = no adapter configured). Unknown values **fail closed**
(`ConfigError`). Phase 7 ships only the local `FakeProviderAdapter` (deterministic, in-memory, no
network). Mirrors the custodian factory.

## Testing (fakes + local only)

- `test/adapter-contract.ts` — a shared conformance kit any adapter must pass, run against the fake
  and the factory-built fake; plus factory fail-closed checks.
- `test/adapter-privacy.ts` — proves the boundary: the view carries only the three keys (no
  identity), the scoped value is registered + **cleared** and **redacted in logs**, a curious
  adapter sees only the scoped view and its output is advisory with **no DB write**, and
  fail-closed paths return `null`.

## Deferred: identity-consuming publisher adapters

Media-server "publisher" adapters (e.g. Plex/Jellyfin library population) would require **identity**
to cross the boundary — a fundamentally higher-risk disclosure than a single ref. They are a
**separate, deferred design gate**, intentionally **not** modelled in Phase 7.

## Out of scope (unchanged)

No Real-Debrid/TorBox, no Plex/Jellyfin, no scraping, downloading, playback, no web/mobile UI, no
HTTP daemon/framework, no real network calls, and **no new runtime dependencies**. Adapter
implementations here are local reference fakes; a real adapter is a future, reviewed integration.
