# Phase 2 — Crypto-Shredding Design (v3, post-review #2)

**Status:** design. v3 completes the protocol contracts review #2 required before the
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
    // idempotent on operation_id; leaves a durable NON-SECRET destruction tombstone.
status(key_id) -> 'active' | 'destroyed' | 'unknown'
    // 'destroyed' is backed by the durable tombstone; 'unknown' = no record (custodian failure
    // vs genuinely-never-existed is distinguishable via listStaleProvisioning + DB state).
listStaleProvisioning() -> [{ operation_id, item_id, key_id, age }]
    // provisional generations never committed — input to the reconciler.
```

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
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

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
3. `destroy(shred_op_id, key_id)` — idempotent, destroys the **whole lineage** (§6), returns a
   **destruction receipt**.
4. **Only after the receipt**, set `shred_state='shred_complete'`.
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

## 7. Provisioning: explicit cross-system sequence (revision #2)

The provisioning intent lives **in the custodian** as provisional state keyed by
`operation_id` — not split across systems. Per-item advisory lock serializes concurrent
attempts; `operation_id` makes every step retry-idempotent.

```
1. op_id = new id                                  (client, under per-item lock)
2. custodian.provision(op_id, item_id, epoch)      -> { key_id, dek }   [PROVISIONAL]
3. encrypt identity with dek (AAD-bound)
4. DB txn: write ciphertext + item_key_control(key_id, cur_epoch=epoch, operation_id=op_id)
           with optimistic check on expected cur_epoch
5. custodian.commitProvision(op_id)                [PROVISIONAL -> ACTIVE]
```

Failure matrix:

| Failure | State | Recovery |
|---|---|---|
| provision ok, DB (4) fails | provisional key, no committed DB row | reconciler `listStaleProvisioning` → `destroy`; reads never saw it (provisional ⇒ `get` denied) |
| DB ok, commit (5) ack fails | committed DB row, custodian still provisional | reconciler (or promote-on-read) retries idempotent `commitProvision`; until active, reads **fail closed** |
| unknown timeout on any step | ambiguous | safe retry: `provision`/`commitProvision`/`destroy` are all idempotent on `operation_id` |
| concurrent provisioning for one item | serialized by the per-item advisory lock; `operation_id` uniqueness + optimistic `cur_epoch` reject the loser |

No identity read is ever served from a provisional generation (`get` denies unless ACTIVE).

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
integration suite** gates production claims (O4). All 24 Phase 1 invariants carried forward.

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

## 13. Status

Contracts complete pending review #2 sign-off. **SecretStore + log redaction are being built
now** (review-cleared). The crypto-shredding coordinator remains held until this v3 is approved.
