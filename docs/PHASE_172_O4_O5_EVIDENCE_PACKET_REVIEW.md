# Phase 172 - O4/O5 Evidence Packet Review

Report id: `phase-172-o4-o5-evidence-packet-review`

Phase 172 adds a local, redaction-safe review command for saved Phase 166 O4/O5 evidence packet JSON
files. It validates the packet envelope only. It does not scan evidence directories, read referenced
artifacts, contact live services, mutate KEKs, start containers, or close O4/O5.

## Usage

```bash
npm run ops:o4-o5-evidence-packet-review -- -- <packet.json>...
npm run ops:o4-o5-evidence-packet-review -- -- --json <packet.json>...
```

The command accepts one or more explicit packet JSON files and optional `--json`.

## Checks

Each file receives a PASS/FAIL summary for:

- `valid JSON`;
- `schema` completeness for the Phase 166 packet envelope;
- `open-gates`, requiring `O4 remains open`, `O5 remains open`, and `closureRequested: false`;
- `forbidden-boundary`, requiring no provider contact, no scraping, no downloading, and no playback;
- `redaction`, rejecting secret-looking values, raw paths, URLs, database URLs, key material, and
  oversized raw evidence strings.

Any failed file returns a nonzero exit code.

## Boundary

The command reads only the packet files explicitly provided by the operator. It does not read
descriptor files named inside the packet, scan artifact directories, inspect logs, inspect backups,
inspect key files, connect to the database, call the network, run Docker, invoke age, contact a
custodian/KMS/secret store, or access provider/debrid/Plex/Jellyfin services.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.

Still forbidden: no provider contact, no scraping, no downloading, no playback, no Real-Debrid live
mode, no TorBox live provider mode, no Plex/Jellyfin mutation, and no media-server library writes.

