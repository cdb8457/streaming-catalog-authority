# Phase 139 - Unraid Restart Persistence Review

Phase 139 adds `ops:unraid-restart-persistence-review`, a redaction-safe review gate for restart evidence after the live Unraid service has been switched on and post-switch maintenance has passed.

```bash
npm run --silent ops:unraid-restart-persistence-review -- -- path/to/restart-persistence.redacted.json --json
```

The input must identify `phase-138-unraid-post-switch-maintenance-review`, `post-switch-maintenance-evidence-accepted`, deployed commit `8ddf3f3`, a Compose-level restart of `repo-postgres-1`, healthy service state before and after restart, post-restart doctor `ok: true`, schema version 3, persisted completion-secret match, and custodian reachability after restart.

The output reports `phase-139-unraid-restart-persistence-review`. A passing review reports `restart-persistence-evidence-accepted`, `serviceInstalled: true`, `serviceStarted: true`, and `launchApproved: true` while keeping `serverRebooted: false`, `productionReady: false`, `commandExecution: false`, `scriptGenerated: false`, `mutatesUnraid: false`, `providerContactAllowed: false`, and `providerModeEnabled: false`.

O4 and O5 remain explicit warnings. FileCustodian remains a hardened reference harness, not production KMS.
