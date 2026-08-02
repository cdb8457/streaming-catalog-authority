#!/usr/bin/env bash
# The media server's own last words, TIME-BOUNDED and scrubbed, for a gate that is about to fail.
#
# WHY THIS IS A SCRIPT AND NOT FOUR LINES INSIDE THE GATE. Two reasons, and the second is the one that made
# it a file.
#
# 1. THE GATE DELETES ITS OWN EVIDENCE. The cleanup trap removes the run directory, and the media server's
#    log lives inside it — so a failure that happens once in a thirty-minute run leaves nothing behind to
#    diagnose it with. That is not hypothetical: a seek timed out on segment 17 and the only surviving
#    evidence was the timeout itself.
#
# 2. A DIAGNOSTIC THAT CAN HANG IS WORSE THAN NO DIAGNOSTIC. The first version wrapped `docker exec` in
#    nothing at all while its comment claimed to be bounded. `docker exec` blocks indefinitely against a
#    wedged container or a stalled daemon — and the cases where a gate most needs its log tail are exactly
#    the cases where the container is wedged. So the collection is wrapped in a real time bound, and a
#    timeout is reported rather than waited on. Being a script with an injectable command is what lets the
#    offline suite drive a hanging collector and prove the bound holds.
#
# IT NEVER CHANGES THE OUTCOME. It prints to stdout and always exits 0: the caller has already decided to
# fail, and a diagnostic that could turn one failure into a different one would replace an explained failure
# with an unexplained one.
set -uo pipefail

CONTAINER="${1:?container name}"
LINES="${2:-40}"

# THE LINE COUNT IS VALIDATED BEFORE IT IS INTERPOLATED, because it IS interpolated — into an `sh -c` string
# that runs inside the media server's container. `40; rm -rf /` is not a line count, and a diagnostic that
# executed one would be a far worse failure than the one it was called to explain. The cap is here for the
# same reason the byte cap below is: a caller that asked for a million lines would turn a bounded diagnostic
# into an unbounded one.
case "$LINES" in
  ''|*[!0-9]*) LINES=40 ;;
esac
if [ "$LINES" -lt 1 ] || [ "$LINES" -gt 200 ]; then LINES=40; fi
# The time bound, and the command that is bounded. `PROJECTION_PLEX_LOG_TAIL_DOCKER` is the seam the offline
# suite replaces with a script that hangs, so the bound is exercised as behaviour rather than read as source.
TIMEOUT_SECONDS="${PROJECTION_PLEX_LOG_TAIL_TIMEOUT_SECONDS:-15}"
DOCKER_BIN="${PROJECTION_PLEX_LOG_TAIL_DOCKER:-docker}"

LOG="/config/Library/Application Support/Plex Media Server/Logs/Plex Media Server.log"

# EVERYTHING IS SCRUBBED BEFORE ANYTHING IS PRINTED. The pipeline means no raw line ever reaches stdout, and
# the rules cover the four shapes this log actually carries: a URL, a filesystem path, an address, and a
# CREDENTIAL IN A QUERY — which the URL rule alone would miss, because Plex logs bare `?X-Plex-Token=...`
# fragments as well as whole locators. §7's redaction rule has no exception for error paths, and an exception
# is exactly where a leak would live.
scrub() {
  sed -e 's#[Xx]-[Pp]lex-[Tt]oken=[^ &"]*#X-Plex-Token=<redacted>#g' \
      -e 's#[Aa]pi_key=[^ &"]*#api_key=<redacted>#g' \
      -e 's#[Tt]oken=[^ &"]*#token=<redacted>#g' \
      -e 's#[a-zA-Z][a-zA-Z0-9+.-]*://[^ ]*#<locator>#g' \
      -e 's#/config/[^ ]*#<path>#g' \
      -e 's#/media/projection/[^ ]*#<path>#g' \
      -e 's#[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}#<address>#g'
}

# THE BYTE CAP, WHICH THE LINE CAP DOES NOT GIVE YOU. Forty lines is not forty short lines: Plex logs
# base64-encoded plugin payloads that run to tens of kilobytes on ONE line, and this gate has seen them. A
# line-bounded diagnostic is still unbounded in bytes, and dumping a megabyte into a failing gate's stderr
# buries the failure it was called to explain. `head -c` truncates the collected text before it is scrubbed
# or printed.
MAX_BYTES="${PROJECTION_PLEX_LOG_TAIL_MAX_BYTES:-32768}"
case "$MAX_BYTES" in
  ''|*[!0-9]*) MAX_BYTES=32768 ;;
esac
if [ "$MAX_BYTES" -lt 1024 ] || [ "$MAX_BYTES" -gt 262144 ]; then MAX_BYTES=32768; fi

# COLLECTED TO A FILE, THEN TRUNCATED — not piped straight into `head -c`. With `pipefail` set, `head`
# closing the pipe early makes the upstream die of SIGPIPE and the pipeline report 141, so the huge-line case
# this cap exists for would have been reported as a collection failure. Writing first keeps the timeout's own
# status readable and keeps the truncation honest.
COLLECTED="$(mktemp)"
trap 'rm -f "$COLLECTED"' EXIT
timeout "$TIMEOUT_SECONDS" "$DOCKER_BIN" exec "$CONTAINER" \
  sh -c "tail -n ${LINES} '${LOG}'" > "$COLLECTED" 2>/dev/null
status=$?
raw="$(head -c "$MAX_BYTES" "$COLLECTED")"

if [ "$status" -eq 124 ]; then
  # THE BOUND FIRED. Say so, and say nothing else: the caller's own failure is the thing that matters and it
  # has already been printed.
  echo "  (the media server's log could not be collected within ${TIMEOUT_SECONDS}s; the container is not"
  echo "   answering. The failure above stands on its own.)"
  exit 0
fi
if [ "$status" -ne 0 ] || [ -z "$raw" ]; then
  echo "  (no media-server log was available)"
  exit 0
fi

printf '%s\n' "$raw" | scrub
exit 0
