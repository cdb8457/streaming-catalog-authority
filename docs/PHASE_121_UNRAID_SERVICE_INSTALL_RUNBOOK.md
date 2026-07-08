# Phase 121 - Unraid service install runbook

Phase 121 adds `ops:unraid-service-install-runbook` as a redaction-safe draft runbook packet for future Unraid service install review and rollback planning. The emitted report label is `phase-121-unraid-service-install-runbook`.

```bash
npm run --silent ops:unraid-service-install-runbook -- -- --json
```

The packet records `sourceReadinessBundle: phase-120-unraid-operator-readiness-bundle`, `runbookReviewStatus: draft-pending-operator-review`, `o4Status: closed/authorized`, and `o5Status: closed/authorized`.

This phase still keeps `inputValuesEchoed: false`, `commandExecution: false`, `scriptGenerated: false`, `serviceInstallApproved: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `providerModeEnabled: false`, `productionReady: false`, `launchApproved: false`, `closesO4: false`, and `closesO5: false`.

No Unraid command is executed, no shell script is generated, no service is installed or started, no live service is contacted, no provider mode is enabled, no KEK material is inspected, and production readiness remains false. FileCustodian remains a hardened reference harness, not the production KMS.
