# Phase 2 Crypto-Shredding — Design Review Request

You reviewed Phase 1 of this catalog authority across five rounds and approved it. We are
now at the first Phase 2 task: a **design review of crypto-shredding** for true erasure,
*before any code is written*. Please review the design and tell us whether it is sound and
what to change — this is a design critique, not a code review.

The full design is in `docs/PHASE_2_CRYPTO_SHREDDING_DESIGN.md` (read it first). This note
is the framing + the specific things we want pressure-tested.

## Context you already have

Phase 1 gives *logical* erasure: `forget` nulls identity in the live projection and the
append-only event log is opaque. It does **not** erase PostgreSQL physical residue (dead
tuples, WAL, replicas, prior backups). Crypto-shredding is meant to close that.

## The design in one paragraph

Identity (title/year/external_ids/metadata and provider ref values) is encrypted **in the
application** with a **per-item DEK** (AES-256-GCM, AAD-bound to item id + field), so the
DB/WAL/replicas/backups only ever see ciphertext. Each DEK is wrapped by a master KEK and
stored in a keystore that lives **outside the main DB** (a KMS in prod; an in-process
keystore with the same destroy contract for dev/tests) — **decision already taken (O2 = A)**.
`forget` keeps the Phase 1 steps (opaque `ItemForgotten` event + clear projection) **and**
destroys the item's DEK. After that, every surviving copy of the ciphertext is permanently
undecryptable. `restore` after forget becomes operational-only (identity must be re-supplied;
it cannot be recovered — that is the point).

## What we want from you (most important first)

1. **Does this actually achieve irrecoverable erasure** against the stated threat model
   (dead tuples, WAL, archived WAL, replicas, base backups/PITR, logs)? Any residue path
   we missed where plaintext or a usable key survives a `forget`?

2. **O3 — shred atomicity across two systems.** The DEK lives outside the DB, so "append
   ItemForgotten + clear projection (Postgres)" and "destroy DEK (keystore)" are not one
   transaction. We propose: mark-forgotten in the DB first, then destroy the key, with an
   idempotent reconciliation sweep that destroys keys for any item already forgotten in the
   DB. Is that protocol correct and crash-safe? Is "DB says forgotten but key briefly
   survives" an acceptable transient, given the key is useless without also defeating the
   KEK and obtaining the ciphertext? Propose a better protocol if you have one.

3. **Keystore destroy semantics.** With (A), is deleting/zeroizing the wrapped DEK in the
   external keystore genuinely sufficient, assuming the keystore itself has no archival/PITR
   that resurrects it? What requirements must we put on the KMS/keystore for the guarantee
   to hold (no soft-delete, no backup of the key material, versioning disabled)?

4. **KEK handling & blast radius.** KEK compromise exposes only items whose DEKs still
   exist (shredded items remain safe). Is per-item DEK granularity the right boundary? Is
   KEK rotation needed in Phase 2 (re-wrap DEKs, no re-encryption of identity) or deferrable
   (O5)?

5. **Ciphertext layout (O1):** single per-item identity blob vs per-column BYTEA. We lean
   single blob for `items` identity + per-ref ciphertext for `provider_refs.ref_value`. Any
   reason to prefer per-column (selective reads) over the smaller attack/shape surface of a
   blob?

6. **Test fidelity (O4):** can an in-process dev keystore faithfully prove the shred
   guarantee (capture ciphertext → forget → assert undecryptable even with the KEK; restore
   an old backup → assert unrecoverable), or does proving it require a real KMS?

7. **Sequencing.** We plan: SecretStore (#1) → crypto-shredding → log redaction → backup
   policy (backups exclude the keystore). Is that the right order, and does crypto-shredding
   force any change to the already-approved Phase 1 core (we believe it does not — identity
   columns become BYTEA, the event-sourcing core is untouched)?

Be adversarial. If the scheme has a gap that makes "erased" untrue in some recovery
scenario, that is exactly what we need to hear before building.
