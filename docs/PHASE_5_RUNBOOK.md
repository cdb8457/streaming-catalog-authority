# Phase 5 — Operator Runbook (self-hosted / Unraid)

Catalog/privacy core only. Every operation here is a **one-shot CLI** (`npm run ops:*`, or
`docker compose -f docker-compose.deploy.yml run --rm ops <script>`). No HTTP service, no UI.

All commands assume config is provided via env / `*_FILE` (see `.env.example` and
`docs/PHASE_3_DEPLOYMENT.md`). Commands print **status only — never secret values**.

## 0. Concepts (what protects what)

| Asset | Lives in | Protects |
|---|---|---|
| identity ciphertext | DB (`items.identity_ct`, `provider_refs.ref_value_ct`) | encrypted under a per-item **DEK** |
| DEK (wrapped) | **keystore** (FileCustodian), separate volume | wrapped under the **KEK** |
| KEK | `CUSTODIAN_KEK[_FILE]` (operator decrypts age → base64) | unwraps DEKs |
| completion secret | `crypto_config` (DB, owner-only) **and** the custodian | HMAC attests shred completion |

Crypto-shredding: `forget` destroys the DEK lineage in the keystore → surviving ciphertext (DB,
backups, replicas) is permanently undecryptable. **The keystore/KEK are excluded from DB backups.**

## 1. First run (bootstrap)

```bash
npm run ops:init        # migrate (owner) → provision completion secret → ops:doctor self-check
```
`ops:init` applies the schema, sets `crypto_config.completion_secret` to your configured
`COMPLETION_SECRET` via the owner-only `set_completion_secret()`, then runs the read-only doctor.
Exit code 0 = ready.

Provision/rotate the completion secret directly (owner connection):
```sql
SELECT set_completion_secret('<the-shared-secret>');   -- owner only; app role is denied
```

## 2. Production self-check (read-only)

```bash
npm run ops:doctor      # exit 0 if healthy; non-zero on any FAIL
```
Validates: not `memory` in production, DB owner+app reachable, schema migrated, **app role
least-privileged** (cannot write tables, cannot read/set the secret), **completion secret matches**
`crypto_config`, custodian reachable, keystore writable. Run it before serving and on a schedule.

In production, `ops:doctor` also surfaces open production gates as WARN checks in both text and
`--json` output:

- `production-gate-o4-external-custodian`: emitted for `CUSTODIAN_MODE=file` because
  `FileCustodian` is a hardened reference harness, not external/managed custodian evidence.
- `production-gate-o5-managed-kek`: managed age KEK custody/scheduling remains open. The
  redaction-safe operator preflight is `npm run ops:rewrap-kek -- --plan`.

These WARN checks keep `doctor: OK` and exit 0 when no FAIL checks are present; they are production
readiness visibility, not enforcement. `CUSTODIAN_MODE=memory` in production still FAILS unless the
explicit insecure override has already allowed config loading.

## 3. Backup

```bash
npm run ops:backup -- dump /backups/catalog-$(date +%F).json
```
The artifact is **ciphertext + key-control only** — it excludes the keystore, KEK, and the
completion secret. **Encrypt it at rest yourself** (e.g. `age -r <recipient> file > file.age`);
the erasure guarantee comes from key-material exclusion, not artifact encryption.

## 4. Restore (with preflight)

```bash
npm run ops:backup -- restore /backups/catalog-2026-06-30.json
```
The restore **refuses** (exit 2, no partial apply) unless the preflight passes: DB reachable,
custodian reachable, and the configured completion secret **matches** `crypto_config`. It then runs
the replay-and-compare integrity gate and **rolls back** on any mismatch.

> Restoring the DB alone does **not** re-supply key material. Provision the KEK
> (`CUSTODIAN_KEK_FILE`) and the completion secret (`set_completion_secret`) **first**, or the
> restored system is fail-closed by design.

## 5. KEK rotation (rewrap)

First run a non-mutating preflight with the same config:
```bash
# CUSTODIAN_KEK = NEW key, CUSTODIAN_KEK_PREVIOUS = OLD key (both base64 32 bytes; _FILE supported)
npm run ops:rewrap-kek -- --plan
npm run ops:rewrap-kek -- --plan --json   # stable aggregate counts for scripts
```
The plan validates config and scans live wrapped-DEK files without writing them. It reports only
aggregate counts (`needsRewrap`, `alreadyCurrent`, `total`) and fails closed if a live file unwraps
under neither the previous nor the new KEK. It must not print KEKs, DEKs, key ids, identity,
provider refs, or secret file paths.

If the plan succeeds, quiesce the app (single-writer), then run the explicit mutation:
```bash
npm run ops:rewrap-kek
```
Re-wraps every live DEK from the old KEK to the new one **in place**; identity ciphertext is
untouched. **Resumable + idempotent** (safe to re-run after an interruption). Afterward, remove
`CUSTODIAN_KEK_PREVIOUS` from the runtime config — normal operation uses only `CUSTODIAN_KEK`.
The age-encrypted KEK files are decrypted operator-side **before** the rewrap.

## 5a. Production readiness evidence

Use `docs/PHASE_19_PRODUCTION_READINESS_EVIDENCE.md` and
`docs/templates/PRODUCTION_READINESS_EVIDENCE.md` when preparing a shareable production-readiness
bundle. The evidence set summarizes `ops:doctor --json`, offline backup verification, throwaway-DB
restore rehearsal, and `ops:rewrap-kek -- --plan --json`. It is manually collected by the operator,
redaction-safe, and must not become a CI requirement.

## 6. Interrupted-operation recovery

- **Interrupted shred** (custodian destroy crashed mid-way): the FileCustodian replays its
  crash-recovery **journal** on next construction; the **reconciler** (`auth.reconcile()`) completes
  any `shred_pending` rows. Idempotent; safe to run repeatedly.
- **Interrupted KEK rewrap**: re-run `ops:rewrap-kek` — already-rewrapped keys are skipped.
- **Old-backup restored over a live keystore**: the reconciler self-heals (a still-`active` row
  whose key is `destroyed` is re-driven through `forget`); reads fail closed until then.

## 7. Disaster-recovery matrix

| Lost | Recoverable? | Procedure |
|---|---|---|
| DB only (keystore + KEK + secret intact) | **Yes** | provision config → `ops:init`/`ops:doctor` → `ops:backup -- restore <artifact>` → reconcile if needed |
| Keystore (wrapped DEKs) and/or KEK | **No** for existing identities (by design) | surviving ciphertext is permanently undecryptable; re-supply identities via `restore()`/re-add; structural/behavioral state still replays from the event log |
| Completion secret only | Yes | `set_completion_secret('<secret>')` to the value the custodian holds; shred completion verifies again |
| Everything (DB + keystore + KEK) | **No** | total loss — keep keystore/KEK and DB backups on independent media |

**Backup hygiene:** the DB backup and the keystore/KEK must be stored **separately**; a single
location holding both defeats crypto-shredding. The DB backup never contains key material by
construction (see Stage 3b), and `ops:doctor` warns if `memory` mode is used outside dev.

## Out of scope (unchanged)
No provider adapters / Real-Debrid / TorBox / Plex / Jellyfin / Hermes, no scraping / downloading /
playback, no web/mobile UI, no HTTP daemon, no cloud KMS SDK. Managed-KMS (**O4**) and managed age
KEK custody/scheduling (**O5**) remain open production gates; see `docs/PHASE_3_DEPLOYMENT.md` and
`docs/PHASE_17_KEK_ROTATION_READINESS.md`.
