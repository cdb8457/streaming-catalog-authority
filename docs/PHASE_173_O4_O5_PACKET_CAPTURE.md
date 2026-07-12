# Phase 173 - O4/O5 Packet Capture

Report id: `phase-173-o4-o5-packet-capture`

Phase 173 adds a narrow Unraid launcher workflow that captures a redaction-safe O4/O5 packet bundle
under the evidence directory and immediately reviews the packet envelope.

## Launcher Command

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-evidence-capture
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh o4-o5-evidence-capture /mnt/user/appdata/catalog/backups/evidence/o4-o5/custom-label
```

Default output directory:

```bash
/mnt/user/appdata/catalog/backups/evidence/o4-o5/o4-o5-<utc-timestamp>
```

## Captured Files

The launcher writes redacted descriptor templates and command outputs:

- `o4-custodian-descriptor.redacted.json`;
- `o5-kek-descriptor.redacted.json`;
- `o4-o5-decision-record.redacted.json`;
- `o4-o5-evidence-packet.redacted.json`;
- `o4-custodian-preflight.redacted.json`;
- `o5-kek-preflight.redacted.json`;
- `o4-o5-decision-packet.redacted.json`;
- `o4-o5-packet-review.redacted.json`.

The command runs:

- `ops:custodian-evidence-preflight`;
- `ops:kek-evidence-preflight`;
- `ops:o4-o5-evidence-decision`;
- `ops:o4-o5-evidence-packet-review`.

## Boundary

This capture command copies redacted templates and validates explicit JSON files. It does not run
mutating KEK rotation, does not use `rewrap-plan`, does not inspect key files, does not scan evidence
directories, does not contact providers, does not scrape, does not download, and does not start
playback.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.

