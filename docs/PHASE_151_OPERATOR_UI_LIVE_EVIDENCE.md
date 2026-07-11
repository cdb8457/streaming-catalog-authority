# Phase 151 - Operator UI Live Evidence

Report id: `phase-151-operator-ui-live-evidence`

Phase 151 adds a launcher command that saves the Phase 150 live-check JSON as a redaction-safe
evidence file for Arcane custom commands and Unraid User Scripts.

Command:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save
```

Default output:

```text
/mnt/user/appdata/catalog/backups/evidence/operator-ui-live-check-<UTC>.json
```

The command writes through a temporary file, applies best-effort `0600` permissions, then moves the
finished JSON into place. It prints only the saved path. The JSON is produced with `npm run --silent`
inside the existing `ops` container so the file contains the report object, not npm banner text.

Still forbidden:

- operator token output;
- raw secret output;
- provider contact;
- scraping;
- downloading;
- playback;
- command execution from the UI;
- media-server mutation.
