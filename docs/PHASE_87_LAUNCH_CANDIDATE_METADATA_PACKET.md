# Phase 87 - Launch Candidate Metadata Packet

Phase 87 adds a static packet for assembling launch-candidate review metadata
after Phase 86. It does not create a launch candidate, approve launch, approve
production readiness, close O4, close O5, or inspect evidence.

The packet is a redaction-safe checklist of retained labels, command references,
review questions, and forbidden material. It is meant to make the final launch
candidate review boring and auditable without adding runtime behavior.

## Command

Text packet:

```bash
npm run ops:launch-candidate-metadata-packet
```

JSON packet:

```bash
npm run --silent ops:launch-candidate-metadata-packet -- -- --json
```

The report is `phase-87-launch-candidate-metadata-packet` with
`LAUNCH_CANDIDATE_METADATA_PACKET_REPORTED`, `launchApproved: false`,
`productionReady: false`, `releaseCandidateApproved: false`, `closesO4: false`,
and `closesO5: false`.

## Required Retained Labels

- `launch-candidate-commit-and-tag-target.redacted.md`
- `phase-85-launch-decision-record.redacted.json`
- `phase-86-launch-candidate-scope-freeze.redacted.json`
- `02-external-custodian-o4.redacted.md`
- `03-kek-rotation-o5.redacted.md`
- `05-doctor-warning-gates.redacted.json`
- `01-deployment-unraid.redacted.md`
- `04-backup-restore-retention.redacted.md`
- `08-ci-test-expectations.redacted.md`
- `09-privacy-redaction.redacted.md`
- `torbox-live-validation.redacted.json`
- `torbox-live-validation-summary.redacted.json`
- `07-jellyfin-validation.redacted.md`
- `usenet-fallback-decision.redacted.md`

## Allowed Metadata

- Fixed label names only, such as `commit-id-label`, `tag-name-label`,
  `report-name-label`, `phase-number-label`, `reviewer-verdict-label`, and
  `pass-warn-fail-count-label`.
- Existing package-script command names as references only.
- Fixed O4/O5 decision label names only, such as `o4-decision-label` and
  `o5-decision-label`.
- Fixed evidence artifact label names only.

Do not retain the actual commit id, tag name, report date, reviewer verdict,
pass/warn/fail count, operator conclusion, or evidence value in this packet.

## Forbidden Material

Do not retain secret values, credential contents, credential paths, API keys,
tokens, KEKs, DEKs, wrapping keys, private keys, completion secrets, database
URLs, raw environment dumps, request or response bodies, provider payloads, raw
provider refs, infohashes, magnet links, media titles, user library identity,
server URLs, backup contents, artifact contents, raw logs, or patch contents.

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

- `npm run test:launch-candidate-metadata-packet`
- `npm run test:deploy`
