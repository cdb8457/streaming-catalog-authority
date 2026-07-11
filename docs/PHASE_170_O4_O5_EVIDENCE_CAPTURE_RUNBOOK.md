# Phase 170 - O4/O5 Evidence Capture Runbook

Report id: `phase-170-o4-o5-evidence-capture-runbook`

Phase 170 defines the manual operator capture flow for O4/O5 evidence. It is a runbook only: it does
not install a service, change Docker Compose, contact live providers, mutate KEKs, or close O4/O5.

## Capture Directory

Use a redacted evidence directory such as:

```bash
/mnt/user/appdata/catalog/backups/evidence/o4-o5
```

The directory should contain redacted descriptor inputs, redacted command outputs, and the Phase 166
packet index. It must not contain raw secret values, raw logs, media identity, provider refs, key
material, database URLs, backup bodies, or secret file contents.

## Command Sequence

Run from the repository directory:

```bash
npm run ops:custodian-evidence-preflight -- -- <o4-descriptor.json> --json
npm run ops:kek-evidence-preflight -- -- <o5-descriptor.json> --json
npm run ops:o4-o5-evidence-decision -- -- --decision <decision.json> --custodian <o4-descriptor.json> --kek <o5-descriptor.json> --json
npm run ops:rewrap-kek -- --plan --json
```

For Unraid, run inside the existing `ops` service through the canonical launcher or runtime compose
pattern. Keep output redacted before retention.

## Retained Artifact Labels

Suggested labels:

- `o4-custodian-preflight-redacted`;
- `o5-kek-preflight-redacted`;
- `o4-o5-decision-packet-redacted`;
- `kek-rewrap-plan-redacted`;
- `phase-166-evidence-packet-redacted`.

Labels are not paths, URLs, secret names, media titles, provider refs, or raw command output.

## Operator Checks

- Confirm each artifact is redaction-safe before retention.
- Confirm O4/O5 outputs say the gates remain open.
- Confirm `ops:rewrap-kek -- --plan --json` was planning-only.
- Confirm no provider contact, no scraping, no downloading, and no playback occurred.
- Confirm no Plex, Jellyfin, or media-server mutation occurred.

## Gate Semantics

O4 remains open. O5 remains open. This runbook does not close O4 and does not close O5.

