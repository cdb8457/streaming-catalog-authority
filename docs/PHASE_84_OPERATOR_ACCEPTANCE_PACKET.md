# Phase 84 - Operator Acceptance Packet

Phase 84 turns the Phase 83 launch-gate audit into a copy/paste-safe operator
acceptance packet. It tells the operator what to run, what redaction-safe labels
to retain, and what questions must be answered before a launch-candidate phase.

The packet is intentionally static. It reports `launchReady: false` and
`status: blocked` until O4/O5 are proven or explicitly accepted, Unraid/operator
rehearsal evidence exists, and live TorBox/Jellyfin validation evidence is
reviewed.

## Command

Text packet:

```bash
npm run ops:operator-acceptance-packet
```

JSON packet:

```bash
npm run --silent ops:operator-acceptance-packet -- -- --json
```

## Sections

- Production security decision: O4, O5, FileCustodian boundary, and doctor
  warning interpretation.
- Unraid operator rehearsal: readiness, evidence rehearsal, Phase 82 packet
  acceptance, backup verification, restore rehearsal, and CI.
- Live service validation: TorBox validation, Jellyfin validation, cleanup
  status, and Usenet/fallback decision.
- Launch-candidate decision: independent review, redaction review, and scope
  freeze before a separate launch-candidate phase.

## Redaction Boundary

Retain only statuses, counts, dates, labels, and reviewed conclusions. Never
retain secret values, credential file contents, API keys, tokens, KEKs, DEKs,
private keys, database URLs, secret paths, raw environment dumps, request or
response bodies, provider payloads, raw provider refs, infohashes, magnets,
media titles, server URLs, backup contents, or artifact contents.

## Non-Goals

- No DB reads.
- No evidence file reads.
- No environment or credential reads.
- No network calls or live service contact.
- No provider mode, playback, downloading, scraping, media-server writes,
  frontend framework, API framework, or web UI expansion.
- No launch approval, O4 closure, O5 closure, or production-readiness closure.

## Verification

- `npm run test:operator-acceptance-packet`
- `npm run test:deploy`
