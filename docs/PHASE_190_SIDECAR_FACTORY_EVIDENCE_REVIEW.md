# Phase 190 - Sidecar Factory Evidence Review

Report id: `phase-190-sidecar-factory-evidence-review`

Phase 190 adds `ops:sidecar-factory-evidence-review`, a static review command for saved Phase 189
JSON evidence files. It checks valid JSON, required Phase 189 evidence fields, overall pass state,
the local non-mutating boundary, and redaction-safe labels.

## Command

```bash
npm run ops:sidecar-factory-evidence-review -- -- --json <phase-189-evidence.json>
```

The command exits nonzero if any reviewed file fails.

## Required Evidence

The review requires:

- `report: phase-189-sidecar-factory-evidence`
- `code: SIDECAR_FACTORY_EVIDENCE`
- `ok: true`
- `daemonWrapperExercised: true`
- `custodianFactorySidecarModeExercised: true`
- `localSocketOnly: true`
- `appHeldCompletionSecretRequired: false`
- `appHeldKekRequired: false`
- `serviceInstallAllowed: false`
- `composeChangeAllowed: false`
- `runtimeCutoverAllowed: false`
- `providerContactAllowed: false`
- `playbackAllowed: false`
- `mediaServerMutationAllowed: false`
- `closesO4: false`
- `closesO5: false`
- every required Phase 189 check status is `pass`

## Boundary

Allowed in this phase:

- read saved Phase 189 JSON evidence files;
- print PASS/FAIL summaries;
- return a nonzero exit code on failed evidence.

Forbidden in this phase:

- starting the sidecar daemon;
- installing a service;
- changing Compose;
- switching runtime custody;
- closing O4;
- closing O5;
- provider contact;
- scraping;
- downloading;
- playback;
- Plex/Jellyfin mutation.

## Review Status

Recommended next status: `ready-for-sidecar-factory-evidence-review-record`.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.
