# Phase 133 - Unraid Production Disposition

Phase 133 adds `ops:unraid-production-disposition`, a redaction-safe disposition gate for one operator-supplied production disposition JSON file.

Run:

```bash
npm run --silent ops:unraid-production-disposition -- -- path/to/unraid-production-disposition.json --json
```

The disposition requires `phase-133-unraid-production-disposition-record`, `phase-132-unraid-switch-evidence-review`, `ready-for-final-production-disposition`, `service-evidence-present`, and a fixed `verdict: GO` or `verdict: HOLD`.

It reports `phase-133-unraid-production-disposition` and can report `ready-for-launch-readiness-decision` when the operator disposition is `GO`.

This is still disposition-only. It keeps `productionReady: false`, `launchApproved: false`, `commandExecution: false`, `scriptGenerated: false`, `mutatesUnraid: false`, `providerContactAllowed: false`, `providerModeEnabled: false`, and FileCustodian remains a hardened reference harness.
