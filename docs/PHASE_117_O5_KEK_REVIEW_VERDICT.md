# Phase 117 - O5 KEK review verdict

Phase 117 adds `ops:o5-kek-review-verdict` as a redaction-safe independent-review verdict preflight for O5 managed KEK custody evidence. It consumes the Phase 30 KEK evidence preflight result label and one explicit `single-redacted-o5-kek-review-verdict-json-file` reviewer verdict record. The emitted report label is `phase-117-o5-kek-review-verdict-preflight`.

```bash
npm run --silent ops:o5-kek-review-verdict -- -- path/to/o5-kek-review-verdict.redacted.json --json
```

The verdict record must use `report: phase-117-o5-kek-review-verdict`, `sourceKekPreflight: phase-30-kek-evidence-preflight`, and `kekPreflight: ready-for-review`. The verdict must be one fixed value: `GO`, `HOLD`, or `REJECTED`. A `GO` verdict can make the packet `ready-for-o5-closure-gate`, but this phase still keeps `productionReady: false`, `closesO4: false`, and `closesO5: false`.

This phase does not mutate Unraid, install or start a service, contact live services, approve production readiness, close O5, enable provider mode, read raw evidence, inspect KEK material, or expand Docker/Compose/UI/API/provider scope. O4 remains closed/authorized from Phase 116, O5 remains open/deferred, and FileCustodian remains a hardened reference harness.
