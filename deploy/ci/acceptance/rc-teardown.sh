# Catalog Authority — Phase 248 release-candidate teardown helpers.
#
# SOURCED, never executed. This file exists so the one property that matters for cleanup — that teardown is
# armed BEFORE `docker compose up`, not after it returns — is a single, shared, deterministically testable
# implementation rather than two lines that can drift. See test/release-candidate-acceptance.ts, which sources
# this file and drives it with an injected compose failure, with no Docker daemon.
#
# It defines only functions; it runs nothing at source time and touches no `docker` until called, so it is
# safe to source on a machine with no daemon.

# Bring the extracted compose project down, removing volumes and orphans.
#
# Scoped to the given directory ONLY — the compose project is resolved from the compose file in that
# directory — so it can never touch an unrelated project. Idempotent: `down` on a project where nothing, or
# only part, was created is a harmless no-op. It never fails the caller: a teardown error must not mask the
# real failure that triggered it.
rc_compose_down() {
  local dir="${1:-}"
  [ -n "${dir}" ] && [ -d "${dir}" ] || return 0
  ( cd "${dir}" && docker compose down -v --remove-orphans ) >/dev/null 2>&1 || true
}

# ARM teardown, THEN bring the stack up.
#
# Setting RC_COMPOSE_ATTEMPTED before `docker compose up` is the whole point of this helper. `up` can
# partially create a network, a volume or a container and then exit non-zero; if the caller only set a
# "started" flag AFTER a successful `up`, a partial-up failure would leave those resources behind because the
# EXIT trap would think nothing was started. Because this is a shell function (not a subshell), the assignment
# lands in the CALLER's shell and survives `set -e` aborting on the failed `up`, so the caller's trap sees the
# flag and tears the partial stack down.
rc_compose_up() {
  local dir="${1:?rc_compose_up needs the extracted project directory}"
  RC_COMPOSE_ATTEMPTED=1
  ( cd "${dir}" && docker compose up -d )
}
