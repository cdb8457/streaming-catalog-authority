# Phase 2 — Crypto-Shredding Design (v2, post-review)

**Status:** design, revised after the first review (direction approved, contracts required
before code). v1 established the approach; v2 adds the explicit contracts: production key
custodian, shred state machine, race/failure recovery, ciphertext envelope, durable
key-control across rebuild, and a precise statement of what changes in Phase 1.

Phase 1 gives *logical* erasure (forget nulls projection identity; the event log is opaque)
but leaves physical residue (dead tuples, WAL, replicas, backups). Crypto-shredding makes
identity recoverable only via a **per-item key**, and `forget` **irreversibly destroys that
key** — after which every surviving copy of the ciphertext is permanently undecryptable.

---

## 1. Threat model

Real erasure must defeat (Phase 1 did not):

| Residue | Crypto-shred outcome |
|---|---|
| Dead tuples (pre-UPDATE versions) | hold only ciphertext; key destroyed |
| WAL / archived WAL | records only ciphertext writes |
| Streaming / physical replicas | replay only ciphertext |
| Base backups / PITR | hold only ciphertext; **contain no DEK** |
| Server logs (statements/params) | identity travels as ciphertext; plaintext never leaves the app* |

\* *plaintext does exist transiently inside the application before encryption — see §10, why
log redaction ships with/ahead of this work.*

**"Every backup" means every MAIN-DB backup contains no usable DEK, AND the key custodian
retains no recoverable copy of a destroyed DEK** (no soft-delete, no versioning, no PITR, no
separate snapshot of the wrapped-key store). If any recoverable keystore snapshot holds the
wrapped DEK, shredding is defeated. This is a hard requirement on the custodian (§2).

Non-goals: retroactive secrecy against an attacker who already exfiltrated plaintext or the
live key. Crypto-shred guarantees *future* irrecoverability after destruction is confirmed.

---

## 2. Key hierarchy + production custodian (revision #1)

```
KEK (versioned, in KMS)          -- wraps DEKs; rotation = re-wrap, never re-encrypt identity
   └─ per-item DEK, identified by an immutable key_id with a monotonic epoch
         └─ AES-256-GCM over identity fields + each provider ref value
```

A KMS KEK does **not** durably store wrapped DEKs by itself. Production uses an explicit
**key custodian** with this contract:

```
provision(item_id) -> { key_id, epoch, dek }      // mint a new DEK generation, durably store wrapped
get(key_id, epoch) -> dek                          // unwrap for read/encrypt (denied once destroyed)
destroyAll(key_id) -> void                         // IRREVERSIBLY delete ALL epochs for key_id, idempotent
```

Two production realizations were considered:

- **C1 — custodian service storing wrapped DEKs (CHOSEN).** An external service durably
  stores `(key_id, epoch) → wrapped_dek` and supports irreversible deletion of all
  generations for a `key_id`. Requirement: its backing store has **no soft-delete, no object
  versioning, no PITR, no independent backup** of the wrapped-key material — destruction is
  final. Main-DB backups never contain DEKs.
- **C2 — one KMS-managed key per item.** Identity encrypted via a per-item KMS CMK; shred =
  schedule CMK deletion. Rejected for Phase 2: per-item CMK cost/quota limits and slower
  hot-path, though its deletion guarantee is attractive. Documented as an alternative.

**Decision (O2): C1.** Dev/test use an in-process custodian implementing the same contract
(and fault injection); production uses a real adapter (§7, §10) — the in-process one may
prove protocol logic but not the production deletion guarantee.

**KEK rotation (O5): implement versioned re-wrapping now**, defer rotation *cadence*. The
custodian records `kek_version` per wrapped DEK; a rewrap operation re-wraps DEKs under a new
KEK version without touching ciphertext. Rotation policy/scheduling is a later phase.

---

## 3. Ciphertext envelope (revision #5)

- **AES-256-GCM**, a **fresh random 96-bit nonce for every encryption** (never reused under a key).
- Serialized envelope: `version ‖ nonce(12B) ‖ ciphertext ‖ tag(16B)`.
- **AAD = item_id ‖ key_epoch ‖ schema_version ‖ field_or_ref_type.** Binds each ciphertext
  to its exact slot, generation, and schema, so it cannot be swapped between fields, refs,
  items, or epochs.
- **Layout (O1): a single identity blob for `items`** (title/year/external_ids/metadata
  encrypted together) **plus a separately encrypted blob per `provider_refs.ref_value`**
  (AAD field = `ref:<ref_type>`). Smaller shape/attack surface than per-column.

Required envelope tests: bit-flip tamper → auth-tag failure; cross-field/cross-item/
cross-epoch **swap** → AAD failure; **nonce-uniqueness** (two encryptions of identical
plaintext differ; statistical nonce-collision guard); wrong-`schema_version` → AAD failure.

---

## 4. Key-control state must survive rebuild (revision #6)

Key lifecycle is **not** part of the rebuildable projection. A dedicated table holds it and
is **never touched by `rebuildProjection`**:

```
item_key_control (
  item_id      TEXT PRIMARY KEY,          -- opaque uuid; NO FK to items (decoupled from rebuild)
  key_id       TEXT NOT NULL,             -- immutable per identity lineage
  cur_epoch    INT  NOT NULL,             -- monotonic; bumped on each (re)provision
  kek_version  INT  NOT NULL,
  shred_state  TEXT NOT NULL CHECK (shred_state IN ('active','shred_pending','shred_complete')),
  shred_epoch  INT,                        -- the epoch recorded at forget time (the high-water generation to destroy)
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

- The **identity ciphertext stays in `items`** (rebuildable). `rebuildProjection` clears it
  (as Phase 1 clears identity today); re-hydration re-encrypts under the existing
  `key_id`/`cur_epoch` from `item_key_control`.
- On rebuild, **keys are REUSED, not retired**: `item_key_control` is untouched, so a rebuild
  cannot orphan or resurrect key-control. Any drift is caught by the reconciler (§6, §7).
- `item_key_control` has **no FK to `items`** precisely because Phase 1 rebuild does
  `DELETE FROM items`; an FK would either break rebuild or cascade-destroy key-control.
  Consistency between `items.forgotten` (derived from the durable `ItemForgotten` event) and
  `item_key_control.shred_state` is maintained by the forget coordinator (§5) and verified by
  the reconciler.

---

## 5. The shred state machine (revisions #2, #7)

```
active ──forget──▶ shred_pending ──destroy confirmed──▶ shred_complete
                       │  (reads deny identity from here on)
                       └─ reconciler retries destruction until confirmed
```

`forget(item_id)` (the **forget coordinator**, replacing Phase 1's single `cat_forget` call):

1. **DB transaction** (one atomic step, under the existing per-item lock):
   append the opaque `ItemForgotten` event; clear the `items` identity ciphertext; set
   `item_key_control.shred_state='shred_pending'` recording the exact `key_id` and
   `shred_epoch = cur_epoch`.
2. From this point **reads deny identity immediately** (pending or complete ⇒ identity gone).
3. **Destroy** that exact key lineage in the custodian: `destroyAll(key_id)` — idempotent,
   covering **every epoch ≤ shred_epoch**, not just the current one (§6).
4. **Only after the custodian confirms irreversible deletion**, set
   `shred_state='shred_complete'`.
5. **`forget()` returns `shred_pending`** (or, in a `forgetAndWait` variant, blocks until
   `shred_complete`). **It never claims cryptographic erasure until step 4 confirms.** A
   `pending` result is an explicit, surfaced state, not a silent partial failure.
6. A **reconciler** periodically retries `destroyAll` for any `shred_pending` row and promotes
   it to `shred_complete` on confirmation.

This directly answers the review's central correction: "DB forgotten, then eventually delete
key" is acceptable *only* as a named `pending` state that denies reads and withholds the
erasure claim until deletion is confirmed.

---

## 6. Generation & restore race prevention (revision #3)

- **Immutable `key_id` + monotonic `epoch`.** A destroy targets a `key_id` and destroys all
  generations up to `shred_epoch`; it can never delete a *newer* key created after the forget
  decision, because a new identity lineage gets a **new `key_id`**, not a reused one.
- **Destroy every historical DEK generation** for the lineage (old ciphertext in backups was
  encrypted under older epochs), via `destroyAll(key_id)`.
- **Re-supply is blocked until `shred_complete`.** `restore` cannot provision identity while
  `shred_pending`; once complete, it starts a **fresh `key_id`** (new lineage, epoch 0). A
  delayed in-flight destroy therefore can never collide with the new key.

---

## 7. Add/write & provisioning failure recovery (revision #4)

Provision-first, commit-second, with orphan cleanup:

1. `provision(item_id)` mints `(key_id, epoch, dek)` and writes a **provisioning-intent**
   record (durable) before any DB identity write.
2. Encrypt identity (AAD-bound).
3. **DB transaction** commits the ciphertext + `item_key_control` (key_id/epoch/kek_version)
   using **optimistic versioning** (e.g. expected `cur_epoch`), then marks the provisioning
   intent committed.
4. **If the DB write fails**, `destroyAll` the orphan key generation.
5. A **reconciler** sweeps provisioning-intent records with no committed DB reference (abandoned
   provisioning) and destroys those orphan keys; it also reconciles `shred_pending` rows (§5)
   and any `items.forgotten` ↔ `shred_state` drift (§4).

---

## 8. Lifecycle interactions (summary)

- **addItem / restore (identity write):** provision (or, for restore after complete, a fresh
  lineage) → encrypt → DB commit ciphertext + key-control → confirm provisioning. Restore is
  **operational + re-supply**; identity from before a completed shred is unrecoverable.
- **read identity:** denied if `shred_state ≠ active`; else fetch ciphertext, `get` DEK,
  decrypt.
- **forget:** the state machine of §5.
- **rebuildProjection:** clears `items` (incl. identity ciphertext), refolds the opaque log,
  leaves `item_key_control` untouched; identity re-hydrated later under the existing epoch;
  forgotten items stay identity-less and their keys remain destroyed.

---

## 9. What changes in Phase 1 (revision #7 — corrected)

Event-sourcing **invariants are unchanged**: opaque append-only log, `apply` as the sole
mutator, lifecycle transitions in the apply path, advisory-lock coordination, least-privilege
`app` role, `pg_temp`-shadowing hardening, and the no-leak gate on event payloads.

But these Phase 1 artifacts **do change** (v1 wrongly implied "no core change"):
- **Schema:** identity columns become ciphertext (`BYTEA` blob); new `item_key_control` table.
- **Authority functions:** `cat_add_item` / `cat_restore` take **ciphertext** (not plaintext)
  and write key-control; `cat_forget` becomes the multi-step **forget coordinator** (DB step +
  external destroy + completion), not a single call.
- **Restore contract:** operational-only + identity re-supply; cannot recover shredded identity.
- **Rebuild behavior:** must preserve `item_key_control` (reuse keys; never delete key-control).

---

## 10. Sequencing within Phase 2 (revised)

1. **SecretStore + log redaction TOGETHER (same release gate).** Plaintext identity exists in
   the app *before* encryption, so log redaction (route app logging through the existing
   `assertNoLeak` scanner) must land with — or ahead of — encryption, not after. *(This moves
   log redaction earlier than v1.)*
2. **Crypto-shredding:** custodian interface + in-process dev custodian, envelope, key-control,
   forget coordinator + reconciler.
3. **Production custodian adapter + integration suite** — required before claiming production
   shredding (O4); the in-process custodian only proves protocol logic.
4. **Backup policy:** encrypted main-DB backups that **exclude** any DEK/keystore material, and
   a restore that resurrects **neither** expired behavioral events **nor** shredded identity.

---

## 11. Testing strategy

- **Envelope:** tamper / swap (field, ref, item, epoch) / nonce-uniqueness / schema_version (§3).
- **Shred irrecoverability:** capture raw ciphertext → forget → confirm undecryptable even
  with the KEK (DEK destroyed across all epochs).
- **Backup cannot resurrect:** reload pre-forget ciphertext (simulated old backup) → assert
  unrecoverable without the destroyed DEK.
- **State machine & crashes:** fault-inject the dev custodian (destroy fails/partials) →
  assert `shred_pending`, reads denied, `forget()` does not claim erasure, reconciler completes.
- **Races:** restore blocked while pending; post-complete restore uses a fresh `key_id`; a
  delayed destroy never deletes the new key.
- **Provisioning failure:** DB-commit failure leaves no decryptable identity and no orphan key
  after reconciliation.
- **Rebuild preserves key-control:** rebuild clears ciphertext but not `item_key_control`;
  re-hydration reuses the epoch; forgotten stays shredded.
- **DB never sees plaintext:** scan events, projection, captured statement/param log for known
  plaintext — absent.
- **Per-item isolation:** shredding A leaves B decryptable.
- **KEK rewrap:** versioned re-wrap changes no ciphertext; old KEK version retired.
- **Production-adapter integration suite** gates any "production shredding" claim (O4).
- All 24 Phase 1 invariants carried forward unchanged.

---

## 12. Decisions recorded

- **O1:** single `items` identity blob + separately encrypted provider refs. ✓
- **O2:** external custodian (C1); in-process dev custodian for tests. ✓
- **O4:** in-memory fault-injecting custodian proves protocol; **a real production-adapter
  integration suite is required before claiming production shredding.** ✓
- **O5:** implement versioned KEK re-wrapping now; defer rotation cadence. ✓
- **Sequencing:** log redaction moves to the same gate as encryption. ✓

## 13. Remaining questions for the next review

- Confirm C1's custodian contract (`provision`/`get`/`destroyAll`) and its storage
  requirements (no soft-delete/versioning/PITR/backup) are sufficient and complete.
- Confirm the `forget` coordinator's DB-first / destroy / complete ordering is the safest
  crash-consistent protocol, and that `destroyAll(key_id)` over all epochs ≤ `shred_epoch`
  is the right destruction scope.
- Confirm decoupling `item_key_control` from `items` (no FK) is preferable to reworking
  rebuild to preserve rows.
