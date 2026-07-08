# Phase 118 - O5 KEK closure gate

Phase 118 adds `ops:o5-kek-closure-gate` as a redaction-safe O5 closure gate preflight. It combines the Phase 30 KEK evidence preflight report and the Phase 117 independent-review verdict report. The emitted report label is `phase-118-o5-kek-closure-gate-preflight`.

```bash
npm run --silent ops:o5-kek-closure-gate -- -- --kek-preflight path/to/phase-30-kek-preflight.redacted.json --verdict path/to/phase-117-o5-kek-review-verdict.redacted.json --json
```

The required source labels are `phase-30-kek-evidence-preflight` and `phase-117-o5-kek-review-verdict-preflight`. When both reports are ready and the reviewer verdict is `GO`, this packet can return `ready-for-final-o5-authorization` and `closure-ready-pending-final-authorization`.

This phase still keeps `inputValuesEchoed: false`, `commandExecution: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `productionReady: false`, `closesO4: false`, and `closesO5: false`.

This phase does not mutate Unraid, install or start a service, contact live services, approve production readiness, close O5, enable provider mode, inspect KEK material, read raw evidence, or expand Docker/Compose/UI/API/provider scope. O4 remains closed/authorized from Phase 116, O5 remains open until final authorization, and FileCustodian remains a hardened reference harness.

