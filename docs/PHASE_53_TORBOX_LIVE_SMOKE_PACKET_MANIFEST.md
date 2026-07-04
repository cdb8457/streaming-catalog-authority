# Phase 53 - TorBox Live Smoke Packet Manifest Preflight

Phase 53 adds a local, redaction-safe preflight for an operator-written TorBox live-smoke retained
packet manifest.

The fixed source label is `single-operator-supplied-packet-manifest-json-file`.

The command reads one explicit manifest JSON file and verifies that the retained packet names the
required redacted artifact kinds before independent review:

- Phase 43 service-status report;
- Phase 43 hoster-metadata report;
- Phase 44 service-status preflight;
- Phase 44 hoster-metadata preflight;
- Phase 49 summary pack;
- Phase 51 review gate.

The optional cache-availability report and preflight are accepted only when both are listed.

```bash
npm run --silent ops:torbox-live-smoke-packet-manifest -- -- <packet-manifest.json> --json
```

## Manifest Shape

The manifest is metadata only. It should list artifact kinds and redacted labels, not artifact
contents.

```json
{
  "report": "phase-53-torbox-live-smoke-packet-manifest",
  "redactionSafe": true,
  "artifactContentsIncluded": false,
  "credentialValuesIncluded": false,
  "credentialPathsIncluded": false,
  "rawRefsIncluded": false,
  "providerPayloadsIncluded": false,
  "liveTorBoxContact": false,
  "commandExecution": false,
  "closesLiveSmokeReview": false,
  "o4Status": "open/deferred",
  "o5Status": "open/deferred",
  "fileCustodianStatus": "reference-harness-not-production-kms",
  "artifacts": [
    { "kind": "phase-43-service-status-report", "label": "redacted-service-status-report" },
    { "kind": "phase-43-hoster-metadata-report", "label": "redacted-hoster-metadata-report" },
    { "kind": "phase-44-service-status-preflight", "label": "redacted-service-status-preflight" },
    { "kind": "phase-44-hoster-metadata-preflight", "label": "redacted-hoster-metadata-preflight" },
    { "kind": "phase-49-summary-pack", "label": "redacted-summary-pack" },
    { "kind": "phase-51-review-gate", "label": "redacted-review-gate" }
  ]
}
```

## Scope

Included:

- one explicit packet manifest JSON input file only;
- fixed metadata checks for redaction and review-boundary flags;
- required artifact-kind presence checks;
- optional cache-availability artifact pairing check;
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
- no command execution other than the manifest preflight command itself;
- no transport construction;
- no downloads, playback, scheduler, HTTP, UI, provider writes, adapter-factory live wiring, or CI
  live-network requirement.

This preflight prepares review but does not close live-smoke review. O4 and O5 remain open/deferred,
and `FileCustodian` remains a hardened reference harness rather than production KMS.
