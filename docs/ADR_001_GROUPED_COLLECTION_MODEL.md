# ADR 001 — the grouped collection model

**Status:** accepted (Phase 269)
**Context:** Phases 266–268 shipped a Jellyfin control plane whose durable unit of external work was the
`publish_ledger` row — one row per `(item_id, target)`. Phases 269–272 had to make one accepted operator plan
mean one Jellyfin collection.

This repository records design in `docs/PHASE_*.md`. Those documents say what the product does and why. This
one exists because Phase 269 turned on a choice between four options that all *work*, and a reader six months
from now deserves to see the three that were rejected rather than infer them from the one that shipped.
`docs/PHASE_269_272_COLLECTION_LIFECYCLE.md` remains the description of what was built.

## Decision

Introduce **`managed_collections`** and **`managed_collection_members`** (schema v9) as a new durable model
beside `publish_ledger`, keyed by a **derived** `collection_key = sha256(target ‖ name)`. Leave every v8 row
exactly as it is.

## The options, and why the others were rejected

### 1. Overload `publish_ledger.item_id` with a group identity

Write one ledger row per *collection* and put a synthetic group id in `item_id`.

Rejected. `item_id` is CHECKed as a record uuid, and `cat_publish_reconcile_forgotten` joins it to `items` —
that join is how `forget` drives revocation without `forget` itself being modified, and it is the oldest
external-safety guarantee in the system. A synthetic id would either fail the CHECK or silently never match the
join, which would make a forgotten record's external copy stop being queued for removal. Widening the CHECK to
admit both kinds of id would mean the revocation driver has to *tell them apart*, correctly, forever.

### 2. Add a nullable `group_id` column to `publish_ledger`

Keep one row per record, and let rows sharing a `group_id` be one collection.

Rejected. The active-uniqueness invariant `publish_ledger_active_item_target_uk` is on `(item_id, target)` —
it is what stops two independently confirmed executes from creating two external copies, and Phase 268's
review remediation added it deliberately. A record belonging to two collections would need two active rows for
one `(item_id, target)` pair, so the invariant would have to become `(item_id, target, group_id)`, which
permits exactly the duplicate the original invariant exists to prevent. Trading a proved rule for a feature is
the wrong direction.

### 3. Migrate the v8 per-record rows into the new model

Read each existing per-record collection as a one-member managed collection.

Rejected. Those artifacts were created by a different mechanism, are named after their record rather than after
an operator's label, and carry their own tokens. Adopting them would mean this model claims to manage artifacts
whose shape it did not choose — and the first reconcile would then "correct" their names and membership on
somebody's live media server, because that is what a managed collection means. Silently adopting an artifact a
model did not create is the same class of mistake the `[cat:<token>]` marker rules exist to prevent. They are
therefore **reported** everywhere they matter and driven by the unchanged Phase 12 engine.

### 4. (Chosen) A new model beside the ledger

The group gets its own row, its own lifecycle, its own token, its own recovery proof and its own uniqueness
invariant — mirroring the ledger's rather than sharing it. The ledger goes on meaning exactly what it has always
meant. Both engines run on every reconcile and revoke pass, and both results are reported separately.

## The two sub-decisions that carry the most weight

**The key is derived from the name, not random.** `collectionKeyFor(target, name)` makes "the collection I made
last week" addressable from the one thing an operator actually remembers, which is what turns re-planning into
an *update* instead of a second collection with the same name. The cost is that renaming in this product's form
addresses a different collection — documented as a limitation, and preferable to a random id nobody can name.

**Membership stores the catalog record id and never the Jellyfin item id.** Storing the matched library ids
would have been the easy implementation, and it would have *survived crypto-shredding*: after a `forget` the
record's identity is unrecoverable, but a stored external id would still say exactly which library items came
from it. So the reconciler resolves ids afresh each pass through `withPublishableIdentity`, and removal is a set
difference — a forgotten member falls out of the intended set and its items are taken back out without this
product ever having recorded what they were.

That choice forces the safety rule that follows from it: because the intended set is *computed* rather than
stored, a pass that could not compute it fully must not treat the smaller set as the truth. Hence
`findItemsByRefsChecked` / `listCollectionItemIdsChecked`, and **no removal is ever computed from partial
knowledge**.

## Consequences

* Two durable models coexist. That is more surface, and it is why `status`, the planner and the drift audit all
  report them separately rather than summing them into one number an operator would misread.
* `MIGRATION_VERSION` is 9. The migration is additive and idempotent; there are no down-migrations, and the
  supported rollback is the pre-upgrade backup (Phase 6).
* A managed collection is owned by its plan: items added by hand in Jellyfin are drift and are removed. That is
  the price of making `forget` work by set difference, and it is stated in the phase document's Limitations.
