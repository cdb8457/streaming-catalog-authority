# Phase 91 - Production-Time Decision

Phase 91 records the operator direction to push through to launch-candidate
review while preserving the security boundary exactly: O4 and O5 are accepted as
visible deferred risk for a launch candidate, not closed.

This phase does not approve launch, approve production readiness, approve a
release candidate, close O4, close O5, inspect evidence, read artifacts, run
commands, contact live services, or add runtime behavior.

## Command

Text record:

```bash
npm run ops:production-time-decision
```

JSON record:

```bash
npm run --silent ops:production-time-decision -- -- --json
```

The report is `phase-91-production-time-decision` with
`PRODUCTION_TIME_DECISION_RECORDED`,
`launchCandidateRequested: true`, `launchApproved: false`,
`productionReady: false`, `releaseCandidateApproved: false`,
`closesO4: false`, `closesO5: false`, and `residualRiskAccepted: true`.

## Allowed Launch Claim

Use this wording:

`launch candidate requested; O4/O5 deferred risk explicitly accepted`

Do not use this wording:

`turnkey production ready`

## O4/O5 Disposition

O4 and O5 remain open gates.

- O4: external custodian / KMS gate
  - disposition: `operator-accepted-deferred-risk`
  - `closesGate: false`
  - required evidence to close later: real external custodian adapter outside
    the app trust boundary, live operator validation against the acceptance kit,
    and redaction-safe attestation / fail-closed evidence
- O5: managed KEK custody and rotation scheduling gate
  - disposition: `operator-accepted-deferred-risk`
  - `closesGate: false`
  - required evidence to close later: managed KEK custody evidence, documented
    rotation schedule evidence, and redaction-safe rewrap plan or rotation
    record

## Required Operator Evidence Labels

- `ops-doctor-result-label`
- `backup-verify-result-label`
- `restore-rehearsal-result-label`
- `scheduler-retention-evidence-label`
- `torbox-live-smoke-acceptance-label`
- `jellyfin-validation-evidence-label`
- `o4-deferred-risk-acceptance-label`
- `o5-deferred-risk-acceptance-label`

## Final Review Checklist

- Confirm master and launch-candidate tag point at the same reviewed commit.
- Confirm CI is green with zero failures.
- Confirm no runtime, provider-mode, playback, scraping, downloading, or UI
  scope expansion was added by this decision.
- Confirm O4 and O5 are visible as accepted deferred risks, not closed gates.
- Confirm retained evidence uses labels, counts, statuses, and placeholders
  only.
- Confirm production wording says launch candidate, not turnkey production
  ready.

## Remaining Production Issues

- O4 is not closed until a production external custodian/KMS adapter is
  validated and reviewed.
- O5 is not closed until managed KEK custody and rotation scheduling evidence is
  validated and reviewed.
- Operator-run evidence must be retained outside the repo using redaction-safe
  templates.

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
- No O4 closure.
- No O5 closure.
- No DB reads or writes.
- No credential, environment, evidence-content, artifact-content,
  backup-content, provider-payload, raw-ref, URL, or media-identity reads.
- No network calls or live service contact.
- No provider mode, playback, downloading, scraping, media-server writes,
  frontend framework, API framework, web UI expansion, scheduler, Docker change,
  or background runtime work.

## Verification

- `npm run test:production-time-decision`
- `npm run test:deploy`
