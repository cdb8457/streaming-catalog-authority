# Phase 122 - Unraid service runbook approval gate

Phase 122 adds `ops:unraid-service-runbook-approval-gate` as a redaction-safe approval gate over the Phase 121 draft runbook, labeled `phase-121-unraid-service-install-runbook`, and one explicit redacted review record. The emitted report label is `phase-122-unraid-service-runbook-approval-gate`.

```bash
npm run --silent ops:unraid-service-runbook-approval-gate -- -- --runbook path/to/phase-121-runbook.redacted.json --review path/to/phase-122-review.redacted.json --json
```

The review record must use `record: phase-122-unraid-service-runbook-approval-record`, `verdict: GO`, and `scope: unraid-service-runbook-review-only`. A valid GO review can return `runbookApprovalStatus: ready-for-future-install-authorization` and `readyForInstallAuthorization: true`.

This phase still keeps `inputValuesEchoed: false`, `rawReviewerNotesIncluded: false`, `commandExecution: false`, `scriptGenerated: false`, `serviceInstallApproved: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `providerModeEnabled: false`, `productionReady: false`, `launchApproved: false`, `closesO4: false`, and `closesO5: false`.

No Unraid command is executed, no shell script is generated, no service is installed or started, no live service is contacted, no provider mode is enabled, no KEK material is inspected, and production readiness remains false. FileCustodian remains a hardened reference harness, not the production KMS.
