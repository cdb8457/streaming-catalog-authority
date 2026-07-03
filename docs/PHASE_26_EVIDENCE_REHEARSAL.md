# Phase 26 - Operator Evidence Rehearsal Check

Phase 26 adds a deterministic operator command for checking the expected shape of the Phase 22/23
production-readiness evidence package. It is an advisory local checklist only. It does not read,
validate, create, modify, scan, or grade real evidence.

Use it with:

- `docs/PHASE_22_PRODUCTION_READINESS_GATE.md` - the authoritative nine-row readiness gate.
- `docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md` - the redaction-safe artifact map.
- `docs/PHASE_25_READINESS_REHEARSAL.md` - the earlier readiness rehearsal skeleton.
- `docs/templates/PRODUCTION_READINESS_EVIDENCE.md` - the shareable evidence report template.

## Command

```bash
npm run ops:evidence-rehearsal
npm run ops:evidence-rehearsal -- -- --json
```

The text form is for an operator pre-review walk-through. The JSON form is deterministic and can be
used by local tests or review tooling. Both forms are static and redaction-safe.

## What It Checks

The command prints all nine Phase 22 rows and their Phase 23 artifact labels:

1. Deployment / Unraid config - `01-deployment-unraid.redacted.md`
2. External custodian / KMS (O4) - `02-external-custodian-o4.redacted.md`
3. KEK rotation (O5) - `03-kek-rotation-o5.redacted.md`
4. Backup/restore + retention - `04-backup-restore-retention.redacted.md`
5. `ops:doctor` / warning gates - `05-doctor-warning-gates.redacted.json`
6. Scheduled operator tasks - `06-scheduled-operator-tasks.redacted.md`
7. Jellyfin validation evidence - `07-jellyfin-validation.redacted.md`
8. CI / test expectations - `08-ci-test-expectations.redacted.md`
9. Privacy / redaction - `09-privacy-redaction.redacted.md`

For each row it prints only:

- the gate category;
- the expected redacted artifact label;
- evidence-shape prompts;
- retained/not-retained style placeholders;
- redaction reminders.

It does not inspect whether any artifact exists, and it does not read artifact contents.

## Safety Boundary

`ops:evidence-rehearsal` is local/static only. It does not:

- load repo config or read environment secret values;
- inspect the filesystem for evidence;
- read evidence artifacts, logs, backup artifacts, ciphertext, or secret files;
- connect to a database;
- call the network;
- run Docker;
- contact Jellyfin;
- contact a live custodian, cloud service, or KMS;
- run age tooling;
- access a production database;
- decide production readiness.

The command is deliberately not a pass/fail readiness gate. It is only a checklist for confirming
that the expected evidence package shape is understood before a real operator-owned review.

## Open Gates

O4 remains open/deferred unless separate real external-custodian evidence proves or accepts it. O5
remains open/deferred unless managed KEK custody plus rotation scheduling evidence proves or accepts
it. `FileCustodian` remains a hardened reference harness, not production KMS.

## Redaction Rules

Do not put sensitive values into rehearsal notes or evidence bundles. In particular, never include
secret values, KEKs, DEKs, wrapping keys, completion secrets, HMAC secrets, API keys, tokens,
credentials, private keys, DB URLs, secret paths, full environment dumps, raw logs, backup artifact
contents, ciphertext payloads, raw identity, provider refs, media titles, Jellyfin ids, collection
handles, or screenshots containing identity.

Use labels, counts, dates, statuses, retained/not-retained placeholders, and reviewed conclusions
instead.
