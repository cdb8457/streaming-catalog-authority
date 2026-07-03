# Phase 20 - Unraid Operations Schedule and Retention Readiness

Phase 20 defines operator-owned recurring operations for a self-hosted or Unraid deployment. It is
documentation only: no scheduler daemon, cron installer, Docker change, runtime default, or product
behavior is added. Copy snippets into Unraid User Scripts or cron only after replacing placeholders
for the local deployment.

These examples must not become CI requirements. CI must not require Docker, network, live Jellyfin,
live external custodian, cloud services, age tooling, production databases, or operator credentials.
O4 external/managed custodian and O5 managed age KEK custody/scheduling remain open unless separate
evidence closes or formally accepts them.

## Suggested Cadence

Treat these as starting points, not product defaults:

| Operation | Example cadence | Purpose |
|---|---|---|
| `ops:doctor --json` (`npm run ops:doctor -- --json`) | every 15-60 minutes | unattended health and readiness visibility |
| `ops:backup -- dump` | daily, plus before upgrades | ciphertext/key-control DB backup artifact |
| `ops:verify-backup` | after every backup | offline structural check of the artifact |
| `ops:rehearse-restore` | monthly and before major upgrades | prove restore into a throwaway DB |
| `ops:rewrap-kek -- --plan --json` | monthly and before planned KEK rotation | non-mutating KEK rewrap preflight |
| `ops:kek-evidence-preflight -- -- <descriptor.json> --json` | before O5 evidence review | static descriptor check for KEK custody/scheduling evidence |

Record results in `docs/templates/PRODUCTION_READINESS_EVIDENCE.md` when preparing shareable
evidence. Do not store command environments, raw logs, or unredacted notifications in the report.

## Unraid User Scripts / Cron Examples

The snippets below are examples only. They use placeholders for app path, backup path, notification
target, and throwaway rehearsal database. Do not commit local copies with real paths, database URLs,
secret file paths, tokens, KEKs, DEKs, provider refs, or media titles.

### Healthcheck

```bash
#!/bin/bash
set -euo pipefail
APP_DIR="<catalog-authority-app-dir>"
NOTIFY_CMD="<notification-command>"
EVIDENCE_DIR="<redacted-evidence-dir>"

cd "$APP_DIR"
OUT="$(npm run --silent ops:doctor -- --json)" || {
  "$NOTIFY_CMD" -e "catalog doctor" -s "FAIL: doctor" -d "ops:doctor reported FAIL checks; inspect redacted JSON output" -i alert
  exit 1
}

# Expected O4/O5 WARN checks are readiness gates to record/review, not health failures.
# Other WARN checks should be investigated using docs/PHASE_5_RUNBOOK.md.
mkdir -p "$EVIDENCE_DIR"
printf '%s\n' "$OUT" > "$EVIDENCE_DIR/doctor-latest.redacted.json"
```

### Backup And Offline Verify

```bash
#!/bin/bash
set -euo pipefail
APP_DIR="<catalog-authority-app-dir>"
BACKUP_DIR="<db-backup-dir>"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARTIFACT="$BACKUP_DIR/catalog-$STAMP.json"

cd "$APP_DIR"
mkdir -p "$BACKUP_DIR"
npm run --silent ops:backup -- dump "$ARTIFACT"
npm run --silent ops:verify-backup -- "$ARTIFACT"
```

### Restore Rehearsal

```bash
#!/bin/bash
set -euo pipefail
APP_DIR="<catalog-authority-app-dir>"
ARTIFACT="<db-backup-artifact>"

cd "$APP_DIR"
REHEARSAL_ADMIN_DATABASE_URL="<throwaway-db-url>" \
  npm run --silent ops:rehearse-restore -- "$ARTIFACT"
```

The rehearsal database must be throwaway infrastructure. It must never be the production
`ADMIN_DATABASE_URL` or `DATABASE_URL`, and it must be dropped or reset after the rehearsal.

### KEK Rewrap Plan

```bash
#!/bin/bash
set -euo pipefail
APP_DIR="<catalog-authority-app-dir>"

cd "$APP_DIR"
npm run --silent ops:rewrap-kek -- --plan --json
```

Plan mode is non-mutating and redaction-safe: it reports aggregate counts and `mutates: false`.
Running the plan on a schedule does not schedule KEK rotation, does not rotate the KEK, and does not
close O5 managed custody/scheduling by itself.

`docs/PHASE_30_KEK_EVIDENCE_PREFLIGHT.md` / `ops:kek-evidence-preflight` can be used before O5
evidence review to check one redaction-safe descriptor JSON file for custody, schedule ownership,
alerting, retention-boundary, and residual-risk metadata. It is descriptor-only: it does not read
the rewrap output, inspect key files, invoke age, contact a scheduler API, install cron, rotate keys,
or close O5.

## Retention Guidance

Keep DB backup artifacts long enough to satisfy the operator's rollback and disaster-recovery
policy. A common starting point is daily artifacts for 14-30 days, weekly artifacts for 8-12 weeks,
and a pre-upgrade artifact until the next upgrade is proven recoverable. Adjust for available
storage, privacy risk, and restore objectives.

Do not store the FileCustodian keystore, KEK, completion secret, or secret files in the same backup
set as DB artifacts. They must live on independent media and separate failure domains from the DB
backups. A single location holding both the DB backup and key material defeats the crypto-shredding
recovery boundary.

Backup artifacts contain ciphertext and key-control state, so still protect them at rest. Evidence
reports should include artifact labels or dates only, not artifact contents.

## Alert Triage

- `FAIL`: page or otherwise alert the operator. Inspect the failing check, stop rollout if this is
  an upgrade, and use the relevant runbook before serving traffic.
- Expected `production-gate-o4-external-custodian` and `production-gate-o5-managed-kek` `WARN`
  checks: record and review in the readiness evidence bundle. They are not health failures, but they
  mean O4/O5 remain open.
- Other `WARN` checks: investigate using `docs/PHASE_5_RUNBOOK.md`,
  `docs/PHASE_6_LIFECYCLE.md`, and the command-specific output. Escalate if the warning is
  persistent or newly introduced.

Do not route alerts that contain full JSON blobs to channels that retain secrets or personal data
unless the output has been reviewed as redaction-safe. Prefer terse notifications and store
redacted evidence in an operator-controlled location.

## Redaction Rules

Logs, notifications, tickets, and evidence must omit:

- KEKs, DEKs, wrapping keys, master keys, completion secrets, HMAC secrets, API keys, tokens,
  credentials, private keys, seed phrases, or key material.
- Raw identity, provider refs, media titles, Jellyfin ids, item dumps, plaintext identity, or
  screenshots/logs containing media identity.
- Full environment dumps, production database URLs, credential-bearing paths, secret file paths, and
  backup artifact contents.

Safe evidence includes command shapes with placeholders, exit codes, PASS/WARN/FAIL state summaries,
aggregate rewrap-plan counts, artifact labels/dates, commit/build ids, schema versions, and O4/O5
review status.
