# Phase 1 Catalog Authority — Review Handoff

You are being asked for a **second opinion**. A "Phase 1 — Catalog Authority Slice" was
just built from scratch and all 14 of its tests pass against a real PostgreSQL 16. Before
it is locked as the baseline for later phases, I want an independent, skeptical read:
**is the design sound, is the proof real, and what would you do differently?**

You do not have the repo. Everything needed to reason about it is below, including the
load-bearing code. Please be adversarial — assume the tests can be green while the design
is subtly wrong, and look for that.

---

## 1. Context (what this slice is)

This is the foundational core of a streaming/catalog engine. The whole architecture is
event-sourced and built around one rule: **content identity (titles, external IDs,
infohash values, magnets, URLs, provider keys) must never end up in the durable event
log, logs, or backups** — only in a mutable projection that can be wiped/rebuilt, so a
"forget" is real and a leak is structurally impossible.

Phase 1 builds *only* the catalog authority core. Deliberately **excluded**: provider
adapters (even mock), Plex/Jellyfin/RealDebrid/TorBox, Hermes (an external control
plane), HTTP, job queues, UI. The isolation is the point.

Stack: TypeScript (ESM, `tsx`/`tsc`), PostgreSQL 16, `pg`. Tests boot an **embedded**
PostgreSQL 16 (the `embedded-postgres` npm package) on `localhost:5433` — no Docker — and
the pool reads `DATABASE_URL`, so it runs against any real PG16 in production. PG16 was
chosen because the concurrency guarantees rely on genuine advisory locks, sequences, and
triggers; an in-memory fake could not prove them.

The inherited design constraints (from a prior PRD/ADR set I was handed):
- **ADR-4**: events split into `structural` (permanent) and `behavioral` (TTL'd, prunable).
- **ADR-6**: events are separate from commands. The single mutator takes an **event**,
  not a command; commands are handlers that *author* events.

---

## 2. The non-negotiable boundaries (the contract this slice must honor)

1. `CatalogAuthority` is the ONLY writer of `items` / `provider_refs`.
2. `apply(event)` is the single event-sourced mutator. Commands route through it.
3. Events are opaque: no title, external_ids, infohash value, magnet, URL, tracker, or
   key in any payload. A no-leak gate runs before every insert.
4. Identity lives only in the mutable projection; a rebuild restores operational state
   only and leaves identity NULL until a later phase re-hydrates it.
5. Append-only log, folded by `seq`; per-item advisory lock.
6. The catalog core imports nothing about providers/HTTP/adapters/Hermes.

Two of these are enforced by **static source-scan tests**, not just convention.

---

## 3. The schema (the load-bearing parts)

```sql
CREATE TABLE events (
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('structural','behavioral')),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ           -- NULL for structural; set for behavioral TTL
);

CREATE TABLE items (
  id               TEXT PRIMARY KEY,
  present          BOOLEAN NOT NULL DEFAULT false,   -- operational (from fold)
  forgotten        BOOLEAN NOT NULL DEFAULT false,   -- operational
  behavioral_score INTEGER NOT NULL DEFAULT 0,       -- operational
  last_seq         BIGINT  NOT NULL DEFAULT 0,       -- operational
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  title            TEXT,    year INTEGER,            -- identity (NULL after rebuild)
  external_ids     JSONB,   metadata JSONB           -- identity (NULL after rebuild)
);

CREATE TABLE provider_refs (
  item_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  ref_type  TEXT NOT NULL,            -- operational label, e.g. 'infohash', 'tmdb'
  present   BOOLEAN NOT NULL DEFAULT true,
  ref_value TEXT,                     -- identity/secret (NULL after rebuild)
  PRIMARY KEY (item_id, ref_type)
);

-- Append-only guard: UPDATE never; DELETE only for an EXPIRED BEHAVIORAL event.
CREATE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'events are append-only: UPDATE is forbidden';
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'behavioral' AND OLD.expires_at IS NOT NULL AND OLD.expires_at <= now()
      THEN RETURN OLD;
    END IF;
    RAISE EXCEPTION 'events are append-only: DELETE is forbidden (except expired behavioral)';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER events_append_only_trg BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
```

---

## 4. The single mutation path (the heart of it)

Every mutation runs through one advisory-locked, single transaction. Identity is written
to the projection **in the same transaction** as the event, but **never** into the event.

```ts
// the ONLY event-sourced mutator
async apply(event: CatalogEvent): Promise<number> {
  return this.withItemTxn(event.itemId, (c) => this.applyInTxn(c, event));
}

private async applyInTxn(client, event): Promise<number> {
  assertNoLeak(event.payload);                          // gate BEFORE persistence
  const res = await client.query(
    `INSERT INTO events (item_id, kind, type, payload, expires_at)
     VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING seq`,
    [event.itemId, event.kind, event.type, JSON.stringify(event.payload), event.expiresAt]);
  const seq = Number(res.rows[0].seq);
  await reduce(client, { ...event, seq });               // operational projection only
  return seq;
}

private async withItemTxn(itemId, fn) {
  const client = await this.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [itemId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

// command handler: authors opaque events, writes identity in the SAME txn, off-event
async addItem(itemId, identity = {}) {
  return this.withItemTxn(itemId, async (client) => {
    const seq = await this.applyInTxn(client, events.itemAdded(itemId));
    for (const ref of identity.providerRefs ?? [])
      await this.applyInTxn(client, events.providerRefAttached(itemId, ref.type)); // payload {op: ref.type}
    await client.query(
      `UPDATE items SET title=$2, year=$3, external_ids=$4::jsonb, metadata=$5::jsonb WHERE id=$1`,
      [itemId, identity.title ?? null, identity.year ?? null,
       identity.externalIds ? JSON.stringify(identity.externalIds) : null,
       identity.metadata ? JSON.stringify(identity.metadata) : null]);
    for (const ref of identity.providerRefs ?? [])
      await client.query(`UPDATE provider_refs SET ref_value=$3 WHERE item_id=$1 AND ref_type=$2`,
        [itemId, ref.type, ref.value]);
    return seq;
  });
}
```

`rebuildProjection()` takes a global advisory lock, `DELETE FROM items` (cascades to
`provider_refs`), then re-folds all events by `seq` through `reduce`. Because `reduce`
never writes identity, the rebuilt projection has identity = NULL by construction.
`forget(id)` applies an opaque `ItemForgotten` event; the reducer nulls all identity
columns and the provider ref value and flips `present=false, forgotten=true`.

---

## 5. The no-leak gate

Two layers, both enforcing identity **by structure**, not by guessing meaning:

```ts
const ALLOWED_PAYLOAD_KEYS = new Set(['op', 'weight']);  // payload may contain ONLY these
const SIGNATURES = [ /https?:\/\//i, /magnet:\?/i, /\burn:/i, /\bxt=/i,
  /\b[a-f0-9]{40}\b/i /*sha1/infohash*/, /\b[a-f0-9]{64}\b/i /*sha256*/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ /*jwt*/, /\b[sprk]k_[A-Za-z0-9]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i ];
// recurse payload: reject any key not in the allowlist; reject any string value
// matching a signature. Numbers/booleans pass.
```

Design note: an earlier version word-scanned for `infohash` and false-positived on the
legitimate operational **label** `ref_type = "infohash"`. The fix: the label is a normal
string value with no signature, so it passes; the infohash **value** can never reach a
payload (it is written to `provider_refs.ref_value`, off-event), so it is blocked
structurally. There is a regression test that asserts `{op:'infohash'}` is accepted.

---

## 6. Test results (14/14 green vs PostgreSQL 16.14)

1. Mutation boundary — static scan: only `reducer.ts`/`authority.ts` contain write SQL to `items|provider_refs`.
2. Catalog-core import scan — no provider/HTTP/adapter/Hermes imports.
3. No-leak gate rejects a forbidden identity key.
4. No-leak gate rejects secret/identity signatures (magnet, URL, 40-hex, bearer).
5. No-leak gate **regression**: accepts the operational label `infohash`.
6–8. Same-item concurrency ×2 / ×20 / ×100: serialized, all returned `seq` distinct,
     `behavioral_score == N` (no lost updates), one behavioral event per signal.
9. First-add race: 20 concurrent `addItem` on a brand-new id → 20 `ItemAdded` events,
   exactly one present row, no error.
10. Different-item parallelism: 100 parallel adds, no deadlock (~33ms).
11. Rollback atomicity: forcing the reducer to throw persists neither event nor projection.
12. Deterministic rebuild: two rebuilds byte-identical; all identity columns NULL after.
13. Forget: all identity nulled, `forgotten` set; every event payload passes the gate and
    contains neither the title nor the infohash value.
14. Behavioral TTL prune: expired behavioral events pruned, structural untouched; the
    trigger rejects both an `UPDATE` and a structural `DELETE`.

Run: `npm install && npm run ci` → typecheck, then `14 passed, 0 failed.`

---

## 7. Decisions I made (please challenge these)

- **`apply(event)` not `apply(command)`** (ADR-6). Commands write identity in the same txn
  as the event but keep it out of the event. Is this the right seam?
- **No-leak gate = key-allowlist + signature scan**, not denylist/word-scan. Allowlist is
  currently just `{op, weight}`. Too strict? Too loose? Will it scale to real payloads?
- **Append-only enforced by trigger**, with a single carve-out: DELETE of an *expired
  behavioral* event. Is using `now()` inside the trigger predicate a problem (e.g. a row
  that is expired at prune time but the projection still counts it until a rebuild)?
- **`behavioral_score` is incremented by the reducer** and only corrected on rebuild after
  a prune — i.e. between prune and rebuild the score can overcount expired signals. Is
  that acceptable for an operational projection, or should prune adjust the projection?
- **`rebuildProjection` uses one global advisory lock and `DELETE FROM items`** rather than
  per-item locks. Fine for a maintenance op, or a foot-gun under live writes?
- **Embedded PostgreSQL 16 for tests** instead of Docker (the target machine has neither
  Docker nor a system Postgres). Production still uses `DATABASE_URL`.

## 8. What I want from you

1. **Correctness holes**: any scenario where an event/projection can diverge, an identity
   value can leak into `events`/payloads/logs, or a "forget" leaves a trace.
2. **Concurrency**: is the per-item `pg_advisory_xact_lock(hashtextextended(id,0))` +
   single-txn pattern actually sufficient for the guarantees claimed? Hash-collision risk?
   Lock leaks? Anything the 2/20/100 tests would *not* catch?
3. **The gate**: can you construct a payload that leaks but passes, or a legitimate
   payload that the allowlist would wrongly reject as the schema grows?
4. **Rebuild determinism**: anything that makes two rebuilds differ, or that lets identity
   survive a rebuild.
5. **Whether the boundaries are truly enforced** by the static scans, or gameable.
6. **Phase 2 readiness**: the next slice is privacy hardening — a runtime-only
   `SecretStore`, routing app logs through the same `noleak` scanner, and an
   encrypted-backup/restore policy that must not resurrect expired behavioral events. Does
   anything in Phase 1 need to change first to make that clean?

Be blunt. If a test is theater rather than proof, say so and say why.
