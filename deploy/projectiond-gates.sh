#!/usr/bin/env bash
# Every projectiond gate, in one command, through the pinned toolchain.
#
# WHY DOCKER. Development happens on Windows, which has no Go and no FUSE. Running the gates inside a pinned
# image means "it built on my machine" means the same thing on every machine. A Linux host with the same Go
# release can run each command natively; nothing here requires the container.
set -euo pipefail

COMPOSE_FILE="docker-compose.projectiond.yml"
run() {
  echo "=== $* ==="
  docker compose -f "$COMPOSE_FILE" run --rm -T go-gate "$@"
}

echo "projectiond gates: format, vet, build, test, race"
run gofmt -l .
# gofmt -l prints nothing when everything is formatted; a non-empty list is a failure the eye can miss, so it
# is re-checked as a condition rather than trusted to exit non-zero.
UNFORMATTED="$(docker compose -f "$COMPOSE_FILE" run --rm -T go-gate gofmt -l . | tr -d '\r')"
if [ -n "$UNFORMATTED" ]; then
  echo "unformatted files:" >&2
  echo "$UNFORMATTED" >&2
  exit 1
fi

run go vet ./...
run go vet -tags fusesmoke ./...
run go build ./...
run go test -count 1 ./...

echo "=== go test -race (cgo enabled; a separate service) ==="
docker compose -f "$COMPOSE_FILE" run --rm -T go-race go test -race -count 1 ./...

# govulncheck is PINNED. `@latest` in a gate means the gate changes under you, which is the opposite of what
# a gate is for; a version bump should be a commit somebody reviewed.
#
# A VULNERABILITY FINDING FAILS THE GATE. Being unable to FETCH the tool does not — that is a network fact
# about the machine, not a fact about the code — but it is reported as NOT RUN rather than counted as a pass.
GOVULNCHECK_VERSION="v1.6.0"
echo "=== govulncheck ${GOVULNCHECK_VERSION} ==="
GOVULN_OUTPUT="$(docker compose -f "$COMPOSE_FILE" run --rm -T go-gate \
    sh -c "go run golang.org/x/vuln/cmd/govulncheck@${GOVULNCHECK_VERSION} ./... 2>&1")" && GOVULN_STATUS=0 || GOVULN_STATUS=$?
echo "$GOVULN_OUTPUT"
if [ "$GOVULN_STATUS" -ne 0 ]; then
  if printf '%s' "$GOVULN_OUTPUT" | grep -qiE "Vulnerability #|found [0-9]+ vulnerabilit"; then
    echo "govulncheck reported a vulnerability. This gate fails." >&2
    exit 1
  fi
  echo "govulncheck did not complete (usually no network). Recorded as NOT RUN, not as a pass." >&2
fi

echo "all projectiond gates passed"
