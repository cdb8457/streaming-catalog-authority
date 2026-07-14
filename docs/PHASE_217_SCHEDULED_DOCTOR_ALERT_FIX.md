# Phase 217: Scheduled Doctor Alert Fix

Report id: `phase-217-scheduled-doctor-alert-fix`

Decision date: `2026-07-13`

Phase type: operations schedule correction. This phase fixes the recurring Unraid `catalog-doctor`
alerts by replacing the stale scheduled command shape with the canonical Unraid runtime launcher.
It does not change Compose, does not change custody mode, and does not change app runtime,
Jellyfin integration, provider mode,
playback, downloads, scraping, or catalog data.

## Root Cause

Observed alerts:

- hourly Unraid notifications reported `FAIL: catalog doctor`;
- retained failure labels included `doctor-20260713-174701`;
- the corresponding `.redacted.json` files were zero bytes;
- `.failure.redacted.txt` files contained only `doctor_failed=<timestamp>` and `exit_code=1`.

The current direct runtime doctor command passes with `ok:true`. The scheduled script was stale:

```bash
docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml run --rm ops ops:doctor -- --json
```

That command shape no longer matches the live Unraid runtime, which now uses
`docker-compose.unraid.runtime.yml` through `deploy/unraid-ops-launcher.sh`.

## Corrected Scheduled Command

The `catalog-doctor` Unraid User Script must use the canonical launcher:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh doctor
```

The scheduled wrapper may still save stdout to:

```text
/mnt/user/appdata/catalog/evidence/doctor-<timestamp>.redacted.json
```

On failure, it should retain only a redaction-safe failure label and exit code, then send the terse
notification:

```text
ops:doctor reported failure; inspect redacted evidence label doctor-<timestamp>
```

## Applied Unraid Patch

Patch target:

```text
/boot/config/plugins/user.scripts/scripts/catalog-doctor/script
```

Expected patched behavior:

1. set `APP=/mnt/user/appdata/catalog/repo`;
2. set `LAUNCHER="$APP/deploy/unraid-ops-launcher.sh"`;
3. run `"$LAUNCHER" doctor > "$OUT" 2>"$TMPERR"`;
4. on success, remove temporary stderr and any stale failure file;
5. on failure, write `doctor_failed=<timestamp>` and `exit_code=<status>` only.

## Verification

Verification command:

```bash
/boot/config/plugins/user.scripts/scripts/catalog-doctor/script
```

Expected result after patch:

- exit code `0`;
- a non-empty redaction-safe JSON file under `/mnt/user/appdata/catalog/evidence`;
- report `ok:true`;
- no new failure notification.

The launcher `doctor` subcommand uses the silent ops runner so scheduled evidence starts with `{`
and remains parseable JSON instead of npm banner text plus JSON.

## Status Boundaries

- This phase corrects only the scheduled doctor wrapper.
- The application doctor currently passes when invoked through the runtime stack.
- Jellyfin live evidence remains blocked on `/mnt/user/appdata/catalog/secrets/jellyfin_api_key`.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
