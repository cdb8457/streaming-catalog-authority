# Phase 29 - Production Custodian Evidence Preflight

Phase 29 adds a deterministic, redaction-safe operator preflight for O4 production custodian
descriptor JSON. It reads one operator-supplied descriptor file, validates the descriptor metadata
against the Phase 28 production custodian contract, and prints a fixed report for evidence review.

This command prepares reviewer/operator evidence review only. It does not prove production readiness,
does not close O4, and does not replace live external-custodian acceptance.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Usage

```bash
npm run ops:custodian-evidence-preflight -- -- <descriptor.json>
npm run ops:custodian-evidence-preflight -- -- <descriptor.json> --json
```

The command accepts:

- one required descriptor JSON path;
- optional `--json`;
- `--help`.

Unsupported arguments fail closed with usage output. The CLI defensively tolerates literal forwarded
`--` separators from npm invocation.

## Descriptor Shape

The descriptor is metadata only and follows the fields validated by
`src/core/crypto/production-custodian-contract.ts`, such as:

- adapter name/version labels;
- custody boundary;
- `KeyCustodian` implementation status;
- attestation documentation status;
- durable tombstone status;
- app-non-forgeability status;
- fail-closed semantics documentation status;
- live validation evidence label;
- contract kit command label;
- redaction review status;
- backup/restore fail-closed evidence status.

The descriptor must not include secrets, URLs, key material, receipt contents, raw logs, environment
dumps, database URLs, raw identity, provider refs, media titles, Jellyfin ids/tokens/handles, secret
paths, backup contents, ciphertext, or evidence artifact contents.

## Safety Boundary

The preflight:

- reads exactly one user-supplied JSON descriptor file;
- enforces a bounded descriptor size;
- parses JSON to an object only;
- uses the existing Phase 28 `validateProductionCustodianDescriptor` validator;
- emits fixed fields, summary counts, finding levels/codes/fields/messages, and open gate status.

The preflight does not read environment values, scan directories, inspect evidence artifacts, read
logs, read backups, read ciphertext, connect to a database, call the network, run Docker, invoke age,
contact a live custodian, KMS, cloud service, or vendor SDK, or access provider/debrid/Plex/Jellyfin
services.

## Redaction Rules

Normal output never echoes descriptor paths, descriptor values, raw JSON, parse snippets, raw parser
errors, raw filesystem errors, or artifact contents.

Failure cases use fixed redaction-safe codes:

- `DESCRIPTOR_FILE_READ_FAILED`;
- `DESCRIPTOR_FILE_TOO_LARGE`;
- `DESCRIPTOR_JSON_MALFORMED`;
- `DESCRIPTOR_OBJECT_REQUIRED`.

Validation findings are inherited from the Phase 28 validator and remain value-free. Hostile values
such as tokens, URLs, key material, DB URLs, media titles, provider refs, Jellyfin identifiers, and
secret paths must not appear in text or JSON output.

## Report Semantics

The report includes:

- `report: "phase-29-custodian-evidence-preflight"`;
- `redactionSafe: true`;
- `descriptorValuesEchoed: false`;
- `o4Status: "open/deferred"`;
- `o5Status: "open/deferred"`;
- `fileCustodianStatus: "reference-harness-not-production-kms"`;
- `closesO4: false`;
- `reviewReadiness`;
- `summary` counts;
- Phase 28 finding codes, levels, fields, and messages.

`reviewReadiness: "ready-for-review"` means metadata is complete enough for reviewer/operator evidence
review. It does not mean production-ready, does not prove the live custodian, and does not close O4.

## Tests

```bash
npm run test:custodian-evidence-preflight
```

The suite covers valid descriptors, incomplete/reference-harness descriptors, hostile value redaction,
malformed/array/primitive/missing/oversized descriptor inputs, npm JSON invocation, and static scope
guards for the source.
