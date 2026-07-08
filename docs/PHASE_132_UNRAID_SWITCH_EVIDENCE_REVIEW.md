# Phase 132 - Unraid Switch Evidence Review

Phase 132 adds `ops:unraid-switch-evidence-review`, a redaction-safe review gate for one operator-supplied switch evidence JSON file after an explicit operator switch.

Run:

```bash
npm run --silent ops:unraid-switch-evidence-review -- -- path/to/unraid-switch-evidence.json --json
```

The review requires `phase-132-unraid-switch-evidence-record`, `phase-131-unraid-switch-evidence-capture`, `phase-130-unraid-production-switch-runbook`, redacted pre/post doctor labels, a service status label, a compose status label, and explicit confirmation that raw secrets, raw logs, raw backup contents, provider payloads, and identity values are excluded.

It reports `phase-132-unraid-switch-evidence-review`, `service-evidence-present`, and `ready-for-final-production-disposition` only when all required fixed fields are present.

This is review-only. It keeps `productionReady: false`, `launchApproved: false`, `commandExecution: false`, `scriptGenerated: false`, `mutatesUnraid: false`, `providerContactAllowed: false`, `providerModeEnabled: false`, and FileCustodian remains a hardened reference harness.
