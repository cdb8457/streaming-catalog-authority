# Phase 45 - TorBox live smoke operator plan

Phase 45 adds a static command plan for manually running the Phase 43 TorBox live smoke and Phase 44
saved-report evidence preflight.

```bash
npm run ops:torbox-live-smoke-plan
npm run ops:torbox-live-smoke-plan -- --json
```

The command prints placeholder command shapes only. It does not execute the commands.

## Scope

- Lists the intended operator sequence: readiness metadata preflight, service-status smoke,
  hoster-metadata smoke, optional cache-availability smoke, saved-report preflight, and redacted
  summary retention.
- Uses placeholders such as `<torbox-token-file>`, `<redacted-cache-ref>`, and
  `<phase-43-service-status-report.json>`.
- Keeps `smoke:torbox-readonly` operator-run and absent from CI.
- Documents that retained evidence is fixed statuses, categories, counts, probe names, timestamps,
  and redacted artifact labels only.

## Boundaries

This phase is static and local only. It does not read files, read environment values, read
credentials, execute commands, contact TorBox, construct transports, connect to a database, scan
evidence directories, run Docker, add provider mode, add adapter-factory wiring, download, play
media, schedule jobs, add HTTP, or add UI.

It does not prove live TorBox availability, close live-smoke review, close O4, close O5, or make
`FileCustodian` production KMS.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.
