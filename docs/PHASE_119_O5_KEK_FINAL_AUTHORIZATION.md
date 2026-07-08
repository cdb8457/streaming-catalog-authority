# Phase 119 - O5 KEK final authorization

Phase 119 adds `ops:o5-kek-final-authorization` as a redaction-safe final authorization record for O5 only. It consumes the Phase 118 O5 closure gate preflight, labeled `phase-118-o5-kek-closure-gate-preflight`, and one explicit authorization record. The emitted report label is `phase-119-o5-kek-final-authorization`.

```bash
npm run --silent ops:o5-kek-final-authorization -- -- --closure-gate path/to/phase-118-o5-kek-closure-gate.redacted.json --authorization path/to/phase-119-o5-authorization.redacted.json --json
```

The authorization record must use `record: phase-119-o5-kek-final-authorization-record`, `authorizesO5Closure: true`, and `scope: o5-managed-kek-custody-only`. When the Phase 118 report is ready and the authorization record is fixed-scope, this packet returns `authorizationStatus: o5-authorized`, `o5Status: closed/authorized`, and an enabled O5 closure flag.

This phase still keeps `inputValuesEchoed: false`, `commandExecution: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `productionReady: false`, and `closesO4: false`.

No Unraid command is executed, no service is installed or started, no live service is contacted, no provider mode is enabled, no KEK material is inspected, and production readiness remains false. FileCustodian remains a hardened reference harness, not the production KMS.

