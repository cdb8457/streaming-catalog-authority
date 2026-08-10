#!/usr/bin/env bash
# THE CONSUMER-ATTACHMENT CONTRACT, DEMONSTRATED WITH THE THREE REAL MEDIA SERVERS AND NO PROVIDER AT ALL.
#
# WHAT IT PROVES. §11 of `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md` and
# `PROJECTIOND_CONSUMER_ATTACHMENT` say a consumer SHALL bind the projected path BEFORE `projectiond` has
# ever mounted there, and that a consumer which attaches later cannot follow a remount. This runs both sides
# of that sentence, on real Plex, Jellyfin and Emby containers holding real `rslave` binds:
#
#   THE THREE EARLY CONSUMERS   bound while the path is a plain directory. They must keep reading through a
#                               graceful daemon restart AND through an external umount with --auto-remount.
#   THE LATE CONTROL            an identical bind taken AFTER the mount exists. It must FAIL both, because a
#                               demonstration in which nothing can fail is not a demonstration.
#
# WHY THE CONTROL IS NOT OPTIONAL. Without it, "all three still read" is satisfied by a run in which the
# mount never went away — the exact shape this repository keeps finding, where a step reports a result the
# product was never consulted for. The control is what makes the three passes mean something.
#
# WHAT IT DELIBERATELY IS NOT. It contacts NO provider, needs NO operator corpus and mints NO credential:
# the namespace is one locally generated file through a local passthrough source. It is not an acceptance
# gate for Projection Phase 3, closes no G-number, and says nothing about a real provider, playback,
# amplification or any budget. It exists so §11 is executable rather than merely written down.
#
# IT NEVER RUNS BESIDE ANOTHER GATE. It reuses the reliability loop's Compose project on its own port; two
# gates at once on one host collide on fixed loopback ports, which reads like a defect and is not.
set -euo pipefail
# shellcheck source=deploy/projection-gate-cleanup.sh
. "$(cd "$(dirname "$0")" && pwd)/projection-gate-cleanup.sh"
export MSYS_NO_PATHCONV=1

IMAGE="${PROJECTIOND_IMAGE:-projectiond:phase1-local}"
VERIFY_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
JELLYFIN_IMAGE="jellyfin/jellyfin@sha256:7ae36aab93ef9b6aaff02b37f8bb23df84bb2d7a3f6054ec8fc466072a648ce2"
PLEX_IMAGE="plexinc/pms-docker@sha256:a2b03d75aa16f422488c692935cab476d966b75f2af3c93bb6d910c6051906f5"
EMBY_IMAGE="emby/embyserver@sha256:734a6f03c7c783a9e566b08d09a2b6376f41229ff29f032a7e00302e0be98f8a"

COMPOSE_FILE="docker-compose.projection-reliability.yml"
PG_PORT="${PROJECTION_ATTACHMENT_CHECK_PG_PORT:-5591}"
NETWORK="projection-attachment-check-$$"

MOUNT_CONTAINER="projection-ac-mount-$$"
JF_CONTAINER="projection-ac-jellyfin-$$"
PLEX_CONTAINER="projection-ac-plex-$$"
EMBY_CONTAINER="projection-ac-emby-$$"
LATE_CONTAINER="projection-ac-late-$$"

GATE_ROOT="$PWD/.projection-consumer-attachment-check"
REL=".projection-consumer-attachment-check/run-$$"
WORK="$GATE_ROOT/run-$$"
GATE_SKIP_STATUS=77
CLEANED=0

export ADMIN_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/catalog"
export DATABASE_URL="postgresql://app:app@127.0.0.1:${PG_PORT}/catalog"
export PROJECTION_RELIABILITY_GATE_PG_PORT="$PG_PORT"

step() { echo; echo "=== $* ==="; }
die()  { echo "CHECK FAILED: $*" >&2; exit 1; }

PASSED=0
FAILED=0
verdict() {
  if [ "$2" = "1" ]; then PASSED=$(( PASSED + 1 )); echo "  PASS  $1"
  else FAILED=$(( FAILED + 1 )); echo "  FAIL  $1${3:+ — $3}"; fi
}

cleanup() {
  docker rm -f "$LATE_CONTAINER" "$PLEX_CONTAINER" "$JF_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ "$CLEANED" -eq 0 ] && [ -n "${WORK:-}" ]; then
    projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
    projection_gate_report_cleanliness "$GATE_ROOT" "$WORK" || true
  fi
}
trap cleanup EXIT

if ! docker run --rm --device /dev/fuse:/dev/fuse "$VERIFY_IMAGE" test -c /dev/fuse >/dev/null 2>&1; then
  echo "SKIPPED (status ${GATE_SKIP_STATUS}): no /dev/fuse is reachable from a container on this host." >&2
  echo "      The consumer-attachment contract is UNPROVEN here. This is not a pass." >&2
  exit "$GATE_SKIP_STATUS"
fi

mkdir -p "$WORK/manifest" "$WORK/media" "$WORK/cache" "$WORK/mnt" "$WORK/out" \
         "$WORK/jf-config" "$WORK/jf-cache" "$WORK/plex-config" "$WORK/plex-transcode" "$WORK/emby-config"
chmod 755 "$GATE_ROOT" "$WORK"
chmod 777 "$WORK/cache" "$WORK/mnt" "$WORK/out" \
          "$WORK/jf-config" "$WORK/jf-cache" "$WORK/plex-config" "$WORK/plex-transcode" "$WORK/emby-config"

npx tsx src/ops/projection-host-preflight-cli.ts propagation --path "$GATE_ROOT" --require
npx tsx src/ops/projection-host-preflight-cli.ts traversal --path "$GATE_ROOT" --path "$WORK"

step "building the production image and migrating a throwaway PostgreSQL"
docker build -t "$IMAGE" ./projectiond
docker compose -f "$COMPOSE_FILE" up -d --wait postgres
npx tsx src/ops/migrate-cli.ts
docker network create "$NETWORK" >/dev/null 2>&1 || true

step "one local entry — no provider, no credential, no operator corpus"
SEED_FILE="Attachment Seed (2026).bin"
SEED_PATH="Movies/Attachment Seed (2026)/$SEED_FILE"
head -c 262144 /dev/urandom > "$WORK/media/$SEED_FILE"
SEED_SIZE="$(wc -c < "$WORK/media/$SEED_FILE" | tr -d ' ')"
test "${SEED_SIZE:-0}" -gt 0 || die "the seed file has no bytes"
npx tsx src/ops/projection-register-cli.ts root --id media --kind local
npx tsx src/ops/projection-register-cli.ts version --key seed --size "$SEED_SIZE" \
  --mtime 2026-06-01T10:00:00.000Z
npx tsx src/ops/projection-register-cli.ts entry --item b0000000-0000-4000-8000-00000000000a \
  --version-key seed --path "$SEED_PATH" --source "local:media:$SEED_FILE"
npx tsx src/ops/projection-publish-cli.ts --manifest-dir "$REL/manifest" > "$WORK/out/publish.json"

# THE BIND IS IDENTICAL FOR ALL FOUR CONSUMERS. Same source, same target, same `rslave`. The ONLY difference
# in this whole script is the moment three of them are created and the moment the fourth is.
consumer_bind=( -v "$WORK/mnt:/media/projection:rslave" )

# THE DAEMON'S CONFIGURATION NAMES NO ENDPOINT AT ALL, which is how this script is provider-free by
# construction rather than by intention: there is nothing here it could contact even if a source asked it to.
cat > "$WORK/config.json" <<'JSON'
{
  "mountPoint": "/mnt/projection",
  "pointerPath": "/var/lib/projectiond/manifest/pointer.json",
  "probeCacheDir": "/var/lib/projectiond/cache",
  "localRoots": { "media": "/var/lib/projectiond/media" },
  "statusAddr": "127.0.0.1:9099"
}
JSON

start_daemon() {
  docker run -d --name "$MOUNT_CONTAINER" \
    --network "$NETWORK" --user 0:0 \
    --cap-drop ALL --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
    --device /dev/fuse:/dev/fuse \
    -v "$WORK/manifest:/var/lib/projectiond/manifest:ro" \
    -v "$WORK/media:/var/lib/projectiond/media:ro" \
    -v "$WORK/cache:/var/lib/projectiond/cache" \
    -v "$WORK/config.json:/etc/projectiond/config.json:ro" \
    -v "$WORK/mnt:/mnt/projection:rshared" \
    "$IMAGE" --config /etc/projectiond/config.json \
    --poll 2s --strict-direct-mount --auto-remount >/dev/null || return 1
  local n=0
  while [ "$n" -lt 120 ]; do
    [ "$(docker inspect -f '{{.State.Running}}' "$MOUNT_CONTAINER" 2>/dev/null)" = "true" ] && return 0
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

await_visible() {
  local n=0
  while [ "$n" -lt 240 ]; do
    if docker run --rm -v "$WORK/mnt:/mnt:rslave" "$VERIFY_IMAGE" \
         test -f "/mnt/$SEED_PATH" >/dev/null 2>&1; then return 0; fi
    n=$((n + 1)); sleep 0.5
  done
  return 1
}

# READS AS THE UID THE SERVER ACTUALLY RUNS AS, from inside its own container, and BYTES rather than
# metadata: a dead FUSE mount's `stat` can still answer from a warm attribute cache while `open` returns
# ENOTCONN, so a `test -f` here would pass over exactly the state this script exists to detect.
reads() {
  if docker exec -u 1000:1000 "$1" \
       sh -c "head -c 65536 '/media/projection/$SEED_PATH' > /dev/null 2>&1" >/dev/null 2>&1; then
    echo 1
  else
    echo 0
  fi
}
all_three_read() {
  local jf plex emby
  jf="$(reads "$JF_CONTAINER")"; plex="$(reads "$PLEX_CONTAINER")"; emby="$(reads "$EMBY_CONTAINER")"
  echo "$(( jf + plex + emby ))"
}

step "THE THREE REAL MEDIA SERVERS ATTACH FIRST, while the projected path is a plain directory"
docker run -d --name "$JF_CONTAINER" --network "$NETWORK" --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  -v "$WORK/jf-config:/config" -v "$WORK/jf-cache:/cache" "${consumer_bind[@]}" \
  "$JELLYFIN_IMAGE" >/dev/null
docker run -d --name "$EMBY_CONTAINER" --network "$NETWORK" --cap-drop ALL \
  --cap-add SETUID --cap-add SETGID --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges -e UID=1000 -e GID=1000 \
  -v "$WORK/emby-config:/config" "${consumer_bind[@]}" "$EMBY_IMAGE" >/dev/null
docker run -d --name "$PLEX_CONTAINER" --network "$NETWORK" \
  -e TZ=UTC -e PLEX_UID=1000 -e PLEX_GID=1000 -e ALLOWED_NETWORKS=0.0.0.0/0 \
  -v "$WORK/plex-config:/config" -v "$WORK/plex-transcode:/transcode" "${consumer_bind[@]}" \
  "$PLEX_IMAGE" >/dev/null
echo "  three real, digest-pinned media servers bound to a directory nothing has mounted on yet"

step "the daemon mounts, and the LATE CONTROL attaches afterwards"
start_daemon || die "the daemon did not start"
await_visible || { docker logs --tail 40 "$MOUNT_CONTAINER" >&2; die "the mount never became visible"; }
docker run -d --name "$LATE_CONTAINER" "${consumer_bind[@]}" "$VERIFY_IMAGE" sleep 3600 >/dev/null
echo "  the control's bind is byte-for-byte the same; only its moment differs"

# EVERY CONSUMER MUST BE READING BEFORE ANY FAULT, or nothing below distinguishes a fault from a bad start.
for _ in $(seq 1 60); do [ "$(all_three_read)" = "3" ] && break; sleep 2; done
verdict "AC1-all-three-read-before-any-fault" "$( [ "$(all_three_read)" = "3" ] && echo 1 || echo 0 )" \
  "a server that could not read at the start makes every verdict below meaningless"
LATE_BEFORE="$(reads "$LATE_CONTAINER")"
verdict "AC2-late-control-reads-before-any-fault" "$LATE_BEFORE" \
  "the control must start healthy, or its later failure proves nothing"

step "FAULT 1 — a graceful daemon stop and restart"
docker stop -t 30 "$MOUNT_CONTAINER" >/dev/null
docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
start_daemon || die "the daemon did not restart"
await_visible || die "the namespace never came back for a fresh reader"
GRACEFUL_THREE="$(all_three_read)"
GRACEFUL_LATE="$(reads "$LATE_CONTAINER")"
verdict "AC3-all-three-read-after-graceful-restart" \
  "$( [ "$GRACEFUL_THREE" = "3" ] && echo 1 || echo 0 )" "$GRACEFUL_THREE of 3 could read"
verdict "AC4-late-control-CANNOT-read-after-graceful-restart" \
  "$( [ "$GRACEFUL_LATE" = "0" ] && echo 1 || echo 0 )" \
  "the control still read, so this run had no subject and AC3 proves nothing"

step "FAULT 2 — an external umount under a LIVING daemon with --auto-remount"
projection_gate_unmount_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE"
await_visible || die "the namespace never came back for a fresh reader after the external umount"
UMOUNT_THREE="$(all_three_read)"
UMOUNT_LATE="$(reads "$LATE_CONTAINER")"
verdict "AC5-all-three-read-after-external-umount-and-remount" \
  "$( [ "$UMOUNT_THREE" = "3" ] && echo 1 || echo 0 )" "$UMOUNT_THREE of 3 could read"
verdict "AC6-late-control-CANNOT-read-after-external-umount" \
  "$( [ "$UMOUNT_LATE" = "0" ] && echo 1 || echo 0 )" \
  "the control still read, so this run had no subject and AC5 proves nothing"

step "teardown, and the cleanup is a success condition rather than a report about one"
docker rm -f "$LATE_CONTAINER" "$PLEX_CONTAINER" "$JF_CONTAINER" "$EMBY_CONTAINER" >/dev/null 2>&1 || true
docker stop -t 30 "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$MOUNT_CONTAINER" >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker network rm "$NETWORK" >/dev/null 2>&1 || true
projection_gate_cleanup_run "$GATE_ROOT" "$WORK" "$VERIFY_IMAGE" || true
LEFT="$(projection_gate_mounts_under "$WORK")"
verdict "AC7-own-mountpoints-removed" "$( [ "${LEFT:-1}" = "0" ] && echo 1 || echo 0 )" \
  "${LEFT:-unverified} mountpoint(s) left under this run's own directory"
verdict "AC8-own-run-directory-removed" "$( [ ! -d "$WORK" ] && echo 1 || echo 0 )" \
  "this run's own directory is still there"
CLEANED=1

echo
echo "consumer-attachment contract: $PASSED passed, $FAILED failed"
test "$FAILED" -eq 0 || die "the consumer-attachment contract does not hold on this host"
echo
echo "WHAT THIS DID AND DID NOT SHOW."
echo "  It showed, on THREE REAL digest-pinned media servers holding identical rslave binds, that a consumer"
echo "  attached BEFORE the daemon's first mount keeps reading through a graceful restart AND through an"
echo "  external umount with --auto-remount — and that an identical bind taken AFTER the mount survives"
echo "  NEITHER. The only difference between them is when they attached."
echo
echo "  It contacted NO provider, used NO operator corpus and minted NO credential. It closes no G-number,"
echo "  it is not a Projection Phase 3 acceptance run, and it says nothing about playback, amplification or"
echo "  any budget. It exists so section 11 of the product contract is executable rather than written down."
