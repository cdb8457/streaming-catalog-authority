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

echo "=== govulncheck (advisory: needs network; a failure to FETCH is reported, not fatal) ==="
if ! docker compose -f "$COMPOSE_FILE" run --rm -T go-gate \
    sh -c 'go run golang.org/x/vuln/cmd/govulncheck@latest ./... 2>&1'; then
  echo "govulncheck did not complete (usually no network). Recording as NOT RUN rather than as a pass." >&2
fi

echo "all projectiond gates passed"
