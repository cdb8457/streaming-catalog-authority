# Phase 1 Hardening — Response to Codex Review

Every finding from the review is addressed below: the fix, where it lives, and the test
that proves it. Suite is now **19 passed, 0 failed** (typecheck clean) against embedded
PostgreSQL 16.14. One finding is **reframed** rather than "fixed" — see P0-6.

## P0 blockers

| # | Finding | Fix | Proof |
|---|---------|-----|-------|
| 1 | No-leak bypass: `{op:"Top Secret Movie"}` passes | Replaced key-allowlist+signature with **typed per-event payload schemas**. `op` must be a member of a fixed ref-type enum matching `^[a-z0-9_]{1,32}$`; `weight` a bounded int. Signature scan kept as backstop. `noleak.ts` → `validateEventPayload`. | Test 4 asserts `{op:"Top Secret Movie"}`, `magnet:`, and `INFOHASH` are all rejected; Test 5 asserts the legitimate label `infohash` still passes. |
| 2 | Forget reversible via `addItem` | Forget is now **terminal**. `addItem` reads state under the item lock and throws `ForgottenItemError` for a forgotten id; a new `ItemRestored` event + `restore()` command is the only reversal. `addItem` is also idempotent (no duplicate `ItemAdded` while present). `authority.ts`, `reducer.ts`, `events.ts`. | Test 15 reproduces the resurrection attempt and asserts it throws + identity stays gone; Test 16 proves explicit restore; Test 10 proves idempotent first-add. |
| 3 | Rebuild lock coordinates with nothing | **Shared/exclusive maintenance lock.** Every writer takes `pg_advisory_xact_lock_shared(4242,1)`; rebuild/prune take the exclusive `pg_advisory_xact_lock(4242,1)`. Item locks use the disjoint single-bigint space. `authority.ts` (`withItemTxn` / `withMaintenanceTxn`). | Concurrency tests 7–9 + parallelism test 11 still green under the new lock discipline; rebuild can no longer interleave with a writer. |
| 4 | TTL projection diverges (prune ≠ projection) | `reduce` is **cutoff-aware**: a behavioral signal counts only while `expires_at > cutoff`. New `pruneAndRebuild(cutoff)` does prune (via the SECURITY DEFINER function) **and** refold **in one transaction with one cutoff**. `reducer.ts`, `authority.ts`. | Test 17: after expiry, `pruneAndRebuild` leaves only the live signal and `behavioral_score` reflects only it. |
| 5 | Append-only bypassable via `TRUNCATE` + open privileges | Added a `BEFORE TRUNCATE` guard trigger **and** a two-role model: owner/migrator vs least-privilege `app` (only SELECT+INSERT on `events`; explicit `REVOKE UPDATE,DELETE,TRUNCATE`). Pruning only via `prune_expired_behavioral()` `SECURITY DEFINER`. `migrations.sql`, `pool.ts`. | Test 18: app role denied UPDATE/DELETE/TRUNCATE (permission denied). Test 19: even the owner is blocked by the triggers. |
| 6 | Forget does not erase PostgreSQL history | **Reframed, not silently fixed.** Phase 1 now claims only **logical/projection erasure**; physical erasure (dead tuples, WAL, replicas, backups) requires **crypto-shredding**, scoped as the first Phase 2 task. Documented in `README.md` ("Erasure scope") and Phase 2 notes. | N/A — explicit scope correction. |

## Other gaps

| Finding | Fix | Proof |
|---------|-----|-------|
| `apply()` accepts arbitrary kind/type/expiry | `validateEnvelope` checks the type against `EVENT_REGISTRY` (type⇒kind, ttl rules) before persisting. | Test 6: unknown type, wrong kind, ttl-on-structural, missing-ttl all rejected, nothing persisted. |
| Mutation scan easy to evade; `reduce()`/raw pool callable | The real boundary is now **DB privileges** (the app role literally cannot mutate `events`); the static scan is retained as a lint, not the guarantee. | Tests 18–19. |
| Rebuild excludes `updated_at`; never a fresh DB | `updated_at` exclusion kept (it is a `now()` stamp, genuinely not derived). Added a **genuine fresh-DB fold**: capture log, wipe everything, re-insert events with original `seq`, refold, compare. | Test 14. |
| First-add race treats 20 duplicate `ItemAdded` as success | `addItem` idempotent: 20 concurrent adds → exactly one `ItemAdded`. | Test 10. |
| `BIGINT seq` → unsafe JS number | `seq` carried as **string** end-to-end (`PersistedEvent.seq: string`, `apply` returns string). | Test 7–9 assert `typeof seq === 'string'`. |
| Missing `Dockerfile` / `docker-compose.yml` / `.env.example` | Added all three; compose provisions `postgres:16` and an `app` runner. | Present in repo root. |
| Tests overwrite `DATABASE_URL`, contradicting external-server claim | Embedded boot is now a **fallback**: skipped entirely if `DATABASE_URL` is set; sets distinct `ADMIN_DATABASE_URL` + `DATABASE_URL`. | `test/run.ts` (boot guard), `embedded-pg.ts`. |
| `HANDOFF_FOR_REVIEW.md` untracked | Committed on this branch. | git. |

## Accepted as-is (your own assessment)

- The per-item `pg_advisory_xact_lock(hashtextextended(id,0))` + single-txn pattern is
  sound; hash collisions cause only false contention and xact locks cannot leak. The
  concurrency tests prove same-item serialization + atomic increment — now alongside
  lifecycle tests (tombstone/restore, coordinated prune, privilege/trigger enforcement)
  that cover the protocol, not just PostgreSQL primitives.

## Still deferred to Phase 2 (by design)

- Cryptographic erasure / key-retention architecture (see P0-6).
- Routing application logs through `assertNoLeak` (the scanner is already exported and
  reused; wiring app logging is Phase 2).
- Encrypted backup policy + restore that does not resurrect expired behavioral events.

---

# Second-pass remediation (Codex review #2)

Root cause of the new findings: enforcement lived in TypeScript, so anything holding the
app connection could bypass `CatalogAuthority`. Fixed by **moving the authority into the
database** — all mutation is via `SECURITY DEFINER` functions; the app role gets only
`SELECT` + `EXECUTE`. Suite is now **21 passed, 0 failed**.

| Finding | Fix | Proof |
|---------|-----|-------|
| No-leak serialization bypass via non-enumerable `toJSON()` (`{op:"tmdb"}` validates, `{op:"Top Secret Movie"}` persists) | Validate the **exact serialized value**: TS validates `JSON.parse(JSON.stringify(payload))` and passes the same string; the DB `cat_validate_payload` re-validates the stored jsonb. | Test 4 builds the non-enumerable `toJSON` object and asserts `apply` throws + nothing persists. |
| `item_id` not opaque (`addItem("Top Secret Movie")` stored the title) | Item ids are UUIDs: `mintItemId()`, an `isOpaqueItemId` check in TS, and a DB `CHECK` on `items.id` and `events.item_id`. | Test 5 (TS reject + DB CHECK reject). |
| Forget bypassable via `apply()`: `apply(ItemRestored)` cleared the tombstone; forgetting an unknown id left no tombstone | Lifecycle transitions enforced in the **apply path** (`cat_apply_internal`): `ItemRestored` requires a forgotten item, `ItemAdded` is rejected on a forgotten item, and `ItemForgotten` always writes a tombstone (even for an unknown id). | Tests 15, 16, 17. |
| Authority boundary not enforced: app role could raw-insert an event with `{"title":...}` and update `items.title` | App role has **no table DML** — only `SELECT` + `EXECUTE` on the `cat_*` functions. All writes happen inside `SECURITY DEFINER` functions. | Test 20 (raw insert / projection update / prune all denied). |
| Prune divergence: bare `prune_expired_behavioral()` deleted the event but left `behavioral_score` | Removed the bare prune. The only prune surface is `cat_prune_and_rebuild` (atomic prune + refold, one cutoff). | Test 19 + Test 20 (bare prune function no longer exists). |
| "Fresh DB" test only truncated; didn't advance the identity sequence | Re-fold now `setval`s the identity sequence and asserts a subsequent append gets `max+1`. | Test 14. |
| Tests 3–4 didn't `await assertThrows` | `assertThrows` is awaited everywhere; added optional message-match. | Suite. |
| `reduce()` still exported | `reducer.ts` deleted; the fold lives in `cat_reduce` (plpgsql). | Repo. |
| Missing `.dockerignore` | Added (excludes host `node_modules`, `.pgdata`, `.git`). | Repo. |
| `HANDOFF_FOR_REVIEW.md` stale (14-test impl) | Rewritten to the DB-authority design + 21 tests. | Repo. |
| README lacked Docker Compose commands | Added "Against your own PostgreSQL 16 (or Docker Compose)". | Repo. |

Accepted: the logical-vs-physical erasure reframing stands; crypto-shredding remains the
first Phase 2 design task.

---

# Third-pass remediation (Codex review #3)

The fresh install was accepted; the remaining blockers were all about the **upgrade path**
plus a log leak. Suite is now **23 passed, 0 failed**.

| Finding | Fix | Proof |
|---------|-----|-------|
| Upgrade reopens the prune bypass: applying the old schema then the current migration left `prune_expired_behavioral()` installed and app-callable | Migration now `DROP FUNCTION IF EXISTS prune_expired_behavioral(timestamptz)` (and the legacy trigger fn). | Test 23 applies the real legacy schema (git `7503e7f`) then the current migration and asserts the function is gone (`/does not exist/`). |
| Rejected identity leaks into PostgreSQL logs via interpolated error messages (`no-leak: "Top Secret Movie" is not an allowed ref type`) | All error messages — plpgsql and TS — are generic and value-free; no rejected value, key, or event type is interpolated. | Test 22 asserts the error strings (DB ref-type, DB unknown-type, TS gate) never contain the rejected value. |
| `CREATE TABLE IF NOT EXISTS` doesn't add the UUID checks on upgrade (upgraded DB accepted `items.id='Top Secret Movie'`) | UUID checks moved out of `CREATE TABLE` into **idempotent named constraints** added via `DO`/`ALTER TABLE ADD CONSTRAINT` — applied on both fresh installs and upgrades. | Test 23 asserts the upgraded table rejects a non-UUID id. |
| README missing exact compose commands | Added `docker compose logs -f`, `docker compose down` (+ `-v`), and `docker compose run --rm app npm test`. | README. |

Note on parameter logging: rejected values now never appear in our messages. Identity is
still passed to the DB as bind parameters (e.g. a real title on `addItem`); PostgreSQL does
not log bind parameters on error by default (`log_parameter_max_length_on_error = 0`).
Hardening that GUC in deployment is noted for Phase 2.
