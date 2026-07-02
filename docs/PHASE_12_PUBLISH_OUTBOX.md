# Phase 12 — Durable Publish-Intent Outbox (orphan-safe live Jellyfin create)

Phase 11 shipped real Jellyfin **find + revoke** but hard-disabled real **create**, because a remote
`POST /Collections` can create the external collection and then fail before a revocation handle is
recorded — an untracked, unrevocable **orphan**. Phase 12 adds the durable **publish-intent outbox**
(the transactional-outbox / write-intent-before-side-effect pattern) that makes live create orphan-safe,
and enables it **only through the outbox**, triple-gated.

## The core idea — recover by TOKEN, not by the response

1. **Write a durable intent BEFORE the create** (`publish_ledger`, status `planned`), carrying an opaque
   **`correlation_token`** — identity-free, the recovery key.
2. **Tag the created collection with the token** — embedded atomically in the collection name as
   `[cat:<token>]`, so a single create is findable afterwards even if the response is lost.
3. **Recover by token, never by the (possibly-lost) response handle.** `reconcile()` searches Jellyfin
   for the token: **found → adopt** the handle (`published`, revocable); **not found → (re)create**
   within a bounded budget, else **failed**. A per-intent advisory lock serializes reconcilers so a
   retry never double-creates.

Result: at **every** crash point an intent ends **tracked (revocable)** or **provably gone** — never an
untracked/unrevocable orphan.

## Crash matrix (all proven, fake transport + real-client-over-fixture)

| crash point | intent state | recovery |
|---|---|---|
| before POST | `planned` | reconcile: token not found → (re)create |
| after POST, before response | `ambiguous`, collection tagged | reconcile: **token found → adopt** |
| after response, before ledger write | `ambiguous` (handle lost) | reconcile: **token found → adopt** (the token, not the lost handle, is truth) |
| after ledger write | `published` | reconcile: idempotent no-op |
| persistent failure | `ambiguous`→…→`failed` | bounded retry, surfaced by doctor |

The **hard case** — *server creates, response lost, process state discarded* — is a first-class test:
a fresh `OutboxService` (no in-memory state) `reconcile()`s and **adopts the tagged collection by token**
with **no duplicate**.

## Schema (`publish_ledger` extended → `MIGRATION_VERSION = 3`)

Still identity-free. Adds `correlation_token` (opaque, unique), a **nullable** `external_handle`
(unknown until confirmed), and the intent states `planned | in_flight | ambiguous | failed` alongside
`published | revoke_pending | revoked`. Owner-managed; the app mutates only via the `cat_publish_*`
`SECURITY DEFINER` functions (`plan`/`lock_intent`/`mark_in_flight`/`mark_ambiguous`/`settle`/`mark_failed`).
A full-table scan test proves no title/ref values/externalIds/metadata/ciphertext persist.

## Three gates + no create outside the outbox

A live create requires **all** of: `JELLYFIN_ENABLE_NETWORK=true`, `JELLYFIN_ALLOW_LIVE_PUBLISH=true`
(default off — enable only after `smoke:jellyfin` validates the mapping), and
`PUBLISH_EXTERNAL_IDENTITY=allow`. The **bare** `createCollection` stays disabled; the only real-create
path is `createTaggedCollection`, reachable solely through the outbox target.

## Ops surface

- **`ops:doctor`** adds a `publish-intents` check — stuck `in_flight`/`ambiguous` intents surface as
  `warn` (monitorable via `--json`), plus the existing `publish-revocations` check.
- **`ops:publish-reconcile`** (opt-in, gated, not in CI) reconciles the outbox (adopt/create/fail) then
  drives revocation of forgotten items' external copies. Redaction-safe counts only.

## Live create status (this release)

**Enabled — only through the outbox, triple-gated.** The outbox recovery logic is **proven orphan-safe**
by the crash-matrix tests (fake target and the real client over a fixture transport). The **real Jellyfin
endpoint mapping remains PROVISIONAL** (name-embedded token marker; `POST /Collections`; BoxSet search)
and must be confirmed against a real server via `smoke:jellyfin` before an operator relies on it.

## Out of scope / limits (unchanged)

No Plex, no provider/debrid adapters, no scraping/downloading/playback, no HTTP daemon/UI, no live
network calls in CI, no new runtime dependencies. Revocation still cannot reach a collection Jellyfin
itself exported/copied (documented in Phase 10/11).
