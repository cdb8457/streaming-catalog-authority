# Phase 54 - TorBox Live Smoke Acceptance Record

Phase 54 adds a local, redaction-safe preflight for recording the independent-review disposition of
a retained TorBox live-smoke packet.

The fixed source label is `single-operator-supplied-acceptance-record-json-file`.

```bash
npm run --silent ops:torbox-live-smoke-acceptance-record -- -- <acceptance-record.json> --json
```

The acceptance record is metadata only. It may mark the live-smoke packet `accepted`, `rejected`, or
`deferred`, but it never enables provider mode by itself.

```json
{
  "report": "phase-54-torbox-live-smoke-acceptance-record",
  "decision": "accepted",
  "independentReviewerVerdict": "GO",
  "packetManifestPreflight": "ready-for-review",
  "redactionSafe": true,
  "artifactContentsIncluded": false,
  "credentialValuesIncluded": false,
  "credentialPathsIncluded": false,
  "rawRefsIncluded": false,
  "providerPayloadsIncluded": false,
  "liveTorBoxContact": false,
  "commandExecution": false,
  "enablesProviderMode": false,
  "closesO4": false,
  "closesO5": false,
  "o4Status": "open/deferred",
  "o5Status": "open/deferred",
  "fileCustodianStatus": "reference-harness-not-production-kms"
}
```

## Scope

Included:

- one explicit acceptance record JSON input file only;
- fixed metadata checks for redaction and review-boundary flags;
- fixed decision values: `accepted`, `rejected`, or `deferred`;
- required `packetManifestPreflight: ready-for-review`;
- required independent reviewer `GO` only when the decision is `accepted`;
- fixed JSON and text output modes.

Not included:

- no credential values;
- no credential file paths;
- no raw refs, infohashes, digests, URLs, headers, cookies, account details, item ids, media titles,
  endpoint URLs, provider payloads, response bodies, parse snippets, or debug logs;
- no artifact contents;
- no live TorBox calls;
- no env reads;
- no database access;
- no directory scanning;
- no command execution other than the acceptance preflight command itself;
- no transport construction;
- no downloads, playback, scheduler, HTTP, UI, provider writes, adapter-factory live wiring, or CI
  live-network requirement.

This preflight does not enable TorBox provider mode, close O4, or close O5. O4 and O5 remain open/deferred, and `FileCustodian` remains a hardened reference harness rather than production KMS.
