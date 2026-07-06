# Phase 92 - Launch Candidate Seal

Phase 92 records the launch-candidate seal. It allows tagging the reviewed
commit as `phase-92` and `launch-candidate-1` while preserving the same security
posture from Phase 91: O4 and O5 are accepted only as visible deferred
launch-candidate risk.

This phase does not approve launch, approve production readiness, approve a
release candidate, approve a production release, close O4, close O5, inspect
evidence, read artifacts, run commands, contact live services, or add runtime
behavior.

## Command

Text seal:

```bash
npm run ops:launch-candidate-seal
```

JSON seal:

```bash
npm run --silent ops:launch-candidate-seal -- -- --json
```

The report is `phase-92-launch-candidate-seal` with
`LAUNCH_CANDIDATE_SEAL_RECORDED`, `launchCandidateSealed: true`,
`launchApproved: false`, `productionReady: false`,
`releaseCandidateApproved: false`, `releaseApproved: false`,
`closesO4: false`, `closesO5: false`, and `residualRiskAccepted: true`.

## Tag Labels

- `phase-92`
- `launch-candidate-1`

Both labels must point at the same reviewed commit as `master` and
`origin/master`.

## Allowed Claim

Use this wording:

`launch candidate sealed for review; O4/O5 deferred risk explicitly accepted`

Do not use this wording:

`production release approved`

## Required Ref Checks

- `master` and `origin/master` point at the launch-candidate seal commit.
- `phase-92` points at the launch-candidate seal commit.
- `launch-candidate-1` points at the launch-candidate seal commit.
- Working tree is clean after seal.

## Required Validation Checks

- `npm run test:launch-candidate-seal`
- `npm run test:deploy`
- `npm run typecheck`
- `npm run ci`
- `git diff --check`
- Source boundary grep for runtime, provider, network, and approval drift.

## Launch Candidate Boundaries

- Launch candidate only; not a production release.
- O4 remains open/deferred and accepted only as launch-candidate residual risk.
- O5 remains open/deferred and accepted only as launch-candidate residual risk.
- FileCustodian remains a hardened reference harness, not production KMS.
- No runtime behavior is added by this seal.
- No provider mode, playback, downloading, scraping, externally bound UI, or
  scheduler is enabled by this seal.

## Remaining Production Issues

- O4 still needs real external custodian/KMS evidence before production closure.
- O5 still needs managed KEK custody and rotation scheduling evidence before
  production closure.
- Operator-run evidence still must be retained outside the repo using
  redaction-safe templates.

## Forbidden Material

Do not retain secret values, credential contents, credential paths, API keys,
tokens, KEKs, DEKs, wrapping keys, private keys, completion secrets, database
URLs, raw environment dumps, request or response bodies, provider payloads, raw
provider refs, infohashes, magnet links, media titles, user library identity,
server URLs, backup contents, artifact contents, raw logs, patch contents, or
actual evidence values.

## Non-Goals

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

- `npm run test:launch-candidate-seal`
- `npm run test:deploy`
