# Phase 137 - Unraid Post-Switch Evidence Review

Phase 137 adds `ops:unraid-post-switch-evidence-review`, a redaction-safe review gate for the live Unraid production switch evidence.

```bash
npm run --silent ops:unraid-post-switch-evidence-review -- -- path/to/post-switch-evidence.redacted.json --json
```

The input must identify `phase-136-unraid-production-switch-execution-packet`, `ready-for-real-unraid-production-switch`, the approved deployed commit `7e2db7c8b6b9ac68272e01ee51e6c63399fc0ef3`, a healthy `repo-postgres-1` service, no published ports, `APP_ENV=production`, `custodian mode=file`, and a post-switch doctor summary of 12 pass, 2 warn, and 0 fail.

The output reports `phase-137-unraid-post-switch-evidence-review`. A passing review reports `service-running-with-open-hardening-warnings`, `serviceInstalled: true`, `serviceStarted: true`, and `launchApproved: true` while keeping `productionReady: false`, `commandExecution: false`, `scriptGenerated: false`, `mutatesUnraid: false`, `providerContactAllowed: false`, and `providerModeEnabled: false`.

The two expected warnings are explicit: `o4Status: open-warning` and `o5Status: open-warning`. FileCustodian remains a hardened reference harness, not production KMS.
