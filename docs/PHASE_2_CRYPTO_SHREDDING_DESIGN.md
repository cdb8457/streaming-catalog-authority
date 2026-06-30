# Phase 2 — Crypto-Shredding Design (v4, post-review #3)

**Status:** design. v4 adds the final three contracts review #3 required (correct locking /
winner selection, hardened custodian status + idempotent destroy + audit fields, and
unwrapped-DEK lifetime). After v4 sign-off the design is implementation-ready for the
coordinator. v3 completed the protocol contracts review #2 required before the
crypto-shredding **coordinator** is implemented. Review #2 approved: DB-first shred ordering,
`item_key_control` independent of the rebuildable projection, whole-old-lineage destruction,
the no-FK key-control design, the ciphertext envelope, single-blob layout, pending/complete
semantics, restore blocking, and the test strategy. Remaining work (this revision): a fuller
custodian contract with durable destruction receipts, an explicit cross-system provisioning
sequence, old-backup reconciliation, epoch wording, and custodian-authoritative KEK state.

Review #2 also cleared **SecretStore** and **log redaction** to begin now; only the
crypto-shredding coordinator waits on this document.

Phase 1 gives *logical* erasure; crypto-shredding makes identity recoverable only via a
**per-item key** that `forget` **irreversibly destroys**, defeating physical residue (dead
tuples, WAL, replicas, backups).

---

## 1. Threat model

| Residue | Outcome after shred |
|---|---|
| Dead tuples / WAL / archived WAL | ciphertext only; key destroyed |
| Streaming / physical replicas | replay ciphertext only |
| Base backups / PITR | ciphertext only; **no usable DEK in any main-DB backup** |
| Server logs | identity is ciphertext; plaintext exists only transiently in-app (→ log redaction, §10) |

"Every backup" = every main-DB backup holds no usable DEK, **and** the custodian retains no
recoverable copy of a destroyed DEK (no soft-delete, versioning, PITR, or separate backup of
wrapped-key material). What the custodian *does* keep after destruction is a **non-secret
destruction tombstone/receipt** — see §2. Non-goal: retroactive secrecy against an attacker
who already holds plaintext or a live key.

---

## 2. Key custodian contract (revision #1) + KEK authority (revision #5)

The custodian is an external service (prod) / in-process fault-injecting impl (dev, tests).
It owns wrapping and rotation state; PostgreSQL is never authoritative for key material or
KEK version.

```
provision(operation_id, item_id, epoch) -> { key_id, dek }
    // retry-idempotent on operation_id; creates a PROVISIONAL (uncommitted) key generation.
    // Re-calling with the same operation_id returns the same provisional key.
commitProvision(operation_id) -> void
    // idempotent; promotes the provisional generation to ACTIVE (usable by get()).
get(key_id, epoch) -> dek
    // returns the DEK only while the generation is ACTIVE; denied if provisional or destroyed.
destroy(operation_id, key_id) -> destruction_receipt
    // irreversibly deletes ALL wrapped key material for key_id (the whole lineage);
    // IDEMPOTENT ON BOTH operation_id AND key_id (a retry, or a second destroy of an
    // already-destroyed key, returns the same receipt and never errors);
    // leaves a durable NON-SECRET destruction tombstone (receipt id/hash + destroyed_at).
status(key_id) -> 'provisional' | 'active' | 'destroyed' | 'not_found'
    // a definite state. 'destroyed' is tombstone-backed; 'not_found' = never existed.
    // A service/network failure is a SEPARATE THROWN ERROR, never a status value — callers
    // and reconcilers must distinguish "the custodian says X" from "the custodian is down".
listStaleProvisioning() -> [{ operation_id, item_id, key_id, age }]
    // provisional generations never committed — input to the reconciler.
```

**Status is never ambiguous-by-value.** There is no `unknown`; transport/service failure is
an exception. This is what lets the reconciler refuse to act on uncertainty (§7).

**Durability split:** wrapped key *material* is irreversibly deleted on `destroy`; a
**non-secret tombstone** `(key_id, destroyed_at, receipt)` is retained durably. This is what
lets reconciliation and old-backup restoration tell **"destroyed"** apart from **"missing due
to custodian failure."** Tombstones contain no key bytes and are safe to back up.

**KEK state (revision #5):** the custodian owns `kek_version`, wrapping, and re-wrapping.
PostgreSQL stores no authoritative KEK version (it would drift during rotation). Versioned
re-wrapping (O5) is a custodian operation over wrapped DEKs; it never touches ciphertext.

---

## 3. Ciphertext envelope (approved)

- **AES-256-GCM**, fresh random **96-bit nonce per encryption**.
- Envelope: `version ‖ nonce(12B) ‖ ciphertext ‖ tag(16B)`.
- **AAD = item_id ‖ key_epoch ‖ schema_version ‖ field_or_ref_type.**
- **Layout (O1):** one identity blob for `items`; a separate encrypted blob per
  `provider_refs.ref_value` (AAD field `ref:<ref_type>`).
- Tests: tamper, swap (field/ref/item/epoch), nonce-uniqueness, schema_version mismatch.

---

## 4. Key-control state (approved; KEK field removed)

Independent of the rebuildable projection, **no FK to `items`**, never touched by
`rebuildProjection`:

```
item_key_control (
  item_id        TEXT PRIMARY KEY,      -- opaque uuid
  key_id         TEXT NOT NULL,         -- immutable per identity LINEAGE
  cur_epoch      INT  NOT NULL,         -- monotonic; bumped per (re)provision
  operation_id   TEXT NOT NULL,         -- the provisioning op that committed cur_epoch
  shred_state    TEXT NOT NULL CHECK (shred_state IN ('active','shred_pending','shred_complete')),
  shred_op_id    TEXT,                  -- the destroy operation id (idempotency)
  shredded_at    TIMESTAMPTZ,           -- set when shred_complete (audit)
  shred_receipt  TEXT,                  -- custodian receipt id/hash (audit, non-secret)
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

`shredded_at` + `shred_receipt` make a completed shred auditable from the DB alone, and pair
with the custodian's tombstone (§2) for cross-checking during reconciliation.

No `kek_version` here — the custodian is authoritative for it (revision #5). Identity
ciphertext lives in `items` (rebuildable, cleared on rebuild, re-hydrated under the existing
`key_id`/`cur_epoch`). Keys are **reused** across rebuild; `item_key_control` is untouched.

---

## 5. Shred state machine + fail-closed reads (revisions #2)

```
active ──forget──▶ shred_pending ──destroy receipt──▶ shred_complete
                       │  reads deny identity from here
                       └─ reconciler retries destroy until a receipt is returned
```

`forget(item_id)` — the **coordinator** (held until this doc is approved):
1. **DB txn** (under the per-item lock): append opaque `ItemForgotten`; clear `items`
   identity ciphertext; set `shred_state='shred_pending'`, `shred_op_id = <new op id>`,
   recording `key_id`.
2. **Reads deny identity** from `shred_pending` onward.
3. `destroy(shred_op_id, key_id)` — idempotent on both `shred_op_id` and `key_id`, destroys
   the **whole lineage** (§6), returns a **destruction receipt**.
4. **Only after the receipt**, set `shred_state='shred_complete'`, `shredded_at=now()`,
   `shred_receipt=<receipt>` (audit).
5. `forget()` returns `shred_pending` (or `forgetAndWait` blocks to `shred_complete`); it
   **never claims erasure before step 4**.
6. **Reconciler** retries `destroy` for `shred_pending` rows and promotes on receipt.

**Fail-closed read rule:** the identity read path serves plaintext only when BOTH
`item_key_control.shred_state='active'` AND `custodian.status(key_id)='active'`. If the
custodian says `destroyed` (or `unknown`), identity is denied regardless of DB state — this is
what makes an old-backup restore safe (§8.1).

---

## 6. Generation & restore races; destruction scope (revisions #3, #4)

- **Immutable `key_id` + monotonic `epoch`.** Post-shred re-supply always starts a **fresh
  `key_id`** (new lineage, epoch 0), so a delayed `destroy` of the old `key_id` can never hit
  a new key.
- **Destruction scope = the whole old lineage.** `destroy(op_id, key_id)` destroys *all*
  generations of `key_id` (epoch wording corrected: not "epochs ≤ shred_epoch" — the entire
  lineage, since the new identity uses a different `key_id`).
- **Re-supply blocked until `shred_complete`.** `restore` cannot provision identity while
  `shred_pending`.

---

## 7. Provisioning: winner selection without a lock across custodian calls (revision #1)

**Correction (review #3):** a PostgreSQL advisory xact lock cannot span the external custodian
calls — that would require holding an open DB transaction across network I/O, which we do
**not** do. Instead, **provisional keys are created concurrently with no DB lock held**, and a
short DB transaction selects exactly one winner via **compare-and-swap (CAS)** on
`cur_epoch`. Losers destroy their own provisional keys. The DB function **reports whether the
operation committed**.

```
1. op_id = new id                                  (client; NO DB lock held here)
2. custodian.provision(op_id, item_id, target_epoch) -> { key_id, dek }   [PROVISIONAL]
       // concurrent callers may each hold a distinct provisional key_id — that's fine
3. encrypt identity with dek (AAD-bound)
4. DB txn (short; per-item advisory lock taken and released INSIDE this txn; NO custodian
   calls inside): CAS — iff item_key_control.cur_epoch = expected_prev_epoch, then write the
   ciphertext + item_key_control(key_id, cur_epoch=target_epoch, operation_id=op_id) and
   COMMIT. The function RETURNS committed = true/false.
5a. committed = true  -> custodian.commitProvision(op_id)   [PROVISIONAL -> ACTIVE]
5b. committed = false -> custodian.destroy(op_id, key_id)   // loser cleans up its provisional key
```

The advisory lock now guards only the in-DB CAS (no external I/O inside the transaction).
Concurrency is resolved by the CAS + `operation_id`/`epoch`, not by holding a lock across
custodian calls. Reads never see a provisional generation (`get`/identity-read require ACTIVE).

Failure matrix:

| Failure | State | Recovery |
|---|---|---|
| provision ok, DB (4) fails / not committed | provisional key, no committed DB row | the caller `destroy`s its provisional key; the reconciler's `listStaleProvisioning` is the backstop |
| DB committed, `commitProvision` (5a) ack fails | committed DB row, custodian still provisional | reconciler (or promote-on-read) retries idempotent `commitProvision`; until ACTIVE, reads **fail closed** |
| unknown timeout on any step | ambiguous | safe retry: `provision`/`commitProvision`/`destroy` are idempotent on `operation_id` (destroy also on `key_id`) |
| concurrent provisioning for one item | several provisional keys exist; the DB **CAS picks one winner**; every loser `destroy`s its own provisional key |

### 7.1 Reconciler safety under DB unavailability (revision #2, #3)

The reconciler may destroy a provisional key **only** when it can positively confirm, from an
**available** DB, that no committed `item_key_control` row references that `operation_id`/
`key_id`. If the DB is unavailable — or the custodian `status`/listing call throws — the
reconciler **does nothing** for that key. "DB unavailable" is never treated as proof that a
key is orphaned. A provisional key with an unreachable DB is left untouched until both sides
are readable. (This is why `status` failures are exceptions, not a value — §2.)

### 7.2 Unwrapped DEK lifetime in application processes (revision #3)

Destroying the custodian record does not erase DEKs already unwrapped into app memory.
Required handling:

- **No long-lived DEK cache.** DEKs are fetched per encrypt/decrypt operation. (If a cache is
  ever introduced it must support **eviction across every runtime instance** — e.g. a
  pub/sub invalidation keyed by `key_id` — and is out of scope for the first implementation.)
- **DEKs are `Buffer`, never `string`** (strings are immutable and linger in the heap); held
  only for the duration of one operation.
- **Best-effort zeroization in `finally`** (`buf.fill(0)`) after each use.
- **Recheck-before-return (TOCTOU guard):** immediately before returning decrypted identity,
  re-verify `custodian.status(key_id) === 'active'` (and DB `shred_state='active'`); if it is
  `destroyed`/`provisional`/throws, **discard the plaintext and fail closed**.
- **In-flight reads when forget begins:** a read that unwrapped a DEK before `forget` started
  must still pass the recheck-before-return; if `forget` completed mid-read, the recheck sees
  `destroyed` and the read fails closed, so no post-shred plaintext is ever returned.
- DEKs and decrypted identity are registered with the `SecretStore`/redaction path so they can
  never be logged.

---

## 8. Lifecycle + rebuild (approved) and old-backup reconciliation (revision #3)

- **addItem / restore:** the §7 provisioning sequence (restore after `shred_complete` uses a
  fresh `key_id`). Restore is operational + re-supply; shredded identity is unrecoverable.
- **read identity:** the fail-closed rule of §5.
- **rebuildProjection:** clears `items` (incl. ciphertext), refolds the opaque log, leaves
  `item_key_control` and the custodian untouched; identity re-hydrated under the existing key;
  forgotten items stay shredded.

### 8.1 Old-backup reconciliation (revision #3)

Restoring a **pre-forget main-DB backup** yields `item_key_control.shred_state='active'` for
an item whose key the custodian has since destroyed (`status='destroyed'`, via the durable
tombstone). Contract:

1. **Reads fail closed.** The §5 read rule already denies identity because
   `custodian.status(key_id)='destroyed'`, even though the restored DB says `active`.
2. **No automatic replacement key** may be provisioned for **existing** ciphertext — that would
   manufacture access to data that was meant to be erased. Re-supply is only via an explicit
   new-lineage `restore`/`addItem`, never an implicit heal of old ciphertext.
3. **Restore reconciliation** detects `DB active` ∧ `custodian destroyed` and **re-applies the
   forgotten transition** — appends `ItemForgotten`, clears ciphertext, sets
   `shred_state='shred_complete'` — driven by the custodian's destruction **tombstone**. The
   restored DB self-heals to the correct shredded state.

This is exactly why destruction tombstones are durable and non-secret (§2): they are the
authority that overrides a stale restored `active`.

---

## 9. What changes in Phase 1 (approved correction)

Invariants unchanged (opaque append-only log, `apply` sole mutator, lifecycle transitions,
locking, least-privilege role, `pg_temp` hardening, no-leak on payloads). Changed: schema
(identity → ciphertext blob; new `item_key_control`), authority functions (`cat_add_item`/
`cat_restore` take ciphertext + write key-control; `cat_forget` becomes the coordinator),
restore contract (operational + re-supply), rebuild (preserves key-control).

---

## 10. Sequencing (approved)

1. **SecretStore + log redaction (same gate) — CLEARED TO BUILD NOW.** Plaintext exists in-app
   before encryption, so redaction lands with/ahead of encryption.
2. **Crypto-shredding coordinator** — custodian interface + in-process fault-injecting dev
   custodian, envelope, key-control, forget coordinator + reconciler. *(Held until this doc is
   approved.)*
3. **Production custodian adapter + integration suite** — required before any "production
   shredding" claim (O4).
4. **Backup policy** — encrypted main-DB backups excluding all key material; restore resurrects
   neither expired behavioral events nor shredded identity.

---

## 11. Testing strategy (approved + additions)

Envelope (tamper/swap/nonce/schema); shred irrecoverability (capture ciphertext → forget →
undecryptable even with KEK); backup-cannot-resurrect (reload pre-forget ciphertext → denied);
**state-machine crash/fault injection** (custodian destroy fails/partials → pending, reads
denied, no erasure claim, reconciler completes); **provisioning failure matrix** (§7) via the
fault-injecting custodian; **old-backup reconciliation** (§8.1: restored `active` + tombstone
`destroyed` → fail closed + self-heal, no auto-replacement key); races (restore blocked while
pending; fresh `key_id` after complete); rebuild preserves key-control; DB-never-sees-plaintext
scan; per-item isolation; KEK versioned rewrap changes no ciphertext; **production-adapter
integration suite** gates production claims (O4).

Review #3 additions: **winner selection** (N concurrent provisions for one item → exactly one
committed via CAS, every loser's provisional key destroyed, the DB function's `committed` flag
is correct); **reconciler safety** (with the DB made unavailable, the reconciler destroys
nothing; a `status`/DB exception is never read as "orphaned"); **status semantics** (the four
values plus a thrown transport error, exercised via the fault-injecting custodian);
**DEK lifetime** (DEK is a `Buffer`, zeroized in `finally`; recheck-before-return fails closed
when the key is destroyed mid-read; an in-flight read that began before `forget` returns no
plaintext after completion). All 24 Phase 1 invariants carried forward.

---

## 12. Decisions recorded

- **O1** single `items` blob + separate ref ciphertext. **O2** external custodian (C1) +
  in-process dev custodian. **O4** dev custodian proves protocol; production-adapter integration
  suite required before any production-shredding claim. **O5** versioned KEK re-wrapping now
  (custodian-authoritative), rotation cadence deferred. **Sequencing** log redaction with
  encryption.
- Review #2 resolved: custodian contract expanded with `provision/commitProvision/get/destroy/
  status/listStaleProvisioning` + durable non-secret destruction receipts; provisioning intent
  lives custodian-side keyed by `operation_id` with an explicit failure matrix; old-backup
  reconciliation defined (fail closed, no auto-replacement, tombstone-driven self-heal);
  destruction scope = whole old lineage; custodian authoritative for KEK state.

Review #3 resolved: locking claim corrected — concurrent provisional keys + DB-side CAS winner
selection with a `committed` result, losers self-destroy (no lock across custodian calls);
custodian `status` is `provisional|active|destroyed|not_found` with transport failure as a
thrown error; `destroy` idempotent on op id AND key id; `shredded_at`/`shred_receipt` audit
fields; reconciler does nothing under DB unavailability; explicit unwrapped-DEK lifetime
(Buffer-only, zeroize, recheck-before-return, in-flight read fail-closed, no long-lived cache).

## 13. Status

**SecretStore + log redaction are implemented** (review-cleared; 4 tests green). The
crypto-shredding **coordinator remains held** until this v4 is approved. After sign-off the
design is implementation-ready; build order: custodian interface + in-process fault-injecting
custodian → envelope → key-control + winner-selection provisioning → forget coordinator +
reconciler → production adapter + integration suite → backup policy.
