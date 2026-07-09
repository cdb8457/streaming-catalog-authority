# Phase 136 - Unraid Production Switch Execution Packet

Phase 136 adds `ops:unraid-production-switch-execution-packet`, a redaction-safe final execution packet for one Phase 135 final launch approval record.

```bash
npm run --silent ops:unraid-production-switch-execution-packet -- -- path/to/phase-135-final-launch-approval.json --json
```

The input must be `phase-135-unraid-final-launch-approval-record`, carry `ready-for-production-switch-execution-packet`, keep the Phase 134 source reference, and set `launchApproved: true`.

The report is `phase-136-unraid-production-switch-execution-packet`. A passing packet reports `ready-for-real-unraid-production-switch` and includes the operator command/evidence plan while keeping `commandExecution: false`, `scriptGenerated: false`, `mutatesUnraid: false`, `serviceInstalled: false`, `serviceStarted: false`, `productionReady: false`, `providerContactAllowed: false`, and `providerModeEnabled: false`.

FileCustodian remains a hardened reference harness, not production KMS. This phase gets the project into position for the real Unraid production switch; it does not perform the switch.
