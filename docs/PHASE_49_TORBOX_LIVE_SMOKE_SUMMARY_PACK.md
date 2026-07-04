# Phase 49 - TorBox Live Smoke Summary Pack

Phase 49 adds a local, redaction-safe summary command for Phase 43 TorBox live-smoke reports.

The command reads explicit operator-supplied Phase 43 JSON reports, validates each report with the
Phase 44 preflight rules, and emits a summary containing only fixed labels, counts, probe names,
operations, categories, and review readiness.

```bash
npm run --silent ops:torbox-live-smoke-summary-pack -- -- <phase-43-report.json>... --json
```

## Scope

Included:

- explicit file inputs only;
- no directory scanning;
- Phase 44 shape validation for each supplied report;
- aggregate pass/warn/fail counts;
- per-probe fixed labels: probe, operation, category, readiness, and safe counts;
- JSON and text output modes.

Not included:

- no credential values;
- no credential file paths;
- no raw refs, infohashes, digests, URLs, headers, cookies, account details, media titles, item ids,
  endpoint URLs, provider payloads, or response bodies;
- no live TorBox calls;
- no env reads;
- no database access;
- no command execution other than the summary command itself;
- no transport construction;
- no downloads, playback, scheduler, HTTP, UI, or provider writes.

This summary does not close live-smoke review. O4 and O5 remain open/deferred, and `FileCustodian`
remains a hardened reference harness rather than production KMS.
