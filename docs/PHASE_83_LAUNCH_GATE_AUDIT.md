# Phase 83 - Launch Gate Audit for Steps 1-3

Phase 83 adds a static, redaction-safe audit for the first three launch work
areas:

1. Production security gates.
2. Operator launch rehearsal.
3. Real service validation.

The audit is intentionally conservative. It reports `launchReady: false` and
`status: blocked` because O4, O5, real Unraid evidence, TorBox live smoke
evidence, and Jellyfin validation evidence are still operator-provided.

## Command

Text report:

```bash
npm run ops:launch-gate-audit
```

JSON report:

```bash
npm run --silent ops:launch-gate-audit -- -- --json
```

## What The Audit Does

- Lists the remaining launch requirements for O4 and O5.
- Lists copy/paste-safe command shapes for operator rehearsal.
- Lists TorBox and Jellyfin live-validation evidence steps.
- Keeps evidence labels, statuses, counts, and reviewed conclusions separate
  from secret material.
- Keeps FileCustodian documented as a hardened reference harness only.
- FileCustodian remains a hardened reference harness only, not production KMS.

## What The Audit Does Not Do

- It does not close O4 or O5.
- It does not read descriptors, evidence files, backups, environment values, or
  credential files.
- It does not connect to databases, TorBox, Jellyfin, Real-Debrid, Plex,
  Usenet, custodians, KMS, cloud services, Docker, or live packet sources.
- It does not add provider mode, playback, downloading, scraping, frontend
  framework, API framework, or web UI behavior.
- It does not approve launch.

## Required Operator Evidence Before Launch

Production security gates:

- O4 external/managed production custodian evidence must be reviewed and
  accepted, or Clint must explicitly accept the residual risk.
- O5 managed KEK custody plus rotation/scheduling evidence must be reviewed and
  accepted, or Clint must explicitly accept the residual risk.

Operator launch rehearsal:

- Run readiness/evidence rehearsal on the intended operator environment.
- Run backup verification and restore rehearsal against a throwaway target.
- Run `ops:doctor -- --json` and preserve O4/O5 WARN interpretation.
- Run the Phase 82 operator UI auth packet acceptance command.

Real service validation:

- Run TorBox live smoke only with explicit credential-file handling and retain
  redaction-safe reports.
- Run Jellyfin read-only and optional write smoke on the target server and
  record cleanup status only.
- Decide whether Usenet/fallback adapters are launch-blocking or future work.

## Verification

- `npm run test:launch-gate-audit`
- `npm run test:deploy`
