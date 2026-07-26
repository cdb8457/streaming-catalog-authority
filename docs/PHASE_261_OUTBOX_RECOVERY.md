# Phase 261 — the outbox could not prove its own recovery worked

## User-visible outcome

`npm test` passes. It has not since the aggregate command became runnable in Phase 258, which found
`test/jellyfin-outbox.ts` failing its hard case and — correctly — refused to guess at a fix.

Behind that: publishing to a real Jellyfin can no longer respond to one lost network response by creating a
second collection. It could before, and nothing in the system could tell.

## What was actually wrong

Phase 258 reported the failure as *"a genuine defect in the Phase 12 outbox reconcile-by-token path"*. That
was the right call from where it stood, and it was half the story. Reproducing it first, before changing any
code, is what separated the two halves.

### The surface cause: a test double that stopped speaking the product's language

The outbox writes an opaque correlation token into the collection's NAME as `[cat:<token>]`, and recovers a
lost create by finding the collection with that marker. Phase 222 (`67f08c2`, *"Fix Jellyfin collection write
request mapping"*) corrected the create request to Jellyfin's OpenAPI parameter spelling — `Name` → `name`,
`Ids` → `ids` — and updated `test/jellyfin-http.ts`, which pins that spelling to this day.

It did not update the fake Jellyfin inside `test/jellyfin-outbox.ts`, which had its own copy of a server
model and went on reading `Name`, defaulting the miss to `''`:

```ts
this.collections.set(id, u.searchParams.get('Name') ?? '');   // reads a key the product no longer sends
```

So every collection that double stored was **nameless**. The marker was silently discarded. `findByToken`
searched for `[cat:<token>]` in a set of empty strings and returned `null` — for a collection that plainly
existed. That is the assertion Phase 258 saw fail, and it failed for eighteen phases because the aggregate
that would have run it could not run at all.

Proved before touching anything, by driving the real client against the real mapping:

```
CREATE query keys: name,ids
  Name (capital) = null
  name (lower)   = "Title [cat:tok-1]"
stored collection names: [""]
findCollectionByToken("tok-1") -> null
```

The assertion was right. The fake server was wrong. Fixing the fake server is not fixing the test: the
assertion is untouched, and the double now **refuses** the PascalCase spelling with a 400 instead of
defaulting it away. It also moved to `test/jellyfin-fake-server.ts`, so there is **one** model of Jellyfin
that every suite shares. Two independent models of one server is the defect; one model is the repair.

### The real defect underneath: `null` was never proof of absence

The drift was survivable. What it exposed was not.

`reconcile()` reads `findByToken() === null` as **proof the artifact does not exist**, and that proof is its
licence to create the artifact again. The inference is sound only while a token written at create time can be
read back at recovery time — and **nothing in the product ever checked that**. Both halves of the round trip
lived in `mapping.ts`, uncoupled, with no verification anywhere.

So when the two halves disagreed — for any reason: a server that ignores the parameter carrying the marker, a
name it normalises, a mapping corrected on one side only — every lost create response became a **duplicate
external collection plus an untracked original**. That is precisely, exactly, the outcome the outbox exists to
make impossible. It was silent, and it was unbounded: each reconcile pass made another one.

Reproduced against the pre-fix tree (`aa0c553`), with a fake target that keeps its artifacts but drops their
markers:

```
  PASS  A: reconcile did not create a duplicate (created=0)
  FAIL  A: no new external artifact (2 -> 3)          <-- a third collection, reported as "stuck"
  FAIL  B: no adoption claimed for a row that did not transition (adopted=1)
```

Note the shape of A: the run reported `created=0` and `stuck=1` *while creating a third collection*. An
operator reading that output would have had no way to know.

## What changed

### 1. Every create proves it is recoverable

`OutboxService` now verifies, once per create, that the artifact it just made is findable by its own token,
and classifies the result:

| proof | what it means |
| --- | --- |
| `verified` | the token finds exactly what we created. Recovery works. |
| `unrecoverable` | the create returned a handle, but the token finds nothing. The marker did not survive. |
| `contradictory` | the token finds a **different** artifact than the one we created. |
| `unknown` | the create failed, or the verifying lookup itself failed. Nothing was learned. |

A created artifact is always settled with its handle, even when the proof is bad — we hold the handle, so
recording it keeps the artifact tracked and revocable. Discarding it would be the orphan.

### 2. Once recovery is known broken, reconcile stops creating

`unrecoverable` and `contradictory` both mean `null` has stopped meaning "absent". `reconcile()` then returns
`stuck` — surfaced for an operator, never a duplicate — rather than creating something it can no longer see.

### 3. The proof is DURABLE, because the publisher is not the reconciler

An in-memory latch would have protected almost nothing: `ops:publish-reconcile` is a separate command in a
separate process from a publish. Migration **v5** adds `publish_ledger.recovery_proof` and
`recovery_proof_at`, written through `cat_publish_record_recovery()` (SECURITY DEFINER, unknown labels
rejected, app cannot write the column directly). `reconcile()` reads the **most recent** proof for the target
before it does anything.

Most-recent, not ever-seen, is deliberate: a target that was broken and has since been proved working again
must not stay quarantined forever, and a target that was working and has just broken must stop being trusted
immediately. A target with no proof at all behaves exactly as it did before this phase, so a fresh install is
unaffected.

That closes the cross-process case: the same reproduction now reads `2 -> 2`.

### 4. Four smaller defects found while reading the path

- **`reconcile` reported adoptions and creations that did not happen.** `settleIntent` returns whether the
  row actually transitioned; both call sites ignored it. A row that left the actionable states underneath a
  reconciler was reported as `adopted`. It is now `stuck`.
- **`markInFlight`'s refusal was ignored too**, so a reconciler could create against a row whose state had
  moved.
- **The intent was not re-checked against the target under the lock.** Target and token are now re-read
  inside the transaction and must still match the row that was listed.
- **A correlation token was unbounded and unvalidated.** A token containing `]` could make `[cat:a]b]` match
  a lookup for `a` — adopting *someone else's* collection. `assertMarkerSafeToken` refuses anything outside
  `[A-Za-z0-9._:-]{1,128}`, at both the create and the match ends, and the outbox refuses an unusable token
  before an intent row is written at all. The UUIDs the outbox actually mints satisfy this trivially; the
  check exists so a caller-supplied token cannot weaken recovery.

## Proof

**The suite that has been failing since Phase 258 now passes**, with its assertions unchanged:

```
$ npx tsx test/jellyfin-outbox.ts 5450
  PASS  real client + outbox — happy publish creates a token-tagged collection -> published
  PASS  real client + outbox — HARD CASE: create tagged, response lost, state discarded -> reconcile ADOPTS by token
  PASS  gate — real outbox target needs ENABLE_NETWORK + ALLOW_LIVE_PUBLISH + config (fail-closed)
3 passed, 0 failed.
```

**`npm run test:phase261-local`** — `test/publish-outbox-recovery.ts`, 21 assertions, all passing, against a
real embedded PostgreSQL 16 and fake in-process adapters only:

- the marker **round trip**: whichever create parameter carries the marker is the value `matchIdByToken`
  finds — written key-agnostically, so it stays true if the parameter is ever renamed again;
- marker **safety**: `tok]en`, `[cat:evil]`, `tok en`, empty and 129-character tokens all refused, and
  `[cat:ab]` proved not to match a lookup for `a`;
- **adoption** through a fake target and through the real `JellyfinHttpClient` over the shared fake server;
- **unrecoverable** and **contradictory** creates reported, latched, and refusing to create;
- the refusal **surviving the process that learned it**, and **healing** when a later create verifies;
- **duplicate token** refused by the database's unique index, with nothing created for the refused intent;
- an **unusable token** refused before any intent row or side effect;
- **bounded retry** ending `failed` with the create budget respected;
- **restart** idempotency across repeated reconciles;
- **two concurrent workers** producing exactly one create, and exactly one adoption;
- an intent for **another target** never touched;
- **stale state**: a row terminalised mid-reconcile is `stuck`, not `adopted`; a token that no longer parses
  never leads to a create;
- **redaction**: the ledger holds no title, ref value or api key; no URL carries the key or a ref value; a
  transport failure names the operation and status only.

**Proved to fail on the pre-fix tree.** The suite itself cannot even load at `aa0c553` (it imports
`assertMarkerSafeToken`, which does not exist there), so the behavioural claim was made separately: a
master-compatible probe using only the pre-fix API reproduces both defects at `aa0c553` (`2 -> 3` external
artifacts; `adopted=1` for a row that did not transition) and passes here.

## Limitations

- **Verification costs one extra lookup per create.** `findCollectionByToken` walks BoxSet pages, so a publish
  against a very large Jellyfin does that walk twice. Publishes are rare and a silent duplicate is expensive;
  the trade is deliberate and stated rather than hidden.
- **A `verified` proof is about the target, not about a specific artifact.** If token recovery works in
  general but one particular collection is renamed out from under the marker by hand, reconcile will still
  read `null` as absence for that intent. Nothing short of a server-side immutable tag can close that, and
  Jellyfin does not offer one.
- **The quarantine is per-target and coarse.** One unrecoverable create stops reconcile from creating for
  *every* intent on that target until a later create verifies. That is the fail-closed direction, and it is
  loud, but an operator with one broken record and fifty healthy ones has to fix the broken one first.
- **`recovery_proof` needs migration v5.** An existing deployment must run `ops:migrate` (the shipped stack
  does this automatically on `up`); until it does, `ops:doctor` reports the version mismatch, which is the
  designed behaviour and not new to this phase.
- **The marker is still a name substring.** It is bounded and delimiter-safe now, but a server that truncates
  long collection names could still cut it off. Nothing here detects truncation before the fact — the create
  verification detects it *after*, which is the point.
- **No live Jellyfin was contacted.** Everything above is fake adapters and an embedded PostgreSQL. The
  mapping remains PROVISIONAL and smoke-gated, exactly as it was.

## Next work

`ops:doctor` surfaces stuck intents but says nothing about *why* they are stuck. Reading the latest
`recovery_proof` per target and reporting "recovery-by-token is broken for jellyfin; reconcile will not
create" would turn the fail-closed refusal from a silent `stuck` count into an actionable line.
