# Phase 93 - Semi-Launch Validation Packet

Phase 93 defines the GO/HOLD validation packet for deciding whether
`launch-candidate-1` is a real semi-launch candidate. It does not grant GO by
itself because real operator evidence and independent review are still required.

The default verdict is HOLD pending operator evidence.

This phase does not approve launch, approve production readiness, approve a
release candidate, approve a production release, close O4, close O5, inspect
evidence, read artifacts, run commands, contact live services, or add runtime
behavior.

## Command

Text packet:

```bash
npm run ops:semi-launch-validation-packet
```

JSON packet:

```bash
npm run --silent ops:semi-launch-validation-packet -- -- --json
```

The report is `phase-93-semi-launch-validation-packet` with
`SEMI_LAUNCH_VALIDATION_PACKET_RECORDED`, `semiLaunchCandidateVerdict: hold`,
`semiLaunchCandidateGo: false`, `launchApproved: false`,
`productionReady: false`, `releaseCandidateApproved: false`,
`releaseApproved: false`, `closesO4: false`, `closesO5: false`,
`operatorEvidenceCollected: false`, and `independentReviewRequired: true`.

Allowed claim:

`launch candidate is sealed; semi-launch GO is pending operator evidence review`

Forbidden claim:

`semi-launch candidate approved`

## What This Proves

This packet proves the validation shape. It does not prove the real operator
evidence. A future retained evidence review may use this packet to decide GO or
HOLD.

## Required Ref Checks

- `master` equals `origin/master`.
- `master` equals `phase-92`.
- `master` equals `launch-candidate-1`.
- `phase-93` points at the validation-packet commit after seal.
- Working tree is clean after validation-packet seal.

## Required Repo Validation

- `npm ci` from a clean checkout of `launch-candidate-1`.
- `npm run ci` from a clean checkout of `launch-candidate-1`.
- `npm run test:deploy` from the validation branch.
- `npm run test:semi-launch-validation-packet` from the validation branch.
- `git diff --check` before commit.
- Source boundary grep for runtime, provider, network, evidence, and approval
  drift.

## Required Operator Evidence Labels

- `ops-doctor-json-result-label`
- `backup-created-label`
- `backup-verify-result-label`
- `restore-rehearsal-result-label`
- `kek-rewrap-plan-result-label`
- `scheduler-retention-evidence-label`
- `provider-live-smoke-acceptance-label`
- `media-server-validation-evidence-label`
- `o4-deferred-risk-acceptance-label`
- `o5-deferred-risk-acceptance-label`
- `independent-reviewer-go-or-hold-label`

## HOLD Triggers

- Hold if master, origin/master, phase-92, and launch-candidate-1 do not point
  at the same reviewed commit before validation.
- Hold if clean-checkout repo validation fails.
- Hold if any required operator evidence label is missing.
- Hold if independent reviewer verdict is missing or HOLD.
- Hold if O4 or O5 are described as closed.
- Hold if any retained evidence includes secrets, raw identity, provider
  payloads, raw refs, server URLs, logs, artifact contents, or actual evidence
  values.

## GO Conditions

- All required ref checks pass.
- Clean-checkout repo validation passes.
- All required operator evidence labels are present and redaction-safe.
- Independent reviewer records GO for semi-launch candidate use.
- O4 and O5 remain visible as accepted deferred risk, not closed.
- Semi-launch wording avoids production-ready, release-approved, or turnkey
  claims.

## Remaining Production Issues

- O4 still needs real external custodian/KMS evidence before production closure.
- O5 still needs managed KEK custody and rotation scheduling evidence before
  production closure.
- Semi-launch GO cannot be recorded by this packet until operator evidence and
  independent review exist.

## Forbidden Material

Do not retain secret values, credential contents, credential paths, API keys,
tokens, KEKs, DEKs, wrapping keys, private keys, completion secrets, database
URLs, raw environment dumps, request or response bodies, provider payloads, raw
provider refs, infohashes, magnet links, media titles, user library identity,
server URLs, backup contents, artifact contents, raw logs, patch contents, or
actual evidence values.

## Non-Goals

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

- `npm run test:semi-launch-validation-packet`
- `npm run test:deploy`
