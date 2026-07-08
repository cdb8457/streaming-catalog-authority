# Phase 115 - Sidecar Unraid O4 Closure Gate Preflight

Phase 115 adds `ops:sidecar-unraid-o4-closure-gate` as a redaction-safe O4 closure gate preflight. It combines the Phase 113 boundary preflight report and the Phase 114 independent-review verdict report. The emitted report label is `phase-115-sidecar-unraid-o4-closure-gate-preflight`.

The command is:

```bash
npm run --silent ops:sidecar-unraid-o4-closure-gate -- -- --boundary path/to/phase-113-boundary-preflight.redacted.json --verdict path/to/phase-114-review-verdict.redacted.json --json
```

The required source labels are `phase-113-sidecar-unraid-custodian-boundary-preflight` and `phase-114-sidecar-unraid-custodian-review-verdict-preflight`. When both reports are ready and the reviewer verdict is `GO`, this packet can return `ready-for-final-o4-authorization` and `closure-ready-pending-final-authorization`.

This phase still keeps `inputValuesEchoed: false`, `commandExecution: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `productionReady: false`, `closesO4: false`, and `closesO5: false`.

This phase does not mutate Unraid, install or start a service, contact live services, approve production readiness, close O4/O5, enable provider mode, read raw evidence, or expand Docker/Compose/UI/API/provider scope. O5 remains open/deferred and FileCustodian remains a hardened reference harness.
