# Phase 116 - Sidecar Unraid O4 final authorization

Phase 116 adds `ops:sidecar-unraid-o4-final-authorization` as a redaction-safe final authorization record for O4 only. It consumes the Phase 115 O4 closure gate preflight, labeled `phase-115-sidecar-unraid-o4-closure-gate-preflight`, and one explicit authorization record. The emitted report label is `phase-116-sidecar-unraid-o4-final-authorization`.

```bash
npm run --silent ops:sidecar-unraid-o4-final-authorization -- -- --closure-gate path/to/phase-115-o4-closure-gate.redacted.json --authorization path/to/phase-116-o4-authorization.redacted.json --json
```

The authorization record must use `record: phase-116-sidecar-unraid-o4-final-authorization-record`, `authorizesO4Closure: true`, and `scope: o4-managed-custodian-boundary-only`. When the Phase 115 report is ready and the authorization record is fixed-scope, this packet returns `authorizationStatus: o4-authorized`, `o4Status: closed/authorized`, and an enabled O4 closure flag.

This phase still keeps `inputValuesEchoed: false`, `commandExecution: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `productionReady: false`, and `closesO5: false`.

No Unraid command is executed, no service is installed or started, no live service is contacted, no provider mode is enabled, and O5 remains open/deferred. FileCustodian remains a hardened reference harness, not the production KMS.
