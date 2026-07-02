# Phase 19 - Production Readiness Evidence Bundle

Phase 19 makes the production/privacy evidence set repeatable and safe to review. It does not add
new services, integrations, schedulers, cloud SDKs, or runtime behavior. Evidence is collected by an
operator from existing commands and summarized with the template in
`docs/templates/PRODUCTION_READINESS_EVIDENCE.md`.

The bundle is meant to answer one question: can a reviewer see the deployment health, backup
recoverability, restore rehearsal, KEK rotation preflight, and open production gates without seeing
secrets, identity, provider refs, key material, or raw media data?

## Evidence Commands

Collect evidence from these existing operator commands:

```bash
npm run ops:doctor -- --json
npm run ops:verify-backup -- <artifact>
REHEARSAL_ADMIN_DATABASE_URL=<throwaway-db> npm run ops:rehearse-restore -- <artifact>
npm run ops:rewrap-kek -- --plan --json
```

Do not paste raw command environments, full shell history, secret file paths, or unredacted logs into
the evidence report. Record command shapes, exit codes, redaction-safe JSON/status summaries, and
operator conclusions.

## Doctor Evidence

`ops:doctor --json` is the stable unattended health contract:

- `PASS` means the check satisfied the deployment invariant.
- `WARN` means operator-visible readiness or operational state that does not make the command fail.
- `FAIL` means the deployment is not healthy; the doctor exits non-zero.

The Phase 18 production gate warnings must be interpreted explicitly:

- `production-gate-o4-external-custodian` WARN means `CUSTODIAN_MODE=file` is still using
  `FileCustodian`, a hardened reference harness. It does not prove external/managed custodian or KMS
  readiness, and O4 remains open.
- `production-gate-o5-managed-kek` WARN means managed age KEK custody/scheduling remains open.
  `ops:rewrap-kek -- --plan` provides a non-mutating preflight, but it does not close O5 by itself.

A production report with only these WARN checks and no FAIL checks can still be operationally
healthy, but it is not evidence that O4/O5 are closed.

## Backup Verification Evidence

`ops:verify-backup -- <artifact>` is offline structural evidence. It does not require a database,
Docker, live custodian, cloud service, provider, or network. Record only the artifact label,
timestamp, command shape, exit code, and redaction-safe result. Do not include the artifact contents
or ciphertext payloads in the report.

## Restore Rehearsal Evidence

`ops:rehearse-restore -- <artifact>` must use a throwaway database through
`REHEARSAL_ADMIN_DATABASE_URL`. It must not point at production. The rehearsal proves the backup can
pass the real restore integrity gate in an isolated database. Record the throwaway nature of the
target, command shape, exit code, and redaction-safe pass/fail summary.

Do not include database URLs, credentials, secret file paths, raw row values, raw identity, provider
refs, media titles, or item-level dumps.

## KEK Rewrap Plan Evidence

`ops:rewrap-kek -- --plan --json` is a non-mutating KEK rotation preflight. It validates config and
reports aggregate counts such as `needsRewrap`, `alreadyCurrent`, `total`, and `mutates: false`.
Those aggregate counts are safe to include.

The plan must not be treated as managed rotation. It does not add age custody, scheduling,
zero-touch key handling, a cloud KMS, or background rotation. O5 remains open until those production
custody/scheduling requirements are resolved or formally accepted.

## Redaction Rules

Safe to include:

- Commit/build id, schema version, deployment type, and non-secret mode names.
- Command shapes with placeholders.
- Exit codes, PASS/WARN/FAIL states, aggregate counts, and redaction-safe summaries.
- O4/O5 status and reviewer/operator conclusions.

Must omit or redact:

- KEKs, DEKs, wrapping keys, master keys, completion secrets, HMAC secrets, API keys, tokens,
  credentials, private keys, seed phrases, or key material.
- Raw identity, provider refs, media titles, Jellyfin ids, catalog item dumps, plaintext identity,
  or screenshots/logs containing user media identity.
- Full environment dumps, database URLs, credential-bearing paths, secret file paths, and backup
  artifact contents.

## Manual Evidence Boundary

Production readiness evidence is operator-run and manually collected. It must not become a CI
requirement, and CI must not require Docker, network, live Jellyfin, live external custodian, cloud
services, age tooling, production databases, or operator credentials.

Use the release/upgrade checklist in `docs/RELEASE_CHECKLIST.md` to decide when to collect a fresh
bundle, and use the template in `docs/templates/PRODUCTION_READINESS_EVIDENCE.md` for the report.
