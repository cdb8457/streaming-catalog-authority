# Phase 86 - Launch Candidate Scope Freeze

Phase 86 defines the permitted shape of a future launch-candidate phase after
Phase 85. It is a static scope-freeze packet only.

It does not approve launch, claim production readiness, close O4, close O5,
read evidence, inspect artifacts, contact services, or add runtime behavior.
Its purpose is to make the next phase narrow and reviewable before any launch
candidate branch exists.

## Command

Text packet:

```bash
npm run ops:launch-candidate-scope-freeze
```

JSON packet:

```bash
npm run --silent ops:launch-candidate-scope-freeze -- -- --json
```

The report is `phase-86-launch-candidate-scope-freeze` with
`LAUNCH_CANDIDATE_SCOPE_FREEZE_REPORTED`, `launchApproved: false`,
`productionReady: false`, `closesO4: false`, `closesO5: false`, and
`status: blocked-pending-operator-decision`.

## Required Before Any Launch-Candidate Phase

- Phase 85 launch-decision record is retained and reviewed.
- The next branch is explicitly scope-frozen by a reviewer.
- O4/O5 are proven, blocked, deferred, or explicitly accepted as residual risk
  in operator metadata.
- FileCustodian remains described as a reference harness unless a separate
  production custodian phase proves otherwise.

## Allowed Future Launch-Candidate Work

- Static release-candidate metadata.
- Existing command references only.
- Retained evidence labels, dates, fixed report names, pass/warn/fail counts,
  reviewer verdicts, and reviewed conclusions.
- Redaction-safe packaging that does not include artifact contents, secret
  values, credential paths, provider payloads, raw refs, media identity, URLs, or
  copied logs.

## Forbidden Future Launch-Candidate Work

- No launch approval or production-ready claim.
- No O4/O5 closure without separate reviewed operator evidence or explicit
  residual-risk acceptance.
- No DB reads or writes.
- No schema changes.
- No credential, environment, evidence-content, artifact-content,
  backup-content, provider-payload, raw-ref, URL, or media-identity reads.
- No network calls or live service contact.
- No provider mode, debrid/provider expansion, Plex/Jellyfin media-server
  writes, playback, downloading, scraping, frontend framework, API framework,
  web UI expansion, scheduler, Docker change, or background runtime work.

## Reviewer Required When

- A phase mentions launch, release candidate, production readiness, O4, O5,
  FileCustodian, provider validation, retained evidence, or operator acceptance.
- A diff changes package scripts, ops commands, release docs, README readiness
  wording, or deploy guards.
- A launch-candidate-requested Phase 85 decision record is used as input for any
  later phase.

## Verification

- `npm run test:launch-candidate-scope-freeze`
- `npm run test:deploy`
