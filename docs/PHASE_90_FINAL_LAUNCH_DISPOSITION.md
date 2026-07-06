# Phase 90 - Final Launch Disposition

Phase 90 combines the final launch-candidate decision path with explicit O4/O5
gate disposition labels. It does not create a launch candidate, approve launch,
approve production readiness, approve a release candidate, close O4, close O5,
inspect evidence, read artifacts, or assign runtime work.

The default disposition is HOLD. A later human operator decision may request a
launch candidate with O4/O5 accepted as deferred risk, but this packet still
does not close O4 or O5.

## Command

Text disposition:

```bash
npm run ops:final-launch-disposition
```

JSON disposition:

```bash
npm run --silent ops:final-launch-disposition -- -- --json
```

The report is `phase-90-final-launch-disposition` with
`FINAL_LAUNCH_DISPOSITION_REPORTED`, `launchDecision: hold`,
`launchApproved: false`, `productionReady: false`,
`releaseCandidateApproved: false`, `closesO4: false`, and `closesO5: false`.

## Required Decision Labels

- `operator-final-decision-label`
- `reviewer-go-or-hold-label`
- `o4-disposition-label`
- `o5-disposition-label`
- `residual-risk-acceptance-label`
- `launch-candidate-target-label`

## O4/O5 Disposition

O4 and O5 remain open gates in this packet.

- O4 disposition label:
  - gate: External custodian / KMS gate
  - default disposition: `hold`
  - `closesGate: false`
  - hold if missing: `o4-live-evidence-label`,
    `o4-reviewer-disposition-label`, `o4-operator-risk-decision-label`
- O5 disposition label:
  - gate: Managed KEK custody and rotation gate
  - default disposition: `hold`
  - `closesGate: false`
  - hold if missing: `o5-custody-evidence-label`,
    `o5-rotation-schedule-label`, `o5-operator-risk-decision-label`

## Final Hold Triggers

- Hold if `operator-final-decision-label` is missing.
- Hold if `reviewer-go-or-hold-label` is `reviewer-hold-label`.
- Hold if O4 or O5 are hidden, softened, or claimed closed.
- Hold if O4 or O5 are accepted as deferred risk without explicit operator
  residual-risk acceptance label.
- Hold if any launch artifact requests secrets, credentials, raw evidence,
  provider payloads, raw refs, media identity, URLs, logs, patch contents, or
  actual evidence values.

## Permitted Operator Decisions

- `hold`
- `launch-candidate-requested-with-o4-o5-deferred-risk-accepted`

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

- `npm run test:final-launch-disposition`
- `npm run test:deploy`
