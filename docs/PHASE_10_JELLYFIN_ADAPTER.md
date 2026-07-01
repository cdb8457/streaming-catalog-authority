# Phase 10 — Jellyfin Publisher Adapter (fake/local only)

The first *concrete* media publisher adapter, targeting self-hosted **Jellyfin** (fits the Unraid
direction; open local API; no cloud account, unlike Plex). **Phase 10 is fakes/local only** — a local
in-memory client + config/redaction scaffolding. **The real HTTP client is deferred to Phase 11**
behind an explicit env gate; Phase 10 makes **no real network calls** and adds **no dependencies**.

## What "publishing to Jellyfin" means

Jellyfin owns its library (files + its own metadata providers); there is no sensible "inject a catalog
item" endpoint. So the operation is **collection curation keyed on provider refs**:

1. resolve which Jellyfin **library items** match our `providerRefs` (tmdb/imdb/…);
2. create a **collection** named by `title` over the matched items;
3. the opaque **collection id** is the publish handle (recorded in the Phase 9 ledger).

## Minimized identity (`['title', 'providerRefs']`)

The adapter declares **exactly** `requires: ['title','providerRefs']` — `title` names the collection,
`providerRefs` resolve the library items. **No `year`, no `externalIds`, no `metadata`.** The Phase 8
`withPublishableIdentity` bridge enforces this: the adapter can only ever receive those two fields, and
the fake client's `seenRefs` shows only provider refs cross to Jellyfin's matching call (privacy test).

## Deterministic no-match / partial-match policy

| case | result | ledger |
|---|---|---|
| no refs, or **all** refs unmatched | `skipped` (no handle) | **no row** |
| **dry-run** (any matches) | `skipped` with `M/N matched` counts | **no row** |
| **live**, ≥1 match | `published`, collection over the **matched items only**, opaque handle | **one row** (handle created) |

A ledger row is written **only if a collection handle is created** — never for a skipped/dry-run/
all-unmatched publish. Partial matches publish the matched subset and report `M/N` in `detail`.

## Revocation (by opaque collection id) — and its limits

`JellyfinRevoker.revoke(handle)` deletes the collection by its **opaque id only** (never identity);
`not_found` (already gone) is treated as success. This plugs into the Phase 9 flow: on `forget`,
reconciliation queues the row and the revoker deletes the collection; a failed delete stays
`revoke_pending` and is surfaced by `ops:doctor`.

**What revocation CANNOT guarantee** (documented honestly):
- Jellyfin's **own logs/telemetry** may retain the provider-ref values we sent to its matching call —
  deleting the collection does **not** scrub them.
- If a user/admin **exported, renamed, or copied** the collection, those copies are beyond our reach.
- Jellyfin must be **reachable** to delete; while unreachable the row stays `revoke_pending` (retryable).

## Config / credentials (scaffolding only in Phase 10)

`JELLYFIN_BASE_URL`, `JELLYFIN_API_KEY` / `JELLYFIN_API_KEY_FILE`, optional `JELLYFIN_USER_ID`, parsed by
`loadJellyfinConfig` (Stage 3.1 pattern; `null` when unconfigured, `ConfigError` on partial/invalid —
**never leaking the api key value**). The api key is a secret: `registerJellyfinSecret` registers it with
the `SecretStore` (redacted in logs), and it is **never** written to the ledger or a `PublishResult`.
This module builds **nothing capable of network I/O** — `createJellyfinAdapters(client)` is pure wiring
over an **injected** client (a fake in Phase 10; the real HTTP client is Phase 11).

## Consent still applies (Phase 9)

A live Jellyfin publish sends `title` + ref values to the server (outside the crypto-shredding boundary),
so it still requires `PUBLISH_EXTERNAL_IDENTITY=allow`. A dry-run is always allowed.

## Out of scope (unchanged)

No **real** Jellyfin HTTP client (Phase 11), no Plex, no Real-Debrid/TorBox, no scraping/downloading/
playback, no web/mobile UI, no HTTP daemon, no real network calls, no provider credentials exercised,
and **no new runtime dependencies** (the eventual real client uses platform `fetch`). Phases 7–9
boundaries — the ref-resolver boundary, the publisher minimization, and the erasure-policy ledger —
remain unchanged.
