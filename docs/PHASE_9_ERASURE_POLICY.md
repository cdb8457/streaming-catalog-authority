# Phase 9 — External-Publishing Erasure Policy

Phase 8 built the publisher boundary but deferred the hard question: **publishing identity to an
external system copies it outside the crypto-shredding boundary**, so a later `forget` (which
destroys the DEK and makes the local ciphertext unrecoverable) **cannot reach the external copy**.
Phase 9 builds the machinery to make future real publishing *responsible*, using **fakes/local only**
— no real Plex/Jellyfin, no network, no credentials.

The policy has three parts: a **consent gate**, an **identity-free ledger**, and **best-effort
revocation on forget**. The honest limitation is stated up front: an external copy cannot be
un-created; the contract is *consent + record + best-effort unpublish + visibility*, not a guarantee.

## 1. Consent gate (fail-closed)

```
PUBLISH_EXTERNAL_IDENTITY=allow    -> live publishes permitted
(unset | unknown | anything else)  -> DENY  (fail-closed)
```

A **live** (non-dry-run) publish sends minimized identity outside the boundary, so it is **refused**
(`PublishConsentError`) unless consent is explicitly `allow`. A **dry-run is always allowed** — nothing
leaves the boundary — so operators can exercise the whole flow safely. Enforced by `PublishService`.

## 2. Identity-free publish ledger

Every **live** publish records one `publish_ledger` row (a dry-run records nothing). The row stores
**only**:

| column | contents |
|---|---|
| `item_id` | opaque UUID (no content; **no FK** — survives `forget`) |
| `target` | adapter/target name (non-identity) |
| `external_handle` | opaque locator the publisher returned |
| `disclosed_fields` | the **NAMES** of fields shared (`title`/`year`/`providerRefs`) — never values |
| `status`, `attempt_count`, timestamps | lifecycle state |

It **never** stores title, ref values, externalIds, metadata, or ciphertext — and a DB `CHECK`
(`disclosed_fields <@ {title,year,providerRefs}`) means a value can never even be slipped into the
field-names column. The table is **owner-managed**: the app has `SELECT` only and mutates it solely
through the `cat_publish_*` `SECURITY DEFINER` functions (a direct `INSERT`/`UPDATE` is denied).

The row is a **tombstone that intentionally survives `forget`** (decision, approved) — it holds no
identity, and it is what lets revocation find the external copy after the item is forgotten.

## 3. Forget → reconcile → revoke (best-effort unpublish)

**`forget` is never modified** — it still only flips `items.forgotten` and destroys the DEK. External
cleanup runs **out-of-band**:

1. `cat_publish_reconcile_forgotten()` marks the `published` rows of now-forgotten items
   `revoke_pending`.
2. `runRevocation(pool, revoker)` hands each row's **opaque handle** (no identity) to a
   `RevocationAdapter` and marks it `revoked` on success (or `not_found` = already gone).
3. A failed revoke **bumps `attempt_count` and keeps the row `revoke_pending`** — an unrevoked
   external copy stays **visible + retryable**, never silently dropped. `countRevokePending()`
   surfaces the backlog for operators.

The revoker is a **separate** family (`RevocationAdapter`) from the publisher and needs only the
opaque handle. Phase 9 ships a local `FakeRevoker`.

## Coexistence

The Phase 7 ref-resolver boundary and the Phase 8 publisher boundary are **unchanged**. Phase 9 adds
the ledger, consent gate, and revocation flow around them; `withPublishableIdentity` and `forget`
keep their exact semantics.

## Limitation (explicit)

This does **not** make external identity truly erasable — a copy that already left cannot be
un-created. The guarantee is: identity leaves only with **explicit consent**, every departure is
**recorded without storing identity**, and `forget` drives a **best-effort revoke** whose failures
remain **visible**. Real external publishing/revocation adapters remain a future, reviewed integration.

## Out of scope (unchanged)

No real Plex/Jellyfin, no Real-Debrid/TorBox, no scraping/downloading/playback, no web/mobile UI, no
HTTP daemon/framework, no real network calls, no provider credentials, and **no new runtime
dependencies**.
