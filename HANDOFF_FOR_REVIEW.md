# Phase 1 Catalog Authority — Review Handoff (round 3)

You reviewed this slice twice and returned "no-go" both times; every finding has since
been addressed. This is a **third-pass review request**: confirm the fixes hold and hunt
for anything still wrong before it is locked as the baseline for Phase 2. Be adversarial —
assume green tests can still hide a broken invariant.

Current state: **typecheck clean, 24/24 tests pass** against embedded PostgreSQL 16.14.
History: round 1 = 14 tests (TS-centric); round 2 = 19 (typed gate, tombstone, locks,
roles); round 3 = 21 (**authority moved into the database**); round 4 = 23 (upgrade-path
migration + value-free error messages); round 5 = 24 (**pg_temp shadowing hardening**).
See `REMEDIATION.md` for the finding-by-finding trail.

---

## 1. What this slice is

Foundational core of a streaming/catalog engine. Event-sourced. One rule above all:
**content identity (titles, external ids, infohash values, magnets, urls, keys) must never
reach the durable event log, logs, or backups** — only a mutable projection that can be
wiped/rebuilt, so "forget" is real and a leak is structurally impossible.

Excluded by design: provider adapters (even mock), Plex/Jellyfin/RD/TorBox, Hermes, HTTP,
job queues, UI. ADR-4 = structural vs behavioral (TTL'd) events. ADR-6 = events ≠ commands.

## 2. The key architectural decision since round 2

**The authority now lives in the database.** Enforcement in TypeScript was bypassable by
anything holding the app connection, so all mutation moved into `SECURITY DEFINER`
functions owned by the migrator role. The runtime `app` role has only `SELECT` on the
tables and `EXECUTE` on the command/maintenance functions. The TS `CatalogAuthority` is a
typed client. This single change closed the round-2 P0s about the no-leak bypass, the
lifecycle bypass via `apply()`, and the unenforced authority boundary.

## 3. Schema + guards (load-bearing parts)

```sql
events(seq bigint GENERATED ALWAYS AS IDENTITY pk,
       item_id text CHECK (item_id ~ '^[0-9a-f]{8}-...-[0-9a-f]{12}$'),  -- opaque uuid
       kind text CHECK (kind IN ('structural','behavioral')),
       type text, payload jsonb, created_at timestamptz, expires_at timestamptz)
items(id text pk CHECK (uuid)), present, forgotten, behavioral_score, last_seq,
      updated_at, title, year, external_ids, metadata)        -- identity cols NULL after rebuild
provider_refs(item_id fk, ref_type, present, ref_value)        -- ref_value NULL after rebuild

-- append-only: UPDATE never; DELETE only expired behavioral; TRUNCATE blocked
trigger events_append_only_trg  BEFORE UPDATE OR DELETE  -> raise (carve-out: expired behavioral)
trigger events_truncate_guard   BEFORE TRUNCATE          -> raise
```

## 4. The authority surface (all SECURITY DEFINER, owner-owned)

```
cat_apply_internal(item_id,type,payload,expires_at,cutoff)   -- the single mutator:
    assert uuid id; derive+check kind/ttl; cat_validate_payload(type,payload);
    read (present,forgotten); enforce LIFECYCLE TRANSITION; INSERT event; cat_reduce(...)
cat_reduce(seq,item_id,type,payload,expires_at,cutoff)        -- pure projection fold
cat_validate_payload(type,payload)                            -- no-leak gate on the stored jsonb
cat_add_item / cat_restore / cat_forget / cat_record_signal   -- commands (lock + author events)
cat_apply(item_id,type,payload,expires_at)                    -- generic mutator (lock + internal)
cat_rebuild(cutoff) / cat_prune_and_rebuild(cutoff)           -- exclusive-locked maintenance
```

Transitions enforced in `cat_apply_internal` (the apply path, not just commands):
- `ItemAdded`: rejected if forgotten or already present
- `ItemRestored`: requires a forgotten item
- `ProviderRefAttached` / `BehavioralSignal`: require a present item
- `ItemForgotten`: always allowed; `cat_reduce` upserts a tombstone even for an unknown id

Locks: writers `pg_advisory_xact_lock_shared(4242,1)` + per-item
`pg_advisory_xact_lock(hashtextextended(id,0))`; rebuild/prune take the exclusive
`pg_advisory_xact_lock(4242,1)`.

No-leak gate (in `cat_validate_payload`, mirrored client-side): empty payload for
ItemAdded/Forgotten/Restored; ProviderRefAttached must be exactly `{op}` with `op` in a
fixed enum (`infohash,tmdb,imdb,tvdb,tvmaze,anidb`) matching `^[a-z0-9_]{1,32}$`;
BehavioralSignal exactly `{weight}` integer 1..1000. The TS client additionally validates
`JSON.parse(JSON.stringify(payload))` and passes that exact string, so a `toJSON()` cannot
diverge validation from persistence.

## 5. Privileges

```
REVOKE ALL ON events, items, provider_refs FROM app;
GRANT  SELECT ON events, items, provider_refs TO app;
REVOKE ALL ON FUNCTION (every cat_* incl internals) FROM PUBLIC;
GRANT  EXECUTE ON cat_apply, cat_add_item, cat_restore, cat_forget,
                  cat_record_signal, cat_rebuild, cat_prune_and_rebuild TO app;
```
App cannot INSERT events, UPDATE the projection, prune without rebuild, or call the
internal functions directly. There is no bare prune function.

## 6. Tests (21, all green)

boundary scan (no TS table writes) · core import scan · typed gate accept/reject ·
**toJSON bypass defeated** · **opaque-id enforced (TS + DB CHECK)** · envelope validation ·
same-item concurrency 2/20/100 (distinct seq, no lost updates) · idempotent first-add ·
100-parallel no-deadlock · atomic apply (absent-item attach persists nothing) ·
deterministic rebuild · **fresh-DB fold + identity-sequence advance + append-after** ·
**forget terminal (re-add + apply(ItemAdded)-on-forgotten blocked, payloads opaque)** ·
**apply(ItemRestored)-on-non-forgotten rejected** · **forget-unknown-id tombstone** ·
explicit restore · coordinated TTL prune+rebuild · **authority boundary (app raw
insert/projection write/prune all denied)** · append-only trigger layer (owner blocked).

Run: `npm install && npm run ci`.

## 7. What I want from you

1. Any remaining way to get content identity into `events` (payload, `item_id`, or any
   other column), or to make a "forget" leave a recoverable trace.
2. Any path that bypasses the DB authority — a privilege I granted too broadly, a
   `SECURITY DEFINER`/`search_path` issue, a function callable that shouldn't be.
3. Lifecycle holes: a state transition the apply-path guard misses; interleavings under
   the shared/exclusive lock that corrupt the projection or the fold.
4. Rebuild/prune determinism: anything that makes a fold non-reproducible for a fixed
   cutoff, or lets identity survive a rebuild.
5. Concurrency correctness beyond what the 2/20/100 + 100-parallel tests show.
6. Phase 2 readiness: next is privacy hardening — a runtime-only `SecretStore`, routing app
   logs through the existing `assertNoLeak` scanner, and an encrypted backup/restore policy
   that must not resurrect expired behavioral events; crypto-shredding for true erasure is
   the first Phase 2 design task. Does anything in Phase 1 need to change first?

If a test is theater rather than proof, say so and why.
