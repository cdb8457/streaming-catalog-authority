# Phase 51 - TorBox Live Smoke Review Gate

Phase 51 adds a local, redaction-safe review gate for a Phase 49 TorBox live-smoke summary pack.

The command reads one explicit Phase 49 summary JSON file and verifies that the required
`service-status` and `hoster-metadata` reports are present exactly once and ready for review. The
`cache-availability` report remains optional and, when present, must also be ready.

```bash
npm run --silent ops:torbox-live-smoke-review-gate -- -- <phase-49-summary-pack.json> --json
```

## Scope

Included:

- one explicit Phase 49 summary-pack input file only;
- fixed metadata checks for the Phase 49 redaction flags;
- required service-status and hoster-metadata probe readiness checks;
- optional cache-availability readiness checks;
- fixed JSON and text output modes.

Not included:

- no credential values;
- no credential file paths;
- no raw refs, infohashes, digests, URLs, headers, cookies, account details, media titles, item ids,
  endpoint URLs, provider payloads, or response bodies;
- no live TorBox calls;
- no env reads;
- no database access;
- no command execution other than the review-gate command itself;
- no transport construction;
- no downloads, playback, scheduler, HTTP, UI, or provider writes.

This gate prepares live-smoke review but does not close live-smoke review. O4 and O5 remain open/deferred, and `FileCustodian` remains a hardened reference harness rather than production KMS.
