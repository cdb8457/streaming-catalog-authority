# Phase 89 - Launch Candidate Review Handoff

Phase 89 adds a static independent-review handoff after Phase 88. It does not
create a launch candidate, approve launch, approve production readiness, close
O4, close O5, inspect evidence, read artifacts, or assign runtime work.

The handoff is a redaction-safe list of section labels, source label names,
reviewer question labels, hold trigger labels, required verdict labels,
forbidden material, and explicit non-goals.

## Command

Text handoff:

```bash
npm run ops:launch-candidate-review-handoff
```

JSON handoff:

```bash
npm run --silent ops:launch-candidate-review-handoff -- -- --json
```

The report is `phase-89-launch-candidate-review-handoff` with
`LAUNCH_CANDIDATE_REVIEW_HANDOFF_REPORTED`, `launchApproved: false`,
`productionReady: false`, `releaseCandidateApproved: false`, `closesO4: false`,
and `closesO5: false`.

## Handoff Sections

- Sealed target review labels:
  - source labels: `commit-id-label`, `tag-name-label`, `phase-number-label`
  - question labels: `target-ref-match-question`,
    `unreviewed-diff-question`
  - hold labels: `target-label-missing`, `target-label-ambiguous`,
    `unreviewed-diff-label-present`
- Packet chain review labels:
  - source labels: `phase-85-launch-decision-record.redacted.json`,
    `phase-86-launch-candidate-scope-freeze.redacted.json`,
    `launch-candidate-metadata.redacted.json`,
    `phase-88-launch-candidate-review-checklist`
  - question labels: `packet-chain-label-only-question`,
    `approval-flag-false-question`
  - hold labels: `packet-label-missing`, `packet-claims-launch-approval`,
    `packet-retains-actual-values`
- Security boundary review labels:
  - source labels: `o4-decision-label`, `o5-decision-label`,
    `filecustodian-boundary-label`
  - question labels: `o4-visible-question`, `o5-visible-question`,
    `filecustodian-reference-harness-question`
  - hold labels: `o4-hidden-or-softened`, `o5-hidden-or-softened`,
    `filecustodian-claimed-production-kms`
- Operator evidence review labels:
  - source labels: `deployment-unraid-label`,
    `backup-restore-retention-label`, `ci-test-expectations-label`,
    `privacy-redaction-label`
  - question labels: `operator-evidence-labels-present-question`,
    `redaction-boundary-question`
  - hold labels: `operator-evidence-label-missing`,
    `raw-artifact-requested`, `secret-path-requested`
- TorBox/Jellyfin/Usenet validation review labels:
  - source labels: `torbox-validation-label`, `jellyfin-validation-label`,
    `usenet-fallback-label`
  - question labels: `provider-payload-absent-question`,
    `raw-ref-absent-question`, `media-identity-absent-question`
  - hold labels: `provider-payload-label-present`,
    `raw-ref-label-present`, `media-identity-label-present`

## Reviewer Instructions

- Review label names, command references, and explicit hold triggers only.
- Do not request raw evidence, artifact contents, secret paths, provider
  payloads, raw refs, URLs, media identity, logs, or patch contents.
- Return GO only when every required label is present and every hold trigger
  remains absent.
- Return HOLD if any approval flag is true or if O4/O5 are hidden, softened, or
  closed.

## Required Verdict Labels

- `reviewer-go-label`
- `reviewer-hold-label`
- `required-change-label`
- `residual-risk-label`

## Forbidden Material

Do not retain secret values, credential contents, credential paths, API keys,
tokens, KEKs, DEKs, wrapping keys, private keys, completion secrets, database
URLs, raw environment dumps, request or response bodies, provider payloads, raw
provider refs, infohashes, magnet links, media titles, user library identity,
server URLs, backup contents, artifact contents, raw logs, patch contents,
actual commit ids, tag names, dates, verdicts, counts, conclusions, or evidence
values.

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

- `npm run test:launch-candidate-review-handoff`
- `npm run test:deploy`
