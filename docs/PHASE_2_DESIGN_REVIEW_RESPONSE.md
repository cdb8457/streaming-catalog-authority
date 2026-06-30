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
