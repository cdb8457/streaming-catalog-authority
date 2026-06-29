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
