# Phase 124 - Unraid install evidence manifest

Phase 124 adds `ops:unraid-install-evidence-manifest` as a redaction-safe evidence manifest for the future operator-run install window authorized by Phase 123. The emitted report label is `phase-124-unraid-install-evidence-manifest`.

```bash
npm run --silent ops:unraid-install-evidence-manifest -- -- --json
```

The packet records `sourceInstallAuthorization: phase-123-unraid-service-install-authorization`, `evidenceManifestStatus: ready-for-operator-capture`, and `serviceInstallApproved: true`.

This phase still keeps `inputValuesEchoed: false`, `commandExecution: false`, `scriptGenerated: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `providerModeEnabled: false`, `productionReady: false`, `launchApproved: false`, `closesO4: false`, and `closesO5: false`.

No Unraid command is executed, no shell script is generated, no service is installed or started by this packet, no live service is contacted, no provider mode is enabled, no KEK material is inspected, and production readiness remains false. FileCustodian remains a hardened reference harness, not the production KMS.
