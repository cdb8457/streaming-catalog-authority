# Phase 30 - KEK Custody and Scheduling Evidence Preflight

Phase 30 adds a deterministic, redaction-safe operator preflight for O5 managed KEK custody and
scheduling evidence descriptor JSON. It reads one operator-supplied descriptor file, validates only
metadata/status fields, and prints a fixed report for evidence review.

This command prepares reviewer/operator evidence review only. It does not rotate keys, run age,
inspect key files, install scheduling, prove production readiness, or close O5.

O5 remains open/deferred. O4 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Usage

```bash
npm run ops:kek-evidence-preflight -- -- <descriptor.json>
npm run ops:kek-evidence-preflight -- -- <descriptor.json> --json
```

The command accepts:

- one required descriptor JSON path;
- optional `--json`;
- `--help`.

Unsupported arguments fail closed with usage output. The CLI defensively tolerates literal forwarded
`--` separators from npm invocation.

## Descriptor Shape

The descriptor is metadata only. Supported fields are:

- `rewrapPlanEvidenceLabel`;
- `rotationRecordLabel`;
- `managedKekCustodyDocumented`;
- `rotationScheduleDocumented`;
- `operatorRunbookDocumented`;
- `alertTriageDocumented`;
- `independentSecretMediaDocumented`;
- `noRawSecretsInEvidence`;
- `residualRiskAccepted`;
- `redactionReviewStatus: "passed" | "pending" | "failed" | "unknown"`.

Labels must be non-secret evidence labels only. The descriptor must not include KEKs, DEKs, wrapping
keys, age identities, private keys, secret file paths, environment dumps, database URLs, raw logs,
backup contents, raw identity, provider refs, media titles, Jellyfin ids/tokens/handles, command
output blobs, artifact contents, or live service identifiers.

## Safety Boundary

The preflight:

- reads exactly one user-supplied JSON descriptor file;
- enforces a bounded descriptor size;
- strips exactly one leading UTF-8 BOM;
- parses JSON to an object only;
- emits fixed fields, summary counts, finding levels/codes/fields/messages, and open gate status.

The preflight does not read environment values, scan directories, inspect evidence artifacts, inspect
key files, read logs, read backups, read ciphertext, connect to a database, call the network, run
Docker, invoke age, contact a live custodian, KMS, cloud service, vendor SDK, scheduler API, or access
provider/debrid/Plex/Jellyfin services.

It also does not add a scheduler, cron installer, daemon, runtime default, key rotation automation,
mutating rewrap, real KMS adapter, SDK, HTTP service, UI, playback, scraping, downloading, or runtime
product behavior.

## Redaction Rules

Normal output never echoes descriptor paths, descriptor values, raw JSON, parse snippets, raw parser
errors, raw filesystem errors, artifact contents, or command output blobs.

Failure cases use fixed redaction-safe codes:

- `DESCRIPTOR_FILE_READ_FAILED`;
- `DESCRIPTOR_FILE_TOO_LARGE`;
- `DESCRIPTOR_JSON_MALFORMED`;
- `DESCRIPTOR_OBJECT_REQUIRED`.

Validation findings are value-free. Hostile values such as KEKs, DEKs, age identities, private keys,
secret paths, URLs, DB URLs, tokens, media titles, provider refs, Jellyfin identifiers, and artifact
contents must not appear in text or JSON output.

## Report Semantics

The report includes:

- `report: "phase-30-kek-evidence-preflight"`;
- `redactionSafe: true`;
- `purpose: "prepare-o5-managed-kek-custody-and-scheduling-evidence-review"`;
- `descriptorValuesEchoed: false`;
- `o4Status: "open/deferred"`;
- `o5Status: "open/deferred"`;
- `fileCustodianStatus: "reference-harness-not-production-kms"`;
- `closesO5: false`;
- `reviewReadiness`;
- `summary` counts;
- fixed finding codes, levels, fields, and messages.

`reviewReadiness: "ready-for-review"` means metadata is complete enough for reviewer/operator evidence
review. It does not mean production-ready, does not prove managed custody, does not install or verify
scheduling, and does not close O5.

## Tests

```bash
npm run test:kek-evidence-preflight
```

The suite covers valid descriptors, incomplete descriptors, hostile value redaction, BOM-prefixed
input, malformed/array/primitive/missing/directory/oversized descriptor inputs, npm JSON invocation,
and static scope guards for the source.
