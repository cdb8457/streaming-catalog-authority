#!/usr/bin/env bash
# Projection Phase 6 — THE OPERATOR COMMAND. One script, eight verbs, and nothing an operator has to hold in
# their head between them.
#
#   projection-alpha.sh preflight        check everything and CHANGE NOTHING
#   projection-alpha.sh install          create only this appliance's own directories
#   projection-alpha.sh start            bring the appliance up and wait for it to be ready
#   projection-alpha.sh status           what is wrong, what is at the mount, and what is being done about it
#   projection-alpha.sh stop             bring it down, leaving every byte of data where it is
#   projection-alpha.sh upgrade          record the running digest, then start the new image
#   projection-alpha.sh rollback         return to the digest `upgrade` recorded
#   projection-alpha.sh reset-recovery   clear the durable recovery budget after fixing the fault
#
# EVERY VERB IS IDEMPOTENT. Running `start` on a running appliance is a success, `install` on an installed one
# is a success, and `stop` on a stopped one is a success. An operator who is unsure what state they are in
# should be able to run the verb they want and get that state, which is the opposite of a script that fails
# when it has nothing to do.
#
# WHAT IT REFUSES, AND EVERY ONE OF THESE IS A REFUSAL RATHER THAN A WARNING:
#   - a relative or ambiguous path anywhere in the environment contract;
#   - a mount point that already carries a mount that is NOT this appliance's;
#   - a status port already in use;
#   - a directory that exists, is non-empty, and carries no marker of this appliance;
#   - an image reference that names no digest and no immutable tag;
#   - a consumer that is not already attached to the mount point.
#
# THE LAST ONE IS THE SURPRISING ONE AND IT IS A PRODUCT CONTRACT. §11 of the Phase 0 product contract:
# a media server must bind the projected path BEFORE the daemon first mounts there. A bind taken while the
# path is a plain directory is a slave of the parent's peer group and follows every later mount at that path;
# a bind taken over an existing mount belongs to that mount's group alone and is stranded the moment it goes.
# An operator who attaches Plex afterwards gets a library that works until the first recovery and then never
# again — so this is checked at install time, where it can still be fixed cheaply.
#
# WHAT IT NEVER PRINTS: a credential value, a provider URL, an origin, a ref, a media path, or an arbitrary
# provider or OS error. Every diagnostic here is a closed-set code, a count, or a path the operator typed
# themselves.
#
# WHAT IT NEVER TOUCHES: an existing media library, a user share, an unrelated container, network or volume,
# any Docker restart policy, or anything at all outside this appliance's own directories.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.projection-alpha.yml"
COMPOSE_PROJECT="projection-alpha"
CONTAINER="projection-alpha-projectiond"

# WHERE THIS APPLIANCE RECORDS WHAT IT OWNS. It is under the cache directory, which is the one place the
# contract already requires to be durable and writable, so `install` needs no further authority than it
# already has.
MARKER_NAME=".projection-alpha-owned"
UPGRADE_RECORD_NAME=".projection-alpha-previous-image"

VERB="${1:-}"

say()  { printf 'projection-alpha: %s\n' "$*"; }
warn() { printf 'projection-alpha: %s\n' "$*" >&2; }
die()  { printf 'projection-alpha: REFUSED: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
projection-alpha: usage
  preflight        check every requirement and change nothing
  install          create only this appliance's own directories
  start            bring the appliance up and wait for readiness
  status           the operator status surface
  stop             bring the appliance down, leaving data
  upgrade          record the running image digest, then start the configured one
  rollback         return to the digest `upgrade` recorded
  reset-recovery   clear the durable recovery budget
USAGE
  exit 2
}

# ----------------------------------------------------------------------------------------------------------
# THE ENVIRONMENT CONTRACT
# ----------------------------------------------------------------------------------------------------------
# Every variable is required and none has a default that could point at somebody else's data. A default here
# would be a script that silently mounts over whatever it found, which is the class of accident this whole
# file exists to make impossible.
REQUIRED_DIRS="PROJECTIOND_ALPHA_MANIFEST_DIR PROJECTIOND_ALPHA_MEDIA_ROOT PROJECTIOND_ALPHA_CACHE_DIR \
PROJECTIOND_ALPHA_MOUNT PROJECTIOND_ALPHA_SECRETS_DIR"
REQUIRED_FILES="PROJECTIOND_ALPHA_CONFIG"
REQUIRED_OTHER="PROJECTIOND_ALPHA_IMAGE"

# THE DIRECTORIES THIS APPLIANCE MAY CREATE AND OWN. The media root is deliberately NOT among them: it is the
# operator's existing library, and a script that created it would be a script that could create it in the
# wrong place and then fill it.
OWNED_DIRS="PROJECTIOND_ALPHA_MANIFEST_DIR PROJECTIOND_ALPHA_CACHE_DIR PROJECTIOND_ALPHA_MOUNT"

# An absolute, clean, non-ambiguous path. Anything else is refused rather than resolved: resolving a relative
# path means resolving it against whatever directory the operator happened to be in.
check_path_shape() {
  local name="$1" value="$2"
  [ -n "$value" ] || die "$name is not set"
  case "$value" in
    /*) : ;;
    *) die "$name is not an absolute path" ;;
  esac
  case "$value" in
    */../*|*/..|../*|*//*) die "$name contains an ambiguous path segment" ;;
  esac
  case "$value" in
    /|/mnt|/mnt/user|/boot|/etc|/var|/usr|/root|/home)
      die "$name points at a host root directory, which this appliance will not manage" ;;
  esac
}

# AN IMAGE REFERENCE THAT CANNOT MOVE. A digest is ideal; a tag that is not `latest` is accepted with a
# warning, because an alpha operator building locally has one and refusing it outright would help nobody.
check_image_shape() {
  local value="$1"
  case "$value" in
    *@sha256:*) return 0 ;;
    *:latest|latest) die "PROJECTIOND_ALPHA_IMAGE names a floating tag; pin a digest or an immutable tag" ;;
    *:*) warn "PROJECTIOND_ALPHA_IMAGE names a tag rather than a digest; two runs of this appliance are"
         warn "not provably runs of the same thing. A digest is what makes evidence mean something."
         return 0 ;;
    *) die "PROJECTIOND_ALPHA_IMAGE names neither a tag nor a digest" ;;
  esac
}

marker_path() { printf '%s/%s' "$1" "$MARKER_NAME"; }

# A DIRECTORY IS OURS IF IT IS EMPTY OR CARRIES OUR MARKER. Anything else is somebody's data and this script
# does not decide what to do with somebody's data.
check_dir_ownership() {
  local name="$1" value="$2"
  [ -d "$value" ] || return 0
  if [ -e "$(marker_path "$value")" ]; then
    return 0
  fi
  if [ -z "$(ls -A "$value" 2>/dev/null)" ]; then
    return 0
  fi
  die "$name exists, is not empty, and carries no marker of this appliance"
}

status_port_from_config() {
  # THE PORT IS READ OUT OF THE OPERATOR'S OWN CONFIGURATION, never guessed. It is loopback-only by contract,
  # so what is being checked is whether something else on this host already holds it.
  node "$HERE/projection-alpha-status-port.cjs" "$1"
}

# EVERY CONTAINER ALREADY BOUND TO THE MOUNT POINT, EXCEPT THIS APPLIANCE'S OWN.
#
# IT IS A NAMED FUNCTION RATHER THAN A COMMAND SUBSTITUTION INSIDE THE PREFLIGHT, and the reason is
# mechanical: `test/custody-runtime-closure.ts` parses every shipped script under all three line endings and
# refuses a line whose quotes do not close, and a multi-line `$( ... )` carrying Go-template quoting is
# exactly the shape it cannot read. An unreadable line is not an empty one.
consumers_bound_to() {
  local target="$1" name
  docker ps --format '{{.Names}}' 2>/dev/null | while read -r name; do
    [ "$name" = "$CONTAINER" ] && continue
    docker inspect -f '{{range .Mounts}}{{.Source}}{{println}}{{end}}' "$name" 2>/dev/null \
      | grep -qxF "$target" && printf '%s\n' "$name"
  done
}

# MOUNTS AT A PATH THAT ARE NOT OURS. `findmnt` is Linux; on a host without it the question cannot be asked,
# and a check that could not run is not a check that passed — so it refuses.
foreign_mount_at() {
  local target="$1"
  command -v findmnt >/dev/null 2>&1 || die "findmnt is not available, so the mount point cannot be checked"
  findmnt -rno FSTYPE --target "$target" 2>/dev/null | head -1
}

# ----------------------------------------------------------------------------------------------------------
# PREFLIGHT — checks everything, changes nothing
# ----------------------------------------------------------------------------------------------------------
preflight() {
  local failures=0
  local strict="${1:-strict}"

  for name in $REQUIRED_OTHER; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || { warn "$name is not set"; failures=$(( failures + 1 )); continue; }
  done
  [ -n "${PROJECTIOND_ALPHA_IMAGE:-}" ] && check_image_shape "$PROJECTIOND_ALPHA_IMAGE"

  for name in $REQUIRED_DIRS $REQUIRED_FILES; do
    eval "value=\${$name:-}"
    check_path_shape "$name" "$value"
  done

  # THE CONFIGURATION MUST EXIST AND MUST PARSE. A daemon that refuses its own configuration at startup is a
  # container that restarts forever, and the operator finds out from a log rather than from this.
  [ -f "$PROJECTIOND_ALPHA_CONFIG" ] || die "PROJECTIOND_ALPHA_CONFIG is not a file"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$PROJECTIOND_ALPHA_CONFIG" \
    >/dev/null 2>&1 || die "PROJECTIOND_ALPHA_CONFIG is not readable JSON"

  # NO CREDENTIAL VALUE MAY APPEAR IN THE CONFIGURATION. The daemon's own schema has no field that holds one,
  # and this is the belt to that brace: an operator who pasted a token into a config file finds out here
  # rather than after it has been in a support bundle.
  if grep -qiE '"(token|apiKey|password|secret|authorization)"[[:space:]]*:' "$PROJECTIOND_ALPHA_CONFIG"; then
    die "PROJECTIOND_ALPHA_CONFIG appears to carry a credential VALUE; this appliance takes a token FILE path"
  fi

  # /dev/fuse, without which nothing below matters.
  [ -c /dev/fuse ] || { warn "/dev/fuse is not present on this host"; failures=$(( failures + 1 )); }

  # THE STATUS PORT. Loopback-only by contract; what is checked is whether this host already has it.
  local port
  port="$(status_port_from_config "$PROJECTIOND_ALPHA_CONFIG")"
  if [ -z "$port" ]; then
    warn "the configuration names no usable statusAddr, so status and the healthcheck cannot work"
    failures=$(( failures + 1 ))
  elif [ "$strict" = "strict" ] && command -v ss >/dev/null 2>&1 \
       && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"; then
    # ...UNLESS IT IS OURS. An idempotent `start` on a running appliance must not fail on its own port.
    if ! docker ps --filter "name=^${CONTAINER}\$" --format '{{.Names}}' | grep -q .; then
      warn "something on this host already holds the status port"
      failures=$(( failures + 1 ))
    fi
  fi

  # THE MOUNT POINT. A mount that is not ours at the mount point is the single most dangerous state to start
  # into: the daemon would stack over it, and any recovery would then be looking at a foreign mount it
  # correctly refuses to touch — an appliance that can never repair itself.
  if [ -d "$PROJECTIOND_ALPHA_MOUNT" ]; then
    local fstype
    fstype="$(foreign_mount_at "$PROJECTIOND_ALPHA_MOUNT")"
    if [ -n "$fstype" ] && [ "$fstype" != "fuse.projectiond" ]; then
      # A mount point that is merely ON a filesystem is fine; one that IS a mount of something else is not.
      if findmnt -rno TARGET 2>/dev/null | grep -qxF "$PROJECTIOND_ALPHA_MOUNT"; then
        warn "the mount point already carries a mount that is not this appliance's"
        failures=$(( failures + 1 ))
      fi
    fi
  fi

  # THE CONSUMER PRE-ATTACHMENT CHECK. §11 of the Phase 0 product contract.
  local consumers
  consumers="$(consumers_bound_to "$PROJECTIOND_ALPHA_MOUNT" | wc -l | tr -d ' ')"
  if [ "${consumers:-0}" -eq 0 ]; then
    warn "NO CONSUMER IS ATTACHED to the mount point. §11 of the Phase 0 product contract requires the media"
    warn "server to bind it BEFORE the daemon first mounts there; a bind taken afterwards is stranded by the"
    warn "first recovery. Attach the media server first, then run install."
    failures=$(( failures + 1 ))
  else
    say "$consumers consumer container(s) are already bound to the mount point"
  fi

  for name in $OWNED_DIRS; do
    eval "value=\${$name:-}"
    check_dir_ownership "$name" "$value"
  done

  if [ "$failures" -ne 0 ]; then
    die "$failures preflight check(s) failed; nothing was changed"
  fi
  say "preflight passed; nothing was changed"
}

# ----------------------------------------------------------------------------------------------------------
# INSTALL — creates only this appliance's own directories
# ----------------------------------------------------------------------------------------------------------
install_appliance() {
  preflight
  for name in $OWNED_DIRS; do
    eval "value=\${$name:-}"
    if [ ! -d "$value" ]; then
      mkdir -p "$value"
      say "created $name"
    fi
    # THE MARKER IS WHAT MAKES A SECOND INSTALL IDEMPOTENT AND A WRONG PATH LOUD. It is written only into a
    # directory this run either created or already owned, both of which `check_dir_ownership` has decided.
    if [ ! -e "$(marker_path "$value")" ]; then
      printf 'projection-alpha owns this directory. Removing this file does not remove the data.\n' \
        > "$(marker_path "$value")"
    fi
  done
  say "installed; run start"
}

# ----------------------------------------------------------------------------------------------------------
# START / STOP
# ----------------------------------------------------------------------------------------------------------
compose() { docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"; }

start_appliance() {
  preflight
  compose up -d
  say "waiting for readiness"
  local n=0
  while [ "$n" -lt 120 ]; do
    if [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
            "$CONTAINER" 2>/dev/null)" = "healthy" ]; then
      say "the appliance is ready"
      status_appliance
      return 0
    fi
    n=$(( n + 1 )); sleep 2
  done
  warn "the appliance did not become ready inside the wait"
  status_appliance
  return 1
}

stop_appliance() {
  # `down` WITHOUT `-v`, ALWAYS. Every byte this appliance holds is in a bind the operator supplied, and a
  # stop that removed volumes would be a stop that could remove a cache somebody's re-scan depends on.
  compose down --remove-orphans
  say "stopped; no data was removed"
}

# ----------------------------------------------------------------------------------------------------------
# STATUS — the operator surface
# ----------------------------------------------------------------------------------------------------------
# WHAT AN OPERATOR NEEDS, IN ONE PLACE AND IN THIS ORDER: is the process alive, is it ready and why not, what
# is actually AT the mount, is anything being done about it, and what should they do.
#
# EVERY FIELD IS A CLOSED-SET CODE OR A NUMBER. No path, no URL, no origin, no provider reference, no object
# identity, no OS string. This output is meant to be pasteable into an issue.
status_appliance() {
  local state health raw
  state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo absent)"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$CONTAINER" 2>/dev/null || echo none)"
  printf '  container            %s (health: %s)\n' "$state" "$health"
  if [ "$state" != "running" ]; then
    printf '  liveness             not running\n'
    return 0
  fi

  # THE STATUS SERVER IS LOOPBACK-ONLY AND THE IMAGE IS DISTROLESS, so the request is made by the shipped
  # binary in the mode that starts nothing. It prints the readiness reason CODE and nothing else.
  raw="$(docker exec "$CONTAINER" /usr/local/bin/projectiond \
    --config=/etc/projectiond/config.json --healthcheck 2>&1 || true)"
  printf '  liveness             the process and its status server answered\n'
  printf '  readiness            %s\n' "${raw:-unreadable}"

  # The full document, filtered to the closed-set fields. Anything not on this list is not printed, so a
  # field added later cannot leak through this surface without somebody adding it here on purpose.
  docker exec "$CONTAINER" /usr/local/bin/projectiond \
    --config=/etc/projectiond/config.json --check-config 2>/dev/null \
    | node "$HERE/projection-alpha-status-fields.cjs" || true

  # THE REMEDIATION IS SPELLED OUT ONCE, HERE, because a code an operator has to look up is a code they will
  # not look up at three in the morning.
  cat <<'REMEDY'
  ---
  remediation codes
    none                    nothing to do
    inspect-mount-owner     something that is NOT this appliance's is on the mount point. The daemon will
                            not unmount it, deliberately. Find out what it is before removing anything.
    reset-recovery-ledger   the recovery budget is spent. Fix the underlying fault, then run:
                              projection-alpha.sh reset-recovery
    check-cache-directory   the recovery ledger could not be read or written. The cache directory is the
                            first suspect: it must be durable and writable by the daemon.
REMEDY
}

# ----------------------------------------------------------------------------------------------------------
# UPGRADE / ROLLBACK
# ----------------------------------------------------------------------------------------------------------
# AN UPGRADE THAT CANNOT BE UNDONE IS NOT AN UPGRADE, IT IS A COMMITMENT. So the running image's DIGEST — not
# its tag, which is the thing that just moved — is recorded before anything is pulled or started, and
# `rollback` starts exactly that digest.
upgrade_record() { printf '%s/%s' "$PROJECTIOND_ALPHA_CACHE_DIR" "$UPGRADE_RECORD_NAME"; }

upgrade_appliance() {
  preflight
  local running
  running="$(docker inspect -f '{{index .RepoDigests 0}}' \
    "$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null)" 2>/dev/null || true)"
  if [ -z "$running" ]; then
    # A LOCALLY BUILT IMAGE HAS NO REPO DIGEST, and that is common in an alpha. The image ID is still an
    # immutable reference to exact bytes on this host, which is all rollback needs.
    running="$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
  fi
  if [ -z "$running" ]; then
    die "there is no running appliance to record, so an upgrade could not be rolled back"
  fi
  printf '%s\n' "$running" > "$(upgrade_record)"
  say "recorded the running image for rollback"
  compose up -d
  say "upgraded; run status"
}

rollback_appliance() {
  local previous
  [ -f "$(upgrade_record)" ] || die "no upgrade has been recorded, so there is nothing to roll back to"
  previous="$(head -1 "$(upgrade_record)")"
  [ -n "$previous" ] || die "the recorded rollback target is empty"
  say "rolling back to the image recorded by the last upgrade"
  PROJECTIOND_ALPHA_IMAGE="$previous" compose up -d
  say "rolled back; run status"
}

reset_recovery() {
  # THE ONLY THING THAT CLEARS A RECOVERY LOCKOUT, and it is deliberately a thing a human types. It runs in
  # the shipped image in the mode that constructs no daemon, opens no cache and cannot mount.
  if docker ps --filter "name=^${CONTAINER}\$" --format '{{.Names}}' | grep -q .; then
    docker exec "$CONTAINER" /usr/local/bin/projectiond \
      --config=/etc/projectiond/config.json --reset-recovery
  else
    docker run --rm \
      -v "$PROJECTIOND_ALPHA_CACHE_DIR:/var/lib/projectiond/cache" \
      -v "$PROJECTIOND_ALPHA_CONFIG:/etc/projectiond/config.json:ro" \
      "$PROJECTIOND_ALPHA_IMAGE" --config=/etc/projectiond/config.json --reset-recovery
  fi
  say "the recovery budget is clear; automatic recovery will act again"
}

case "$VERB" in
  preflight)      preflight ;;
  install)        install_appliance ;;
  start)          start_appliance ;;
  stop)           stop_appliance ;;
  status)         status_appliance ;;
  upgrade)        upgrade_appliance ;;
  rollback)       rollback_appliance ;;
  reset-recovery) reset_recovery ;;
  *)              usage ;;
esac
