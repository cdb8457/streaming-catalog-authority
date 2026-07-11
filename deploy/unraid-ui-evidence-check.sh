#!/usr/bin/env sh
set -eu

# Save and immediately review redaction-safe operator UI evidence.
# Intended for Unraid User Scripts or Arcane one-shot execution.

LAUNCHER="${CATALOG_AUTHORITY_LAUNCHER:-/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh}"
EVIDENCE_GLOB="${CATALOG_AUTHORITY_EVIDENCE_GLOB:-/mnt/user/appdata/catalog/backups/evidence/operator-ui-live-check-*.json}"

save_output="$("$LAUNCHER" ui-live-check-save)"
printf '%s\n' "$save_output"

evidence="$(ls -t $EVIDENCE_GLOB 2>/dev/null | head -n 1)"
if [ -z "$evidence" ] || [ ! -f "$evidence" ]; then
  echo "No saved operator UI evidence file found after ui-live-check-save." >&2
  exit 1
fi

printf 'Reviewing latest operator UI evidence: %s\n' "$evidence"
"$LAUNCHER" ui-evidence-review "$evidence"
