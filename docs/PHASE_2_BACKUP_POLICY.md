# Phase 2 — Stage 3b: Encrypted Backup & Restore Policy

Status: **built and tested.** Code: `src/core/backup/backup-policy.ts`. Proofs: `test/backup.ts`
(7 checks). This closes design §10 sequencing item 4. It does **not** close **O4** (managed-KMS
production adapter), which remains an open production deployment gate (see below).

## Goal

A backup of the main database, restored at any later time, must resurrect **neither a shredded
identity nor an expired behavioral event**. The cryptographic-erasure guarantee from Stage 2/3a
must survive disaster recovery.

## What is backed up vs excluded

`BackupPolicy.dump()` emits a logical, ciphertext-only artifact over exactly these tables
(`BACKED_UP_TABLES`, the single source of truth):

| Table | Why it is safe to back up |
|---|---|
| `events` | Append-only log; structural + behavioral. Expiry is re-enforced on replay (cutoff-aware reduce + prune), so an expired event in an old backup cannot resurrect a score. |
| `items` | Projection. `identity_ct` is **ciphertext only** — plaintext never reaches the DB. |
| `provider_refs` | Projection. `ref_value_ct` is **ciphertext only**. |
| `item_key_control` | Key **labels** (`key_id` is an opaque id) + shred lifecycle. **No DEK/KEK** — only state needed for fail-closed reads and reconciler self-heal. |
| `aborted_operations` | The durable TOCTOU abort fence. |

**Deliberately excluded** (`EXCLUDED_FROM_BACKUP`) — and none of it lives in the tables above:

| Excluded | Where it actually lives | Consequence if it leaked |
|---|---|---|
| FileCustodian **keystore** (wrapped DEKs) | separate filesystem / volume (`.keystore-*`) | a backup could decrypt surviving ciphertext → erasure defeated |
| **KEK** | custodian process / managed KMS | unwraps every DEK → erasure defeated |
| `crypto_config.completion_secret` | its own owner-only table; shared out-of-band with the external custodian | forgeable shred-completion attestations |

The `dump()` allow-list never names `crypto_config`, so the completion secret is never read or
serialized. The keystore and KEK are not in the database at all.

## Transactional consistency & the restore integrity gate

`dump()` reads all tables inside a single **`REPEATABLE READ READ ONLY`** transaction, so the whole
artifact is one point-in-time snapshot (the guarantee `pg_dump` gives). Without it, a mutation
committing between two per-table reads would tear the artifact — e.g. `items`/`item_key_control`
reflecting an event the dumped `events` does not contain.

Because `restore()` loads under `session_replication_role = replica` (append-only + FK enforcement
off, so a faithful reload is possible), it would otherwise ingest a torn or tampered artifact
silently. So after loading — still inside the transaction — it runs a **post-restore integrity
gate** (`assertConsistent`) and **`ROLLBACK`s with `BackupIntegrityError`** on any violation:

1. **Referential**: every `item_key_control` row references an existing `items` row. Key-control is
   *independent* of the event-sourced projection (it survives rebuild, has no FK), so it is not part
   of the replay below; this is its consistency requirement.
2. **Replay-and-compare** (the core check): re-fold the restored events with the **real reducer**
   (`cat_rebuild`, run with FK enforcement on inside a `SAVEPOINT`, then rolled back so the loaded
   data — including `identity_ct` — is preserved) and compare the resulting **structural
   projection** against the loaded one: `items(present, forgotten, last_seq)` and
   `provider_refs(present per item+type)`. Any divergence — a projection/ref row not reproduced by
   the log, or an event-implied row missing from the projection — is rejected.

Why replay-and-compare rather than per-column head checks: a head-only check (e.g. validating
`items.last_seq` against an event) is **insufficient**. Two examples it misses, both caught by
replay-and-compare:
- *masked missing item event*: items A@1, B@2; drop A@1, keep B@2 → global `max(last_seq)=max(seq)=2`
  and B's head is fine, yet A has no creating event;
- *non-derivable provider ref*: item + ref + a later same-item behavioral event; drop only the
  `ProviderRefAttached` event but keep the `provider_refs` row → `last_seq` still matches the later
  event, yet the ref is not derivable from the log.

Intentionally **out of the structural-derivability gate** (protected elsewhere, not silently
ignored): `behavioral_score` (cutoff/time-dependent, re-derived on the operator's next rebuild);
`item_key_control` lifecycle state (fail-closed reads + the reconciler self-heal handle stale key
state); and `identity_ct`/`ref_value_ct` ciphertext (AAD-bound AES-256-GCM fails closed on tamper).

Proven by `test/backup.ts` tests 8–12: refuse items-ahead-of-log; refuse a missing earlier-item
event masked by a later event; refuse dangling key-control; **refuse a provider ref whose attach
event was removed**; and `dump()` itself stays internally consistent under concurrent writes (the
probe drives `BackupPolicy.dump()` directly). Every refusal also asserts a **full rollback**.

## At-rest encryption

This module emits a plaintext-of-ciphertext artifact; it does **not** encrypt the artifact
itself. The operator MUST encrypt the backup at rest (storage-level encryption, or a
`pg_dump | age`/`gpg` pipeline). That is **defense-in-depth** — the erasure guarantee rests on the
**key-material exclusion above**, not on backup encryption. Adding a backup-encryption key here
would be one more key to manage and is orthogonal to crypto-shredding, so it is intentionally the
operator's responsibility. For a physical `pg_dump`/PITR equivalent, exclude the secret table, e.g.
`pg_dump --exclude-table-data=crypto_config` (and keep the keystore on a volume that is never part
of the DB backup set).

## External restore prerequisites (out-of-band — NOT in the artifact)

Restoring the main-DB backup **alone** yields a **fail-closed** system. Before it is usable an
operator must independently:

1. **Provision the KEK** into the custodian (managed KMS in production), and
2. **Set `crypto_config.completion_secret`** to the value shared with the external custodian.

Until both are supplied: identity reads deny (no key/KEK to decrypt), and shred completions cannot
verify (no secret to validate the HMAC attestation). `test/backup.ts` test 7 proves a restore does
**not** overwrite `crypto_config` — the secret is provisioned out-of-band, never carried by the
backup.

## Why a restore cannot resurrect a shredded identity

`forget` destroys the key lineage in the **custodian keystore** (overwrite-replace + unlink of the
wrapped DEK, plus a durable tombstone) — all of which is **excluded from the DB backup**. Restoring
an old (pre-forget) DB backup brings back `identity_ct` and a stale `active` key-control row, but:

- the destroyed key / its tombstone live in the separate keystore, which the DB restore never
  touches, so reads **fail closed** (the custodian reports the key `destroyed`); and
- the **reconciler self-heal** path re-drives `forget`, returning the row to `shred_complete` and
  re-clearing the ciphertext.

Proven by `test/backup.ts` tests 3 and 4.

## Why a restore cannot resurrect an expired behavioral event

Behavioral signals carry an `expires_at`. Expiry is enforced by the projection, not by the event's
mere presence:

- **cutoff-aware replay** (`cat_rebuild`/`cat_reduce`) counts a behavioral signal only while
  `expires_at > cutoff`; and
- **prune** (`cat_prune_and_rebuild`) physically deletes expired behavioral rows (the append-only
  trigger permits a DELETE only once `expires_at <= now()`).

So even restoring an old backup that still **contains** an expired event yields no resurrected
score after the standard post-restore maintenance, and a prune purges the row. Proven by
`test/backup.ts` tests 5 and 6.

## Scope and open gates

- `BackupPolicy` is a **reference harness** — a self-contained logical dump/restore over the
  existing connection, for tests and small deployments. It is **not** a cloud-provider backup
  integration; no S3/GCS/PITR-shipping code is scaffolded (kept honest: untested cloud code is not
  added).
- `FileCustodian` likewise remains a **reference harness, not the production adapter**.
- **O4 (managed-KMS production adapter) stays OPEN** as the production deployment gate: the real
  custodian runs outside the app trust boundary and provides the real deletion guarantee. Swapping
  it in is a constructor change; standing up the infra is a deployment task, not buildable here.
