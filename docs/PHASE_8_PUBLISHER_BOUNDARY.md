# Phase 8 — Publisher Adapter Boundary

The isolation layer for **future** identity-consuming publisher adapters (e.g. media-server library
sync). Phase 8 builds the **contract + a local fake harness + the scoped-identity bridge + tests** —
**no real Plex/Jellyfin, no network, no credentials, no persistence**. It extends the Phase 7
ref-resolver pattern with a *minimized* identity disclosure and a **dry-run-first** posture.

## ⚠️ Policy note — publishing identity vs crypto-shredding (deferred gate)

Publishing identity into an **external** system creates a copy **outside** the crypto-shredding
boundary: a later `forget` destroys the DEK and makes the local ciphertext unrecoverable, but it
**cannot reach a copy already pushed to Plex/Jellyfin/etc.** This directly tensions the erasure
guarantee. Therefore **Phase 8 does not publish anywhere real** — the fake's "live" path writes only
to an in-memory sink. **Real external publishing is a separate, deferred policy gate** that requires
an explicit decision (e.g. publish only non-identifying metadata, accept that published copies are
outside the erasure guarantee, or wire a "forget → unpublish" reconciliation). That decision is for
the Coordinator/Clint before any real publisher is built.

## What crosses the boundary (minimized)

A publisher **declares** the fields it needs (`requires`), and the bridge yields a
`PublishableIdentity` containing **only those** — plus the opaque `itemId`:

```ts
type PublishableField = 'title' | 'year' | 'providerRefs';
interface PublishableIdentity { itemId: string; title?: string; year?: number | null; providerRefs?: {type,value}[]; }
```

- **Never** `externalIds`, internal `metadata`, or ciphertext — regardless of what the item stores.
- Data minimization is enforced by construction: `requires:['title']` yields `{ itemId, title }` only.

Publishers get **no database handle**; `PublisherContext` exposes only a redaction-safe logger.

## The scoped-identity bridge — `CatalogAuthority.withPublishableIdentity`

```ts
await auth.withPublishableIdentity(itemId, publisher.requires, (identity) =>
  publisher.publish({ identity, dryRun: true }));   // dry-run is the default
```

It decrypts the identity, composes the minimized projection, **registers every disclosed string
(title + ref values) with the `SecretStore`** for the callback's lifetime (logs redacted) and
**clears them afterwards** (DEK zeroized). It is **fail-closed** — returns `null` if the lineage/key
is not active or the item is absent/forgotten/shredded — and **TOCTOU-hardened**: at the
linearization point it rechecks the item is still present, **not forgotten**, and `identity_ct`
**unchanged**, so a `forget`/update landing mid-bridge fails closed and no stale/forgotten identity
is disclosed.

## Advisory, non-authoritative outputs

```ts
interface PublishResult { status: 'published' | 'skipped' | 'failed'; dryRun: boolean; handle?: string; detail?: string; }
```

Results are **advisory**. The bridge returns `fn`'s value and **never persists it** — no event-log
writes. Recording a publish (e.g. "published at handle X") would be a future authority-mediated
event; **Phase 8 wires no persistence**. **Dry-run is the default** and has zero side effects; the
fake's non-dry-run path records only to a local in-memory sink.

## Selection — `PUBLISHER_MODE`

`PUBLISHER_MODE=none|fake` (default `none` = no publisher; identity never crosses the boundary).
Unknown values **fail closed** (`ConfigError`). Phase 8 ships only the local `FakePublisherAdapter`.

## Coexistence with the Phase 7 ref-resolver boundary

Two **distinct** adapter families, kept fully separate — the publisher boundary does **not** touch or
weaken the ref-resolver boundary:

| | Ref-resolver (Phase 7) | Publisher (Phase 8) |
|---|---|---|
| Interface | `ProviderAdapter` | `PublisherAdapter` |
| Bridge | `withProviderRef` | `withPublishableIdentity` |
| Config | `ADAPTER_MODE` | `PUBLISHER_MODE` |
| Input | opaque id + **one scoped ref**, **no identity** | opaque id + **declared minimized identity fields** |
| Output | advisory `AdapterResult` | advisory `PublishResult` (dry-run default) |

## Testing (fakes + local only)

- `test/publisher-contract.ts` — conformance kit (describe/dry-run/live) + factory fail-closed.
- `test/publisher-privacy.ts` — proves minimized disclosure (no externalIds/metadata), per-`requires`
  minimization, `SecretStore` clear, log redaction, forgotten-item fail-closed, TOCTOU forget mid-bridge,
  and **no DB writes** (advisory; live publish hits the local sink only).

## Out of scope (unchanged)

No real Plex/Jellyfin, no Real-Debrid/TorBox, no scraping/downloading/playback, no web/mobile UI, no
HTTP daemon/framework, no real network calls, no provider credentials, **no persistence writes**, and
**no new runtime dependencies**.
