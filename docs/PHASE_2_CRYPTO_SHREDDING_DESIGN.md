# Phase 2 — Crypto-Shredding Design (for review)

**Status:** design only. No code yet. This is the first Phase 2 task, per the Phase 1
approval ("proceed to Phase 2, beginning with crypto-shredding design").

Phase 1 gave us *logical* erasure: `forget` nulls identity in the live projection and the
event log is opaque. It explicitly did **not** erase PostgreSQL's physical residue — dead
tuples, WAL, replicas, and prior backups can still hold the identity bytes. Crypto-shredding
closes that gap: identity is only ever stored **encrypted**, under a **per-item key**, and
`forget` **destroys the key**. After that, every copy of the ciphertext — live, WAL,
replica, backup — is permanently undecryptable. We erase a small key, not scattered data.

---

## 1. Threat model

What real erasure must defeat (Phase 1 did not):

| Residue | Why nulling columns fails | Crypto-shred outcome |
|---|---|---|
| Dead tuples (pre-`UPDATE` row versions) until VACUUM | old version still holds plaintext | old version holds only ciphertext; key gone |
| WAL / archived WAL | records the plaintext write | records only ciphertext writes |
| Streaming/physical replicas | replays the plaintext | replays only ciphertext |
| Base backups / PITR | captured plaintext at backup time | captured only ciphertext; key never in that backup |
| Server logs (statements/params) | could capture plaintext identity | identity travels as ciphertext; plaintext never leaves the app |

Non-goals (out of scope): defeating an attacker who has already exfiltrated plaintext, or
who controls the KMS at the moment of capture. Crypto-shred guarantees *future*
irrecoverability after the key is destroyed, not retroactive secrecy against a prior
compromise.

---

## 2. Key hierarchy (envelope encryption)

```
Master Key (KEK)              -- in a KMS / the Phase 2 SecretStore; never in Postgres
   └─ wraps per-item Data Encryption Key (DEK)   -- one DEK per catalog item
         └─ encrypts that item's identity fields + provider ref values
```

- **KEK**: a single (rotatable) master key held in the runtime SecretStore / external KMS.
  Never written to `events`, the projection, logs, or DB backups.
- **DEK**: 256-bit key minted per item on first identity write. Stored only in *wrapped*
  form (encrypted under the KEK) in a dedicated `item_keys` keystore.
- **Crypto-shred = delete the item's wrapped DEK.** Without the DEK, the ciphertext is
  unrecoverable even by someone holding the KEK and every backup.

Why per-item DEKs (not one global key): forget must shred *one* item without affecting
others, and without re-encrypting the whole catalog.

---

## 3. What is encrypted, and where

Encryption happens **in the application** (the authority client), before bytes reach
Postgres. The database — and therefore WAL, replicas, backups, and logs — only ever sees
ciphertext for identity.

Encrypted (AEAD, e.g. AES-256-GCM; AAD = item id + field name to bind ciphertext to its slot):
- `items.title`, `items.year`, `items.external_ids`, `items.metadata`
- `provider_refs.ref_value`

Not encrypted (already non-identifying / operational):
- everything in `events` (still opaque, unchanged from Phase 1)
- operational projection columns: `present`, `forgotten`, `behavioral_score`, `last_seq`,
  `ref_type`, timestamps

Schema change: the identity columns become `BYTEA` (ciphertext) instead of `TEXT/JSONB`,
or a single `identity_ciphertext BYTEA` blob per item plus a per-ref ciphertext. (Open
question O1 below — column-wise vs single-blob.)

This also retires the Phase 1 residual risk that a plaintext title passed as a bind
parameter could be logged: the parameter is now ciphertext.

---

## 4. The keystore

```
item_keys (
  item_id      TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  wrapped_dek  BYTEA NOT NULL,     -- DEK encrypted under the KEK
  kek_version  INT  NOT NULL,      -- which KEK wrapped it (for rotation)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

Destruction semantics matter — a logical `DELETE` leaves a dead tuple, the same residue
problem one layer down. Options, strongest first:

- **(A) Keystore outside the main DB** (a KMS, or a dedicated keystore with no archival/PITR
  and aggressive shred). The main DB's backups then contain *no* DEKs at all, so a restored
  backup cannot decrypt anything whose key was shredded. **Recommended.**
- **(B) Keystore in Postgres**, but on `forget`: overwrite `wrapped_dek` with random bytes,
  then `DELETE`, then ensure the keystore table is excluded from base backups / has
  minimal retention and is `VACUUM`-driven. Weaker (WAL of the keystore still needs
  handling).

The choice is the crux of the design and the main thing I want reviewed (O2).

---

## 5. Lifecycle interactions

**addItem / restore (identity write):**
1. mint or fetch the item's DEK (unwrap with KEK via SecretStore),
2. encrypt each identity field (AEAD, AAD-bound),
3. pass ciphertext to the DB authority functions (which store it; DB never sees plaintext),
4. store the wrapped DEK in the keystore.

**read identity:** authorized reader fetches ciphertext + unwraps DEK + decrypts. If the
DEK is shredded, decryption is impossible — identity is simply gone.

**forget (crypto-shred):** within the existing locked authority path —
1. `cat_forget` still appends the opaque `ItemForgotten` event and clears the projection
   ciphertext columns (logical erasure, as today),
2. **and** destroys the item's DEK in the keystore (the new step).
Result: even if a backup or replica retains the old ciphertext, it is undecryptable forever.

**restore after forget:** identity **cannot** be recovered (its key is gone — that is the
point). `restore` therefore becomes *operational only*: it clears the tombstone and marks
the item present, but identity must be **re-supplied** by the caller (a fresh DEK is minted).
This refines the Phase 1 `restore(identity)` contract; document it.

**rebuildProjection:** unchanged in spirit. Replaying the opaque log restores operational
state; identity stays absent until re-hydrated. With encryption, "re-hydrate" means an
authorized writer re-encrypts under a (possibly new) DEK. Forgotten items have no DEK, so
they stay identity-less through any rebuild.

---

## 6. Sequencing within Phase 2

Crypto-shredding depends on, and dovetails with, the other Phase 2 deliverables from the
handoff. Proposed order:

1. **SecretStore** (handoff Phase 2 #1) — runtime-only access to the KEK and unwrapped DEKs;
   secrets never persisted to `events`, projection, logs, or errors. Crypto-shred needs
   this to exist first. *(Deliverable: SecretStore + the test that a secret round-trips but
   never appears in any DB row or log line.)*
2. **Crypto-shredding** (this doc) — keystore, envelope encryption of identity, shred-on-forget.
3. **Log redaction** (handoff Phase 2 #2) — route app logging through the existing
   `assertNoLeak` scanner; with identity now ciphertext, this is defense-in-depth for
   anything else.
4. **Backup policy** (handoff Phase 2 #3) — encrypted backups that **exclude** the keystore/
   KEK, and a restore that does **not** resurrect expired behavioral events **nor** shredded
   identity. The keystore-exclusion is what makes a restored backup crypto-shred-safe.

---

## 7. Testing strategy (what the proof must show)

- **Shred irrecoverability:** write identity, capture the raw ciphertext, `forget`, then show
  the ciphertext can no longer be decrypted (DEK gone) — even given the KEK.
- **Backup can't resurrect:** simulate "restore an old backup" (reload pre-forget ciphertext)
  and assert that without the (shredded) DEK the identity is unrecoverable.
- **DB never sees plaintext:** scan `events`, projection, and a captured statement/param log
  for the known plaintext identity; assert absent (only ciphertext present).
- **Per-item isolation:** shredding item A leaves item B fully decryptable.
- **Restore contract:** restore after forget yields a present item with NO identity until
  re-supplied; re-supplied identity uses a fresh DEK.
- **Rotation:** KEK rotation re-wraps DEKs without touching ciphertext; old KEK version
  retired.
- Carry forward all 24 Phase 1 invariants unchanged.

---

## 8. Open questions for review

- **O1 — ciphertext layout:** per-column `BYTEA` vs a single per-item identity blob.
  Per-column allows selective reads; single blob is simpler and leaks less shape. Lean: single
  blob for `items` identity + per-ref ciphertext for `provider_refs.ref_value`.
- **O2 — keystore location:** external KMS/keystore (A) vs in-Postgres with overwrite+exclude
  (B). (A) is materially stronger for the backup threat; (B) is simpler to run locally.
  Recommend (A), with (B) as a documented dev-only fallback.
- **O3 — crypto-shred atomicity:** the DEK lives outside the DB (if A), so "append
  ItemForgotten + clear projection + destroy DEK" spans two systems. Need a durable,
  idempotent shred protocol (e.g. mark-forgotten in DB first, then destroy key, with a
  reconciliation sweep) so a crash can't leave a forgotten item whose key survived.
- **O4 — embedded-PG test fidelity:** can we exercise (A) in tests without a real KMS? Likely
  a local file/in-memory keystore implementing the same destroy contract, with a note that
  production uses a managed KMS.
- **O5 — KEK rotation cadence & compromise response:** is KEK rotation in Phase 2 scope, or a
  later phase? (Rotation re-wraps DEKs; it does not re-encrypt identity.)

---

## 9. What does NOT change

The entire Phase 1 boundary stands: DB-resident authority, `apply` as the sole mutator,
opaque append-only log, lifecycle transitions, advisory-lock coordination, atomic
prune+rebuild, least-privilege `app` role, `pg_temp`-shadowing hardening, and the no-leak
gate on event payloads. Crypto-shredding is layered onto the identity columns and the
`forget` path; it does not touch the event-sourcing core.
