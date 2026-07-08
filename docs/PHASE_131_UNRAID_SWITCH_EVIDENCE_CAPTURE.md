# Phase 131 - Unraid Switch Evidence Capture

Phase 131 adds `ops:unraid-switch-evidence-capture`, a redaction-safe packet describing the evidence that must be captured after an explicit operator production switch.

Run:

```bash
npm run --silent ops:unraid-switch-evidence-capture -- --json
```

The packet reports `phase-131-unraid-switch-evidence-capture`, points back to `phase-130-unraid-production-switch-runbook`, requires `ready-for-explicit-operator-window`, reports `ready-for-operator-capture-after-switch`, references `phase-129-unraid-final-human-approval-record-preflight`, references `unraid-live-operating-test-2026-07-08.redacted.md`, and uses `docker-compose.unraid-bind.yml`.

This is still capture planning only. It keeps `productionReady: false`, `launchApproved: false`, `commandExecution: false`, `scriptGenerated: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `providerModeEnabled: false`, and FileCustodian remains a hardened reference harness.

Required evidence labels after the operator switch:

- `pre-switch-doctor-redacted-json`
- `operator-switch-command-label`
- `service-status-after-switch-label`
- `post-switch-doctor-redacted-json`
- `compose-ps-after-switch-label`
- `rollback-status-label-if-used`

Forbidden evidence:

- raw secret files
- database URL values
- passphrases, KEKs, or DEKs
- provider credentials or provider payloads
- raw backup artifact contents
- title or user-content identity values
