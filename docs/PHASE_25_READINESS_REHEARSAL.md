# Phase 25 - Operator Readiness Rehearsal

Phase 25 adds a deterministic rehearsal command for checking the shape of a Phase 22/23 readiness
evidence package before a real review. It is an operator planning aid only. It does not collect,
validate, create, modify, or scan real evidence.

Use it with:

- `docs/PHASE_22_PRODUCTION_READINESS_GATE.md` - the authoritative nine-row readiness gate.
- `docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md` - the redaction-safe artifact map.
- `docs/PHASE_26_EVIDENCE_REHEARSAL.md` - the follow-on evidence package shape checklist.
- `docs/templates/PRODUCTION_READINESS_EVIDENCE.md` - the shareable evidence report template.

## Command

```bash
npm run ops:readiness-plan
npm run ops:readiness-plan -- -- --json
```

The text form is for an operator dry run. The JSON form is for deterministic local checks and review
tooling. Both forms are static and redaction-safe.

## What It Prints

The command emits a skeleton for all nine Phase 22 rows:

1. Deployment / Unraid config
2. External custodian / KMS (O4)
3. KEK rotation (O5)
4. Backup/restore + retention
5. `ops:doctor` / warning gates
6. Scheduled operator tasks
7. Jellyfin validation evidence
8. CI / test expectations
9. Privacy / redaction

For each row it prints:

- the status category to rehearse (`met`, `operator-provided`, `deferred`, or `blocked`);
- the Phase 23 artifact label;
- command shapes or evidence-source labels;
- the redaction-safe summary the operator should be ready to produce.

It also prints explicit warnings that O4 and O5 remain open/deferred unless separately proven or
formally accepted, and that `FileCustodian` is a hardened reference harness, not production KMS.

## Safety Boundary

`ops:readiness-plan` is local/static only. It does not:

- load repo config or read environment secret values;
- connect to a database;
- scan evidence directories;
- read backup artifacts;
- read raw logs or live service output;
- call the network;
- run Docker;
- contact Jellyfin;
- contact a custodian, cloud service, or KMS;
- require age tooling, operator credentials, a production DB, or a live external custodian.

The command is deliberately not a readiness-review pass/fail gate. It does not close O4 or O5. It is
only a rehearsal that lets an operator check whether the expected evidence package shape is understood
before running real operator-owned commands.

## Redaction Rules

Do not put sensitive values into rehearsal notes or evidence bundles. In particular, never include
secret values, KEKs, DEKs, wrapping keys, completion secrets, HMAC secrets, API keys, tokens,
credentials, private keys, DB URLs, secret paths, full environment dumps, raw logs, backup artifact
contents, ciphertext payloads, raw identity, provider refs, media titles, Jellyfin ids, collection
handles, or screenshots containing identity.

Use labels, counts, dates, statuses, and reviewed conclusions instead.
