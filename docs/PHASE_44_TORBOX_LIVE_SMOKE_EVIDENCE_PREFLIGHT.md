# Phase 44 - TorBox live smoke evidence preflight

Phase 44 adds a local verifier for a saved Phase 43 `smoke:torbox-readonly -- --live-transport
--json` report. It helps an operator or reviewer check that the retained evidence has the expected
redaction-safe shape before sharing or archiving it.

```bash
npm run ops:torbox-live-smoke-evidence-preflight -- -- <phase-43-report.json>
npm run ops:torbox-live-smoke-evidence-preflight -- -- <phase-43-report.json> --json
```

## Scope

- Reads exactly one operator-supplied JSON file.
- Verifies the Phase 43 report name, phase, command, live smoke flags, probe/operation/category
  allowlists, evidence counts, scoped-ref marker, credential-file marker, and notes shape.
- Emits only fixed finding codes, fixed messages, summary counts, and open gate statuses.
- Does not echo evidence values, file paths, raw refs, endpoint URLs, provider payloads, or secrets.

## Boundaries

This preflight does not contact TorBox, construct a transport, attach `globalThis.fetch`, read a
credential file, read environment variables, connect to a database, scan directories, run Docker,
install SDKs, enable provider mode, add adapter-factory wiring, download, or play media.

Passing this preflight means only that a saved Phase 43 report has the expected redaction-safe shape.
It does not prove TorBox availability, close live-smoke review, close O4, close O5, or make
`FileCustodian` production KMS.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.
