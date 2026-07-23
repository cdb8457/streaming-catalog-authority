#!/usr/bin/env bash
# Phase 248 — defensive redaction gate for release-candidate acceptance artifacts.
#
# Screenshots and traces are uploaded ONLY when a run fails, and only to diagnose that failure. The operator
# token is a masked password field and is never rendered, so a screenshot cannot show it. A Playwright trace,
# however, records action values, so a trace of a failed test could capture the token that was typed into the
# field. This gate is the backstop: before anything can be uploaded it scans every artifact for the exact
# fixture token, and for token-shaped material in the plain-text logs we generate, and it REMOVES any
# offending file and then FAILS collection so the leak is loud and nothing suspect leaves the runner.
#
# It reads the fixture token from OPERATOR_UI_ACCEPTANCE_TOKEN, never prints it, and never writes it anywhere.
#
# Design notes:
#   * The exact-token scan runs over EVERYTHING, including unzipped traces. This is the reliable gate.
#   * The token-SHAPE heuristic (a long base64 run) runs ONLY over the plain-text logs this harness writes
#     (*.txt, *.log). Playwright's own traces legitimately embed base64 image data and content hashes, so a
#     shape scan over them would fire on every failed run; the server logs, by contrast, are pre-redacted and
#     must never contain such a run.
#   * Offending files are removed surgically. Safe artifacts (screenshots, the JSON report) survive so a
#     failed run can still be diagnosed, while the gate still exits non-zero to signal detection.
set -euo pipefail

ARTIFACT_DIR="${1:?usage: redact-artifacts.sh <artifact-dir>}"
TOKEN="${OPERATOR_UI_ACCEPTANCE_TOKEN:-}"

[ -d "${ARTIFACT_DIR}" ] || { echo "no artifact directory at ${ARTIFACT_DIR}; nothing to redact"; exit 0; }

# Unpack any Playwright trace zips so the scan sees inside them.
find "${ARTIFACT_DIR}" -type f -name '*.zip' -print0 2>/dev/null | while IFS= read -r -d '' zip; do
  dest="${zip%.zip}.unzipped"
  mkdir -p "${dest}"
  unzip -o -q "${zip}" -d "${dest}" 2>/dev/null || true
done

leak=0

# 1. Exact fixture token, anywhere. Remove the containing file; a match is a real leak.
if [ -n "${TOKEN}" ]; then
  while IFS= read -r hit; do
    [ -n "${hit}" ] || continue
    echo "REDACTION: removing ${hit#"${ARTIFACT_DIR}/"} — it contained the fixture token" >&2
    rm -f "${hit}"
    leak=1
  done < <(grep -rlaF -- "${TOKEN}" "${ARTIFACT_DIR}" 2>/dev/null || true)
fi

# 2. Token-shaped material in our own plain-text logs (32 base64 bytes ~= a >=40 char run). Not applied to
#    traces, which legitimately contain base64.
while IFS= read -r -d '' logfile; do
  if grep -qaE '[A-Za-z0-9+/]{40,}={0,2}' "${logfile}" 2>/dev/null; then
    echo "REDACTION: removing $(basename "${logfile}") — it contained token-shaped material" >&2
    rm -f "${logfile}"
    leak=1
  fi
done < <(find "${ARTIFACT_DIR}" -type f \( -name '*.txt' -o -name '*.log' \) -not -path '*trace*' -print0 2>/dev/null)

if [ "${leak}" = "1" ]; then
  echo "REDACTION FAILURE: token or token-shaped material was found and the offending artifacts were removed." >&2
  echo "                   Artifact collection is failing on purpose so nothing suspect is uploaded." >&2
  exit 1
fi

echo "redaction gate passed: no fixture token and no token-shaped log material under $(basename "${ARTIFACT_DIR}")"
