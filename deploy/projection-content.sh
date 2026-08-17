#!/usr/bin/env bash
# Projection Phase 10 D10.3 — THE OPERATOR CONTENT COMMAND. One script, eight verbs, and none of them touches
# the appliance.
#
#   projection-content.sh preflight              check everything and CHANGE NOTHING
#   projection-content.sh add-torbox --file F    register provider-backed objects from a 0600 file
#   projection-content.sh add-local  --file F    register local files under the media root
#   projection-content.sh publish                mint a generation. THE ONLY VERB THAT PUBLISHES.
#   projection-content.sh reconcile              report every divergence. IT CHANGES NOTHING.
#   projection-content.sh hold    --path P       degrade one entry with operator-hold
#   projection-content.sh release --path P       restore one held entry
#   projection-content.sh status                 what is registered, what is published, and what is neither
#
# WHY THIS IS A SECOND SCRIPT AND NOT THREE MORE VERBS ON `projection-alpha.sh`. Phase 10 §3.1, three reasons
# in descending order of force:
#
#   1. `deploy/projection-alpha.sh` is on `PHASE9_SOAK_TRIGGERING_SOURCE`. Editing it makes
#      `phase9RequiresSoakRerun` TRUE and re-opens Phase 8's six-hour soak — three consecutive soaks plus
#      Phase 7's whole sequence from the same candidate, against a CDN pool that rotates mid-run.
#   2. `test/projection-bounded-recovery.ts` recomputes the OPERATOR SOURCE DIGEST over that file and four
#      others on every run and compares it against the documented value. An edit there fails a suite
#      immediately, which is the guard working rather than an obstacle to route around.
#   3. Phase 8 §13's ownership rule is about THE MOUNT POINT. This command owns the DATABASE and the MANIFEST
#      DIRECTORY and never the mount point. One mount point still has exactly one owner, and it is not this.
#
# WHAT IT NEVER DOES, AND EVERY ONE IS A REFUSAL RATHER THAN A CONVENTION:
#   - it never writes inside the projection mount point, and never mounts or unmounts anything;
#   - it never starts, stops, upgrades or rolls back the appliance;
#   - it never publishes unless the operator typed `publish` or `--publish`;
#   - `reconcile` never repairs what it finds — `hold` and `release` are how a human acts on a report;
#   - it never contacts TorBox, a CDN origin, an indexer, SABnzbd or an NNTP server, and it never reads,
#     writes or touches `endpoint.json`. Phase 10 is provider-free BY CONSTRUCTION.
#
# WHAT IT NEVER PRINTS: a provider object reference, a credential, a URL, an origin, an absolute media path or
# an arbitrary OS error. Every diagnostic is a closed-set code, a count, or a projected path — which is
# namespace identity rather than content identity, and is the only handle an operator has for an entry.
#
# EVERY VERB IS IDEMPOTENT. Running `add-local` twice registers one entry; running `publish` twice mints one
# generation and reports `unchanged` the second time; `hold` on a held entry succeeds and says nothing
# changed. An operator who is unsure what state they are in should be able to run the verb they want and get
# that state.
#
# EXIT STATUS. 0 when the verb did what it says. 1 when it refused, or when `reconcile` found a divergence —
# a timer that reports success while the disk and the namespace disagree is a timer nobody reads. 2 on usage.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CLI="$ROOT/src/ops/projection-content-cli.ts"

# THE CONFIGURATION IS AN OPERATOR INPUT AND HAS NO DEFAULT INSIDE THE APPLIANCE. A default would mean this
# command could act on a namespace the operator did not name, which for a command that publishes is the wrong
# failure to make convenient.
CONFIG="${PROJECTION_CONTENT_CONFIG:-}"

say() { echo "[content] $*"; }
die() { echo "[content] $*" >&2; exit 2; }

usage() {
  cat >&2 <<'USAGE'
usage: projection-content.sh <verb> [options]

verbs
  preflight                      everything wrong that can be seen before anything is written
  add-torbox --file <path>       register provider-backed objects from a 0600 file in
                                 deploy/real-provider-objects.template.json's shape. DOES NOT PUBLISH.
  add-local  --file <path>       register local files under the media root. Size, mtime and probe digests
                                 are READ FROM THE FILES, not typed. DOES NOT PUBLISH.
  publish                        mint a generation from what is registered
  reconcile                      report every divergence. IT CHANGES NOTHING.
  hold    --path <projected>     degrade one entry with operator-hold; it stays in the namespace
  release --path <projected>     restore one held entry
  status                         what is registered, what is published, and what is neither

options
  --config <path>                the content-plane configuration (or set PROJECTION_CONTENT_CONFIG)
  --file <path>                  the objects file, for add-torbox and add-local
  --path <projected path>        the entry, for hold and release
  --publish                      on add-torbox or add-local: publish afterwards, explicitly
  --since <timestamp>            on hold: when the hold was declared
  --json                         emit the document rather than the rendered lines
  --database-url <url>           override the control-plane connection string

NOTHING PUBLISHES IMPLICITLY. A registered entry is in the control plane and in NO GENERATION, so no media
server can see it until `publish` runs. Phase 9's Usenet runbook said otherwise; Phase 10 §2.2 is the
correction and docs/PROJECTION_CONTENT_OPERATOR_RUNBOOK.md is the page that replaces it.
USAGE
  exit 2
}

# ----------------------------------------------------------------------------------------------------------
# Argument handling. The verb is separated from the flags so the flags can be passed through unread — this
# script is a launcher, and a launcher that parsed the flags itself would be a second parser to keep in step
# with the first.
# ----------------------------------------------------------------------------------------------------------

[ "$#" -ge 1 ] || usage
VERB="$1"
shift

case "$VERB" in
  preflight|add-torbox|add-local|publish|reconcile|hold|release|status) ;;
  -h|--help|help) usage ;;
  # THE ARGUMENT IS NOT ECHOED. `die` writes to stderr and stderr is collected, and the slot an unknown verb
  # arrives in is the slot an operator mistypes a PATH into. The usage above names the eight verbs, and the
  # operator can see what they typed; what an echo buys is a media path, or a whole `--database-url=<value>`
  # typed as one token, in somebody's log.
  *) die "that is not one of the eight verbs this command has; run it with --help" ;;
esac

# `--config` is lifted out because it has an environment fallback and the CLI has none; every other flag is
# forwarded exactly as typed.
FORWARD=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || die "--config needs a value"
      CONFIG="$2"
      shift 2
      ;;
    *)
      FORWARD+=("$1")
      shift
      ;;
  esac
done

[ -n "$CONFIG" ] || die "no configuration: pass --config <path> or set PROJECTION_CONTENT_CONFIG"
[ -f "$CONFIG" ] || die "the content configuration is not a readable file"

command -v npx >/dev/null 2>&1 || die "npx is not on PATH"
[ -f "$CLI" ] || die "this script is not beside its command; expected src/ops/projection-content-cli.ts"

# ----------------------------------------------------------------------------------------------------------
# The invocation.
#
# `set -e` IS DISABLED AROUND IT ON PURPOSE. The CLI's exit status is MEANING — 1 from `reconcile` is "there
# are divergences", not "the command broke" — and letting `set -e` turn that into an abort would lose the
# distinction the whole surface is built on. The status is captured and re-raised unchanged.
# ----------------------------------------------------------------------------------------------------------

set +e
( cd "$ROOT" && npx tsx "$CLI" "$VERB" --config "$CONFIG" ${FORWARD[@]+"${FORWARD[@]}"} )
STATUS=$?
set -e

if [ "$VERB" = "reconcile" ] && [ "$STATUS" -eq 1 ]; then
  say "reconcile found at least one divergence AND CHANGED NOTHING. Act with hold or release, or publish."
fi

exit "$STATUS"
