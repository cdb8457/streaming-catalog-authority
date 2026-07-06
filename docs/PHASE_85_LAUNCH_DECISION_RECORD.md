# Phase 85 - Launch Decision Record

Phase 85 adds a local, redaction-safe preflight for recording the operator's
Phase 84 launch-decision disposition.

This is not a launch approval. The preflight always reports `launchApproved:
false`, `productionReady: false`, `closesO4: false`, and `closesO5: false`.
It only checks that a single operator-supplied decision record uses fixed,
reviewable labels and does not claim to include secrets, artifact contents,
provider payloads, raw refs, command execution, or live service contact.

## Command

```bash
npm run --silent ops:launch-decision-record -- -- <decision-record.json> --json
```

## Example Record

```json
{
  "report": "phase-85-launch-decision-record",
  "sourcePacket": "phase-84-operator-acceptance-packet",
  "disposition": "launch-candidate-requested",
  "productionSecurityDecision": "residual-risk-accepted",
  "unraidOperatorRehearsal": "accepted",
  "liveServiceValidation": "accepted",
  "independentReviewerVerdict": "GO",
  "redactionSafe": true,
  "artifactContentsIncluded": false,
  "credentialValuesIncluded": false,
  "credentialPathsIncluded": false,
  "rawRefsIncluded": false,
  "providerPayloadsIncluded": false,
  "liveServiceContact": false,
  "commandExecution": false,
  "launchApproved": false,
  "productionReady": false,
  "closesO4": false,
  "closesO5": false,
  "fileCustodianStatus": "reference-harness-not-production-kms"
}
```

Allowed `disposition` values are `blocked`, `deferred`, and
`launch-candidate-requested`. A `launch-candidate-requested` record is only
`ready-for-review` when:

- `independentReviewerVerdict` is `GO`;
- `productionSecurityDecision` is `proven` or `residual-risk-accepted`;
- `unraidOperatorRehearsal` is `accepted`;
- `liveServiceValidation` is `accepted`;
- all fixed redaction and non-execution flags are present.

`residual-risk-accepted` records that the operator has accepted residual O4/O5
risk for review purposes. It does not close O4 or O5.

## Redaction Boundary

The input record must be metadata only. It must not contain secret values,
credential file contents, credential paths, API keys, tokens, KEKs, DEKs,
database URLs, raw environment dumps, request or response bodies, provider
payloads, raw provider refs, infohashes, magnets, titles, server URLs, backup
contents, artifact contents, or copied logs.

The preflight output never echoes input values or file paths. It emits only
fixed pass/warn/fail codes, counts, and fixed boundary labels.

## Non-Goals

- No evidence directory scanning.
- No artifact content reads.
- No credential, environment, or database reads.
- No network calls or live service contact.
- No command execution except this preflight process itself.
- No provider mode, playback, downloading, scraping, media-server writes,
  frontend framework, API framework, or web UI expansion.
- No launch approval, production-readiness approval, O4 closure, or O5 closure.

## Verification

- `npm run test:launch-decision-record`
- `npm run test:deploy`
