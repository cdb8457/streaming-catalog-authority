# Phase 123 - Unraid service install authorization

Phase 123 adds `ops:unraid-service-install-authorization` as a redaction-safe final authorization record over the Phase 122 approval gate, labeled `phase-122-unraid-service-runbook-approval-gate`, and one explicit authorization record. The emitted report label is `phase-123-unraid-service-install-authorization`.

```bash
npm run --silent ops:unraid-service-install-authorization -- -- --approval-gate path/to/phase-122-approval-gate.redacted.json --authorization path/to/phase-123-install-authorization.redacted.json --json
```

The authorization record must use `record: phase-123-unraid-service-install-authorization-record`, `authorizesServiceInstallWindow: true`, and `scope: unraid-service-install-window-only`. A valid authorization can return `installAuthorizationStatus: install-window-authorized` and `serviceInstallApproved: true`.

This phase still keeps `inputValuesEchoed: false`, `rawAuthorizationNotesIncluded: false`, `commandExecution: false`, `scriptGenerated: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `providerModeEnabled: false`, `productionReady: false`, `launchApproved: false`, `closesO4: false`, and `closesO5: false`.

No Unraid command is executed, no shell script is generated, no service is installed or started, no live service is contacted, no provider mode is enabled, no KEK material is inspected, and production readiness remains false. FileCustodian remains a hardened reference harness, not the production KMS.
