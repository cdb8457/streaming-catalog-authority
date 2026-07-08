# Phase 120 - Unraid operator readiness bundle

Phase 120 adds `ops:unraid-operator-readiness-bundle` as a redaction-safe planning packet that summarizes the now-authorized O4 and O5 evidence for Unraid deployment planning. The emitted report label is `phase-120-unraid-operator-readiness-bundle`.

```bash
npm run --silent ops:unraid-operator-readiness-bundle -- -- --json
```

The packet records `sourceO4Authorization: phase-116-sidecar-unraid-o4-final-authorization`, `sourceO5Authorization: phase-119-o5-kek-final-authorization`, `o4Status: closed/authorized`, and `o5Status: closed/authorized`.

This phase still keeps `inputValuesEchoed: false`, `commandExecution: false`, `serviceInstallApproved: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `providerModeEnabled: false`, `productionReady: false`, `launchApproved: false`, `closesO4: false`, and `closesO5: false`.

No Unraid command is executed, no service is installed or started, no live service is contacted, no provider mode is enabled, no KEK material is inspected, and production readiness remains false. FileCustodian remains a hardened reference harness, not the production KMS.
