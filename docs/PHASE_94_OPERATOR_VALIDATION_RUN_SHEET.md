# Phase 94 - Operator Validation Run Sheet

Phase 94 defines the final run sheet before Clint validation is required. It
lists the exact command shapes, evidence labels, and retention rules needed to
turn `launch-candidate-1` into a reviewed semi-launch candidate.

This phase does not run commands, collect evidence, approve semi-launch GO,
approve launch, approve production readiness, approve a release candidate,
approve a production release, close O4, close O5, inspect artifacts, contact live
services, or add runtime behavior.

## Command

Text run sheet:

```bash
npm run ops:operator-validation-run-sheet
```

JSON run sheet:

```bash
npm run --silent ops:operator-validation-run-sheet -- -- --json
```

The report is `phase-94-operator-validation-run-sheet` with
`OPERATOR_VALIDATION_RUN_SHEET_RECORDED`, `operatorActionRequired: true`,
`semiLaunchCandidateGo: false`, `operatorEvidenceCollected: false`,
`independentReviewRequired: true`, `launchApproved: false`,
`productionReady: false`, `releaseCandidateApproved: false`,
`releaseApproved: false`, `closesO4: false`, and `closesO5: false`.

Allowed claim:

`operator validation run sheet ready; semi-launch GO awaits retained evidence`

Forbidden claim:

`operator validation complete`

## Required Run Order

1. Verify launch-candidate refs.
2. Run clean checkout repository validation.
3. Run production doctor evidence.
4. Run backup and verification evidence.
5. Run restore rehearsal evidence.
6. Run KEK rewrap plan evidence.
7. Record scheduler and retention evidence.
8. Record provider live-smoke acceptance evidence.
9. Record media-server validation evidence.
10. Record O4/O5 deferred-risk acceptance.

## Reviewer Handoff Labels

- `ref-alignment-result-label`
- `clean-checkout-ci-result-label`
- `ops-doctor-json-result-label`
- `backup-verify-result-label`
- `restore-rehearsal-result-label`
- `kek-rewrap-plan-result-label`
- `scheduler-retention-evidence-label`
- `provider-live-smoke-acceptance-label`
- `media-server-validation-evidence-label`
- `o4-o5-deferred-risk-acceptance-label`

## Retention Rules

Retain only fixed labels, pass/fail statuses, counts, and timestamps. Never
retain secret values, credential contents, credential paths, API keys, tokens,
KEKs, DEKs, wrapping keys, private keys, completion secrets, database URLs, raw
environment dumps, request or response bodies, provider payloads, raw provider
refs, infohashes, magnet links, media titles, user library identity, server
URLs, backup contents, artifact contents, raw logs, patch contents, or actual
evidence values.

## HOLD Triggers

- Hold if any run-sheet evidence label is missing.
- Hold if any command result is not retained as a redaction-safe
  status/count/timestamp label.
- Hold if O4 or O5 are described as closed.
- Hold if reviewer GO is missing after evidence collection.
- Hold if any retained material includes secrets, raw identity, provider
  payloads, raw refs, URLs, raw logs, artifact contents, or actual evidence
  values.

## Non-Goals

- No operator evidence collection by this command.
- No semi-launch GO.
- No launch approval.
- No production-readiness approval.
- No release-candidate approval.
- No production release approval.
- No O4 closure.
- No O5 closure.
- No DB reads or writes.
- No credential, environment, evidence-content, artifact-content,
  backup-content, provider-payload, raw-ref, URL, or media-identity reads.
- No network calls or live service contact.
- No provider mode, playback, downloading, scraping, media-server writes,
  frontend framework, API framework, externally bound web UI expansion,
  scheduler, Docker change, or background runtime work.

## Verification

- `npm run test:operator-validation-run-sheet`
- `npm run test:deploy`
