# Phase 52 - TorBox Live Smoke Operator Packet

Phase 52 adds a static operator packet that ties the existing TorBox live-smoke commands into one
run/save/review workflow.

The fixed report id is `phase-52-torbox-live-smoke-operator-packet`.

```bash
npm run ops:torbox-live-smoke-operator-packet
npm run ops:torbox-live-smoke-operator-packet -- -- --json
```

The command prints placeholder command shapes only. It does not execute the commands.

## Scope

Included:

- Phase 43 live-smoke command shapes for required `service-status` and `hoster-metadata` probes;
- optional Phase 43 `cache-availability` command shape;
- Phase 44 saved-report preflight command shapes;
- Phase 49 summary-pack command shapes for required-only and required-plus-cache packets;
- Phase 51 review-gate command shape;
- redacted artifact retention labels and independent-review reminders.

Not included:

- no credential values;
- no credential file paths;
- no raw refs, infohashes, digests, URLs, headers, cookies, account details, item ids, media titles,
  endpoint URLs, provider payloads, response bodies, parse snippets, or debug logs;
- no live TorBox calls from the packet command;
- no env reads;
- no file reads;
- no database access;
- no command execution from the packet command;
- no transport construction;
- no directory scanning;
- no downloads, playback, scheduler, HTTP, UI, provider writes, adapter-factory live wiring, or CI
  live-network requirement.

The packet keeps the Phase 51 requirements explicit: `service-status` and `hoster-metadata` are
required, `cache-availability` is optional, and independent review is still required.

This packet does not close live-smoke review. O4 and O5 remain open/deferred, and `FileCustodian`
remains a hardened reference harness rather than production KMS.
