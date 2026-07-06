# Phase 88 - Launch Candidate Review Checklist

Phase 88 adds a static checklist for launch-candidate review after Phase 87. It
does not create a launch candidate, approve launch, approve production
readiness, close O4, close O5, inspect evidence, or read artifacts.

The checklist is a redaction-safe list of review rows, source label names, pass
condition labels, hold condition labels, allowed review material, forbidden
material, and explicit non-goals.

## Command

Text checklist:

```bash
npm run ops:launch-candidate-review-checklist
```

JSON checklist:

```bash
npm run --silent ops:launch-candidate-review-checklist -- -- --json
```

The report is `phase-88-launch-candidate-review-checklist` with
`LAUNCH_CANDIDATE_REVIEW_CHECKLIST_REPORTED`,
`launchApproved: false`, `productionReady: false`,
`releaseCandidateApproved: false`, `closesO4: false`, and `closesO5: false`.

## Checklist Rows

- Code target labels:
  - source labels: `commit-id-label`, `tag-name-label`, `phase-number-label`
  - hold labels: `target-label-missing`, `target-label-ambiguous`,
    `unreviewed-diff-label-present`
- Launch packet chain labels:
  - source labels: `phase-85-launch-decision-record.redacted.json`,
    `phase-86-launch-candidate-scope-freeze.redacted.json`,
    `launch-candidate-metadata.redacted.json`
  - hold labels: `packet-label-missing`, `packet-claims-launch-approval`,
    `packet-retains-actual-values`
- O4/O5/FileCustodian labels:
  - source labels: `o4-decision-label`, `o5-decision-label`,
    `filecustodian-boundary-label`
  - hold labels: `o4-hidden-or-softened`, `o5-hidden-or-softened`,
    `filecustodian-claimed-production-kms`
- Operator evidence labels:
  - source labels: `deployment-unraid-label`,
    `backup-restore-retention-label`, `ci-test-expectations-label`,
    `privacy-redaction-label`
  - hold labels: `operator-evidence-label-missing`,
    `raw-artifact-requested`, `secret-path-requested`
- TorBox/Jellyfin/Usenet validation labels:
  - source labels: `torbox-validation-label`, `jellyfin-validation-label`,
    `usenet-fallback-label`
  - hold labels: `provider-payload-label-present`,
    `raw-ref-label-present`, `media-identity-label-present`

## Hold Rules

- HOLD if any row retains actual values instead of fixed label names.
- HOLD if `launchApproved`, `productionReady`, `releaseCandidateApproved`,
  `closesO4`, or `closesO5` is true.
- HOLD if a checklist row requests secrets, credentials, evidence contents,
  artifact contents, raw refs, provider payloads, URLs, or media identity.
- HOLD if the review attempts runtime expansion, provider mode, playback,
  downloading, scraping, media-server writes, frontend framework work, API
  framework work, scheduler work, or Docker changes.

## Allowed Review Material

- Fixed label names.
- Existing package-script command names as references.
- Redacted evidence artifact label names.
- Reviewer question labels.
- Hold condition labels.

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

- `npm run test:launch-candidate-review-checklist`
- `npm run test:deploy`
