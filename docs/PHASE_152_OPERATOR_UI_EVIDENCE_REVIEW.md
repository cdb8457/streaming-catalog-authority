# Phase 152 - Operator UI Evidence Review

Report id: `phase-152-operator-ui-evidence-review`

Phase 152 adds a review command for saved `ui-live-check-save` JSON files.

Command:

```bash
npm run ops:operator-ui-evidence-review -- --max-age-hours 24 <evidence.json>...
```

Unraid launcher command:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh ui-evidence-review <evidence.json>...
```

Review rules:

- file must be valid JSON;
- schema must be complete for a Phase 150 live-check report;
- file modification time must be recent, with default max age `24` hours;
- report must be passing, with `ok: true` and every check state set to `pass`.

Output:

- text mode prints `PASS` or `FAIL` per file plus the individual check results;
- `--json` emits a machine-readable summary;
- exit code is nonzero when any file fails review.

The command reads explicit files only. It does not contact providers, mutate the UI, execute media
server actions, print operator tokens, or expose raw secrets.
