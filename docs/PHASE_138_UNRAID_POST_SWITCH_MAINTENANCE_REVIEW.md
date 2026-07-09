# Phase 138 - Unraid Post-Switch Maintenance Review

Phase 138 adds `ops:unraid-post-switch-maintenance-review`, a redaction-safe review gate for post-switch maintenance evidence after the live Unraid service start.

```bash
npm run --silent ops:unraid-post-switch-maintenance-review -- -- path/to/post-switch-maintenance.redacted.json --json
```

The input must identify `phase-137-unraid-post-switch-evidence-review`, `service-running-with-open-hardening-warnings`, patched User Scripts that preserve the persistent `repo-postgres-1` service, completed doctor/backup-verify/KEK-plan scripts, zero plaintext backup candidates, no published ports, and healthy service state after maintenance.

The output reports `phase-138-unraid-post-switch-maintenance-review`. A passing review reports `post-switch-maintenance-evidence-accepted`, `serviceInstalled: true`, `serviceStarted: true`, and `launchApproved: true` while keeping `productionReady: false`, `commandExecution: false`, `scriptGenerated: false`, `mutatesUnraid: false`, `providerContactAllowed: false`, and `providerModeEnabled: false`.

O4 and O5 remain explicit warnings. FileCustodian remains a hardened reference harness, not production KMS.
