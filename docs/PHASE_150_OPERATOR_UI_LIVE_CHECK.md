# Phase 150 - Operator UI Live Check

Report id: `phase-150-operator-ui-live-check`

Phase 150 adds a redaction-safe live validation command for the already-running read-only operator
UI. It is intended for Arcane custom commands, Unraid User Scripts, and quick SSH checks.

Command:

```bash
npm run ops:operator-ui-live-check -- --json
```

Unraid launcher command:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-live-check-save
```

`ui-live-check-save` writes clean JSON to:

```text
/mnt/user/appdata/catalog/backups/evidence/operator-ui-live-check-<UTC>.json
```

You can provide an explicit output file as the second argument.

What it checks:

- `/healthz` returns HTTP 200;
- unauthenticated `/api/status` returns HTTP 401;
- authenticated `/api/status` returns HTTP 200 with `ok: true`;
- authenticated `/api/logs` returns HTTP 200 with redacted log entries.

Output policy:

- prints fixed check labels, HTTP status codes, doctor pass/warn/fail counts, attention count, and
  log-entry count;
- saved evidence files contain the same redaction-safe JSON without npm banner text;
- never prints the operator token;
- never prints database URLs, KEK material, completion secrets, raw identity payloads, or provider
  identifiers.

Still forbidden:

- provider contact;
- scraping;
- downloading;
- playback;
- command execution from the UI;
- migrations, backup, or token rotation from the UI;
- media-server mutation;
- raw secret exposure.
