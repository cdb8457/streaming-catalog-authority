# Phase 130 - Unraid Production Switch Runbook

Phase 130 adds `ops:unraid-production-switch-runbook`, a redaction-safe runbook packet for the explicit operator production switch window.

The command consumes one Phase 129 preflight JSON file with `report: phase-129-unraid-final-human-approval-record-preflight`, `approvalRecordStatus: ready-for-operator-production-switch`, and `verdict: GO`. It also requires the retained live evidence note `unraid-live-operating-test-2026-07-08.redacted.md`.

Run:

```bash
npm run --silent ops:unraid-production-switch-runbook -- -- path/to/phase-129-preflight.json --json
```

The packet reports `phase-130-unraid-production-switch-runbook`, uses `docker-compose.unraid-bind.yml`, and can report `switchReadiness: ready-for-explicit-operator-window`.

This is still a runbook/preflight only. It keeps `productionReady: false`, `launchApproved: false`, `commandExecution: false`, `scriptGenerated: false`, `serviceInstalled: false`, `serviceStarted: false`, `providerContactAllowed: false`, `providerModeEnabled: false`, and FileCustodian remains a hardened reference harness.

The documented operator command plan includes:

- preflight doctor: `docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml run --rm ops ops:doctor -- --json`
- install/start: operator-run-only from the approved Unraid service script packet
- post-start doctor: `docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml run --rm ops ops:doctor -- --json`
- rollback: operator-run-only stop/disable persistent service, then `docker compose down --remove-orphans`
- cleanup check: `docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml ps -a`

Non-goals:

- No automatic Unraid mutation.
- No service installation or service start by repo code.
- No provider contact or provider mode.
- No launch approval.
- No raw note, secret, DB URL, passphrase, KEK, DEK, provider token, title, raw log, or backup content echoing.
