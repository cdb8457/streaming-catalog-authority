# Phase 58 - Provider Availability Summary CLI

Phase 58 adds an operator command for aggregating explicit sanitized provider availability bridge
report JSON files into the Phase 57 count-only summary.

```bash
npm run --silent ops:provider-availability-summary -- -- <bridge-report.json>... --json
```

The command reads only files named on the command line. It does not scan directories, read provider
credentials, call providers, inspect the database, or execute planned actions.

## Scope

Included:

- explicit bridge-report JSON file inputs only;
- bounded file reads;
- fixed count-only Phase 57 summary output;
- fail-closed handling for missing, malformed, directory, and oversized inputs;
- no path, raw ref, provider detail, credential, URL, item, media identity, or payload echo.

Not included:

- no live TorBox contact;
- no provider transport construction;
- no env reads or credential reads;
- no database access or event-log persistence;
- no downloads, playback, scheduler, HTTP service, UI, scraping, provider writes, or CI live-network
  requirement.

This phase does not enable provider mode, close O4, or close O5. O4 and O5 remain open/deferred, and
`FileCustodian` remains a hardened reference harness rather than production KMS.
