# Phase 2 Crypto-Shredding — Response to Design Review #1

Direction was approved; the document needed explicit contracts before code. All seven
required revisions and the four recorded decisions are now in
`PHASE_2_CRYPTO_SHREDDING_DESIGN.md` (v2). Map:

| Required revision | Where addressed (v2) |
|---|---|
| 1. Define the production key custodian precisely; "every backup" = every main-DB backup; no recoverable keystore snapshot | §2 — custodian contract (`provision`/`get`/`destroyAll`); **C1 chosen** (external service storing wrapped DEKs with irreversible deletion); explicit storage requirements (no soft-delete/versioning/PITR/backup). §1 — "every backup" clarified. C2 (KMS-key-per-item) documented and rejected with reasons. |
| 2. Formalize the shred state machine (active → shred_pending → shred_complete); DB records exact key_id/epoch; reads deny immediately; idempotent destroy; complete only after confirmed deletion; `forget()` returns pending / cannot claim erasure early; reconciler retries | §5 — full state machine + forget coordinator steps; reads deny from `shred_pending`; `forget()` returns `shred_pending` (+ `forgetAndWait`); completion only after confirmed destruction; reconciler. |
| 3. Prevent generation/restore races (immutable key IDs + monotonic epochs; block re-supply until complete; destroy every historical generation) | §6 — immutable `key_id` + monotonic `epoch`; `destroyAll` over all epochs ≤ `shred_epoch`; restore blocked until `shred_complete`, then a fresh `key_id`. |
| 4. Add/write failure recovery (key first, encrypt, commit with optimistic versioning, destroy orphan on DB failure, reconciler for abandoned provisioning) | §7 — provision-intent first → encrypt → optimistic-versioned DB commit → orphan `destroyAll` on failure → reconciler for abandoned provisioning. |
| 5. Specify the ciphertext envelope (AES-256-GCM, fresh 96-bit nonce, version/nonce/ct/tag, AAD = item id + key epoch + schema version + field/ref type; tamper/swap/nonce-reuse tests) | §3 — exact envelope + AAD; §11 — tamper/swap/nonce-uniqueness/schema_version tests. |
| 6. Clarify rebuild vs keys (keys reused/retired/reconciled; key-control must survive rebuild) | §4 — `item_key_control` is a separate, non-rebuildable table (no FK to `items`); keys **reused** on rebuild; reconciler handles drift. §8 — rebuild interaction. |
| 7. Correct the Phase 1 statement (invariants unchanged, but schema, authority functions, forget coordinator, restore contract, rebuild behavior DO change) | §9 — rewritten: invariants unchanged; schema/authority-functions/forget-coordinator/restore-contract/rebuild explicitly listed as changing. |

Decisions recorded (§12): **O1** single item blob + separate ref ciphertext; **O2** external
custodian (C1) + in-process dev custodian; **O4** dev custodian proves protocol, real
production-adapter integration suite required before any production-shredding claim; **O5**
versioned KEK re-wrapping now, rotation cadence deferred. **Sequencing:** log redaction moved
to the same release gate as encryption (plaintext exists in-app before encryption).

Open confirmations requested for review #2 are listed in §13.

---

# Response to Design Review #2 (v3)

Review #2 approved most of v2 and required five more protocol contracts before the
crypto-shredding coordinator; it also cleared SecretStore + log redaction to begin now. All
five are in v3.

| Required revision | Where addressed (v3) |
|---|---|
| 1. Expand the custodian contract (`provision`/`commitProvision`/`get`/`destroy`→receipt/`status`/`listStaleProvisioning`); keep durable non-secret destruction tombstones to distinguish "destroyed" from "missing" | §2 — full contract + durable non-secret tombstones/receipts; `status` backed by tombstone. |
| 2. Make provisioning's cross-system sequence explicit (intent location; provision-ok/DB-fail; DB-ok/commit-fail; unknown-timeout retry; concurrent attempts); operation IDs + custodian provisional state | §7 — intent lives custodian-side keyed by `operation_id`; explicit 5-step sequence + a failure matrix covering all four cases; per-item lock + optimistic `cur_epoch` for concurrency. |
| 3. Define old-backup reconciliation (restored `active` vs custodian `destroyed`; fail closed; no auto-replacement key; tombstone-driven self-heal) | §8.1 — fail-closed reads (also §5), no automatic replacement key for existing ciphertext, tombstone-driven re-application of the forgotten transition. |
| 4. Resolve epoch wording (destroy the whole old lineage, since re-supply uses a fresh key_id) | §6 — destruction scope corrected to the **whole `key_id` lineage**; new identity = new `key_id`. |
| 5. Keep KEK metadata authoritative in the custodian (no drift via PostgreSQL) | §2 + §4 — custodian owns `kek_version`/wrapping/rotation; `kek_version` removed from `item_key_control`. |

Approved and unchanged: no-FK key-control, ciphertext envelope, single-blob layout,
pending/complete semantics, restore blocking, test strategy.

**Build status:** SecretStore + log redaction (review-cleared) are being implemented now; the
crypto-shredding coordinator is held until v3 is approved.

---

# Response to Design Review #3 (v4)

Review #3 approved the v3 contracts and required three final ones before the coordinator. All
three are in v4.

| Required revision | Where addressed (v4) |
|---|---|
| 1. Correct the locking claim — an advisory lock cannot span external custodian calls. Allow concurrent provisional keys; DB-txn lock + operation_id/epoch CAS selects one winner; losers destroy their provisional keys; the DB function reports whether it committed | §7 — rewritten: provisional keys created with NO DB lock held; a short DB txn does the CAS on `cur_epoch` and **returns `committed`**; winner `commitProvision`s, every loser `destroy`s its own provisional key. The advisory lock guards only the in-DB CAS, never custodian I/O. |
| 2. Strengthen custodian status (`provisional/active/destroyed/not_found`; service/network failure is a separate error, not `unknown`; reconciler never destroys a provisional key when the DB is unavailable; destroy idempotent by op id AND key id; persist `shredded_at` + receipt id/hash) | §2 — four-value status + thrown transport error; destroy idempotent on op id and key id with receipt. §4 — `shredded_at` + `shred_receipt`. §5 — recorded on completion. §7.1 — reconciler does nothing under DB unavailability. |
| 3. Define unwrapped-DEK lifetime (no long-lived cache; short-lived Buffers not strings; zeroize in finally; cross-instance eviction; state recheck before returning decrypted identity; in-flight read semantics) | §7.2 — Buffer-only DEKs, zeroize in `finally`, no long-lived cache (cross-instance eviction required if ever added), **recheck-before-return** fails closed, explicit in-flight-read-during-forget semantics, DEKs registered with SecretStore/redaction. |

Tests for all three added to the strategy (§11). Coordinator held until v4 sign-off; after
that the design is implementation-ready (build order in §13).

---

# Response to Design Review #4 (v5)

Review #4 found one correctness ambiguity (key lineage across ordinary updates) and asked to
record several custodian invariants and refine the read recheck. All addressed; the reviewer
approves the coordinator for implementation once the lineage rule is recorded — it now is.

| Required item | Where addressed (v5) |
|---|---|
| Key lineage: fresh `key_id` only for initial create or post-shred re-supply; ordinary updates + rebuild rehydration reuse the active lineage/DEK with fresh nonces; rotation stays under one immutable lineage; forget destroys the whole lineage | §6 — explicit lineage rule; §7 — the winner-selection sequence is scoped to the NEW-LINEAGE path only, with a separate in-lineage update path that reuses `key_id`/DEK and never mints a new key. |
| `destroyed` is terminal — delayed `commitProvision` can never reactivate | §2 — custodian invariant. |
| Reusing an `operation_id` with different inputs must fail | §2 — custodian invariant. |
| Ambiguous DB timeout resolved by querying the committed `operation_id`, never guessed | §2 + §7 failure matrix — query-the-DB resolution. |
| Replace the remaining `unknown` with `not_found`/transport error | §2 — status is `provisional/active/destroyed/not_found`; failures throw; the "unknown" wording is gone. |
| Define the read recheck as the read's linearization point (don't overclaim wall-clock) | §7.2 — recheck = linearization point; explicit that we do not claim "no response after wall-clock shred completion." |

**Verdict captured:** with the lineage rule recorded, the crypto-shredding coordinator is
approved for implementation (build order in design §13).

---

# Response to Stage 2a Code Review

Stage 2a (schema + coordinator + reads) review found three blockers + two gaps. All fixed;
suite is now **53 passed** (crypto 15, authority 21, SecretStore 4, crypto-shred 13).

| Finding | Fix | Proof |
|---------|-----|-------|
| **P0 — lost commit ack destroys the committed key** (DB active, custodian destroyed) | `addItem`/`restore`/`hydrateLegacy` share `provisionAndWrite`, which implements the approved failure matrix: on a DB error, confirm via `operation_id` whether it committed; promote if committed; destroy **only when non-commit is positively confirmed**; if it can't confirm, leave the key for the reconciler. A lost ack **after** a confirmed commit is swallowed (never destroys). | shred test "lost commit ack leaves the committed key intact" — key status ≠ destroyed, DB present. |
| **P0 — shred completion can be fabricated** (app calls `cat_forget_complete` with any receipt) | The custodian now returns an HMAC **attestation** over `key_id:shred_op_id` under a completion secret in the owner-only `crypto_config` table (app has no access). `cat_forget_complete` verifies it via `pgcrypto.hmac` before transitioning, and returns whether it transitioned. The app cannot forge it. | shred test "app cannot fabricate shred completion" — forged attestation raises `invalid destruction attestation`; row stays pending; key stays active. |
| **P1 — upgraded Phase 1 items cannot be rehydrated** | New `cat_hydrate_legacy_ct` + `authority.hydrateLegacy` establish a lineage + ciphertext for a present item with no key-control (does not append ItemAdded). | shred test "hydrateLegacy …" — plain add fails (`already present`), hydrate succeeds, identity readable. |
| **Gap — `updateIdentity` left omitted refs behind** | Replacement semantics: `cat_update_identity_ct` deactivates + clears any provider ref not in the new set. | shred test "updateIdentity — replacement semantics remove omitted provider refs". |
| **Gap — `CatalogAuthority` never used `SecretStore`** | The authority now registers each in-flight DEK (hex) and decrypted identity value with its `SecretStore` for the operation's duration (deleted in `finally`; no long-lived cache), and exposes `createLogger()` for redacted logging. | shred test "SecretStore — authority registers the in-flight DEK and decrypted identity". |

Note: the dev completion secret is a well-known value seeded into `crypto_config` and shared
by the in-process custodian. In production the custodian is external and shares the secret
with the DB out-of-band; the app never holds it. The in-process custodian proves protocol
logic, not the production deletion/attestation-secrecy guarantee (design O4).

Stage 2b (reconciler, concurrent winner-selection races, old-backup self-heal) remains for
the next stage.

---

# Response to Stage 2a Code Review #2

Three newly-exposed blockers; all fixed. Suite is now **55 passed** (crypto 15, authority 21,
SecretStore 4, crypto-shred 15).

| Finding | Fix | Proof |
|---------|-----|-------|
| **P0 — reference removal is not event-sourced** (removed ref reappears `present=true` after rebuild) | New opaque **`ProviderRefDetached`** event (registry + typed payload + transition + reducer). `cat_update_identity_ct` now removes omitted refs by **authoring `ProviderRefDetached`** (reducer deactivates + clears ciphertext), so removal survives a rebuild. | shred test "ref removal is event-sourced and survives rebuild" — ref presence identical pre/post rebuild; detached ref stays absent. |
| **P1 — SecretStore integration violated its own contract** (DEK stringified to hex; identity secrets deleted before the read resolved; externalIds/metadata never registered; spy test proved registration, not protection) | Dropped DEK-hex registration entirely (DEK stays a `Buffer`, zeroized). Added a scoped **`withIdentity(itemId, fn)`**: every identity string (title, ref values, **and** nested externalIds/metadata) is registered for the lifetime of `fn` only (deleted after — no long-lived cache); plaintext is not returned from the scope. | shred test "withIdentity — logging inside the scope is redacted" — title, external-id value, and ref value are all redacted via `createLogger()`; `secrets.size()===0` after. |
| **P1 — attestation conflicts with idempotent receipts** (a new shred op on an already-destroyed key got the stable receipt attested to the original op → `invalid destruction attestation`, blocking self-heal) | Attestation now binds the **destruction statement** `(key_id, receipt_id, destroyed_at)`, not the operation id — stable across idempotent re-destroys. Canonical message is **newline-joined** over strictly-formatted, newline-free fields (no `:`-delimiter ambiguity), asserted defensively on both sides. `cat_forget_complete` takes `(item, shred_op_id, receipt_id, destroyed_at, attestation)`. | shred test "stable receipt verifies for a new shred op" — completion succeeds under a fresh operation on an already-destroyed key. |

These unblock Stage 2b's old-backup self-heal. Stage 2b (reconciler, concurrent
winner-selection races, old-backup self-heal) remains for the next stage.
