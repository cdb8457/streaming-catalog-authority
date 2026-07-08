# Phases 125-127 - Unraid production gates

Phases 125 through 127 add the final redaction-safe gate chain after the Phase 124 install evidence manifest.

- Phase 125 emits `phase-125-unraid-install-evidence-capture-gate` and checks a redacted evidence capture record.
- Phase 126 emits `phase-126-unraid-post-install-validation-review` and checks a redacted post-install review record.
- Phase 127 emits `phase-127-unraid-production-readiness-decision` and checks a redacted production-readiness decision record.

Commands:

```bash
npm run --silent ops:unraid-install-evidence-capture-gate -- -- --manifest path/to/phase-124-manifest.redacted.json --evidence path/to/phase-125-evidence.redacted.json --json
npm run --silent ops:unraid-post-install-validation-review -- -- --evidence-gate path/to/phase-125-gate.redacted.json --review path/to/phase-126-review.redacted.json --json
npm run --silent ops:unraid-production-readiness-decision -- -- --validation-review path/to/phase-126-review.redacted.json --decision path/to/phase-127-decision.redacted.json --json
```

The final Phase 127 status can become `ready-for-final-human-production-approval`, but this phase still keeps `productionReady: false`, `launchApproved: false`, `commandExecution: false`, `scriptGenerated: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, and `providerModeEnabled: false`.

No Unraid command is executed, no shell script is generated, no service is installed or started by these packets, no live service is contacted, no provider mode is enabled, no KEK material is inspected, and production readiness remains false. FileCustodian remains a hardened reference harness, not the production KMS.
