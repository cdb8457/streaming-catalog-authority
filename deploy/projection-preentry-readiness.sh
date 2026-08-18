#!/usr/bin/env bash
# THE NO-CONTACT READINESS RECORD. Existence, type, mode, size, digest and shape — and no value, ever.
#
# WHY THIS EXISTS. A provider run's exit criterion asks that the operator's egress allowlist be "unmoved, and
# its state recorded before and after". Nothing in this tree could record it without contacting the provider:
# `deploy/projection-provider-origin-recheck.sh` produces exactly the right redaction-safe shape, but it
# starts a resolver and SPENDS ONE RESOLUTION against the operator's metered account — so taking it twice
# costs two, and its `resolvedOriginDigest` legitimately CHANGES between them because the pool rotates. A
# before/after comparison built on it would report movement where nothing moved.
#
# THIS PROGRAM CONTACTS NOTHING. No socket is opened, no resolver is started, no container is run, no
# provider, CDN, indexer, media server or host is reached. It reads four files the operator already placed,
# and it writes one observation. That is all it does, and it is why the same observation taken an hour apart
# is comparable: a digest of a file nobody edited is the same digest.
#
# WHAT IT MAY EMIT, AND THE LIST IS CLOSED:
#
#   existence   — is the path there at all
#   type        — regular file, directory, or something else
#   mode        — the four-digit permission bits, because 0600 is a precondition and 0644 is a finding
#   size        — in bytes, for the NON-SECRET files only
#   digest      — sha256, truncated to 16 hex characters, for the NON-SECRET files only
#   shape       — which KEYS a JSON document carries and of what type; never a key's value
#   counts      — how many origins the allowlist admits; never which
#   member digests — sha256/12 of each allowlist entry, so two records can be compared without either
#                    naming an origin. A digest is not a locator and cannot be dialled.
#
# WHAT IT MAY NEVER EMIT, AND THIS IS ENFORCED BY A SCRUBBER BELOW RATHER THAN BY CARE:
# a credential value, an object reference, a URL, a host, an origin, an allowlist member, a media identity,
# an operator share path, or an arbitrary OS error string.
#
# THE TWO SECRET FILES ARE NOT DIGESTED, AND THAT IS DELIBERATE. A digest of a 36-byte token is a value-
# derived artefact, and this program's whole promise is that nothing it writes is derived from a secret's
# CONTENT. Their existence, type, mode and non-emptiness are the preconditions that matter, and those are
# what it reports. `torbox-resolver-cli.ts preflight` already asks the same four questions of the same files
# and this program does not re-implement it — it records the SHAPE for comparison, which that one does not.
#
#   exit 0   the record was written
#   exit 77  the operator has supplied nothing; NOTHING WAS CONTACTED and this is not an answer about them
#   exit 1   the record could not be taken, which is NOT the same as "nothing is there"
set -euo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
INPUT_DIR="${PROJECTION_PREENTRY_INPUT_DIR:-/mnt/user/appdata/catalog/secrets/real-provider/torbox}"
OUT=""
MODE="record"
ORIGIN_LIFETIME_MIN=""
SEQUENCE_MINUTES=""
RECORD_AGE_MIN=""
OBSERVED_POOL=""

usage() {
  echo "usage: projection-preentry-readiness.sh [record|plan] [options]"
  echo
  echo "  record   read the operator's inputs and write ONE redaction-safe observation. The default."
  echo "  plan     ask whether a bounded sequence may START against a rotating origin pool."
  echo
  echo "  BOTH MODES CONTACT NOTHING. No socket, no resolver, no container, no host."
  echo
  echo "  --out                    where to write the observation (record mode). Defaults to stdout only."
  echo "  --origin-lifetime-min N  the SHORTEST turn observed for a member of the pool, in minutes."
  echo "  --sequence-minutes N     the bounded duration the sequence declares for itself."
  echo "  --record-age-min N       how old the origin record backing the plan is, in minutes."
  echo "  --observed-pool N        how many distinct origins the pool was observed serving from."
  echo
  echo "  PROJECTION_PREENTRY_INPUT_DIR   the approved input DIRECTORY. Never a value, never a file."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    record|plan) MODE="$1" ;;
    --out) shift; OUT="${1:-}" ;;
    --origin-lifetime-min) shift; ORIGIN_LIFETIME_MIN="${1:-}" ;;
    --sequence-minutes) shift; SEQUENCE_MINUTES="${1:-}" ;;
    --record-age-min) shift; RECORD_AGE_MIN="${1:-}" ;;
    --observed-pool) shift; OBSERVED_POOL="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; echo "unknown argument" >&2; exit 1 ;;
  esac
  shift
done

# ----------------------------------------------------------------------------------------------------------
# PLAN MODE. May a bounded sequence START against a pool that rotates faster than the sequence takes?
#
# WHY THIS IS A REFUSAL BEFORE A RUN RATHER THAN A DIAGNOSIS AFTER ONE. The measured pool serves from seven
# distinct origins, each for roughly forty to eighty-four minutes, cycling back. A three-run provider
# sequence includes three image builds, three migrations and three mounts. A rotation across it is LIKELY
# rather than hypothetical, and its signature is precise: `stat` succeeds, the listing is perfect, and every
# read fails EIO in well under a second. Without this, that reads as a hard FAIL about the product -- and the
# temptation it creates is to widen `allowedOrigins` until it goes green, which is a BLOCKER and not a step.
#
# THE POLICY IS READ FROM THE CONTRACT'S OWN MODULE rather than restated here, for the reason the Phase 11
# gate gives about its own minimums: a script carrying its own copy of a threshold is a script whose
# threshold can drift from the document's, silently, in the direction that lets a run start.
if [ "$MODE" = "plan" ]; then
  command -v npx >/dev/null 2>&1 \
    || { echo "the plan could not be evaluated: this host has no npx" >&2; exit 1; }
  # INSIDE THE REPOSITORY RATHER THAN IN /tmp, and for a reason a Windows host makes immediate: `mktemp -d`
  # under Git Bash answers a POSIX path the Node runtime resolves against the wrong drive root, so the helper
  # is written somewhere the shell can see and the runtime cannot find. Every gate in this tree writes its
  # scratch under a `.projection-*` directory in the repository for the same reason; this one does too, and
  # removes it on the way out.
  # AND IT IS HANDED TO `npx tsx` AS A PATH RELATIVE TO THE REPOSITORY ROOT, which is what the gates do with
  # their own $REL. An absolute POSIX path under Git Bash reaches the Node runtime as a drive-rooted spelling
  # of a directory that does not exist; the relative one is correct in every shell because the invocation
  # already runs from $ROOT.
  PLAN_REL=".projection-preentry-readiness/plan-$$"
  PLAN_SCRATCH="$ROOT/$PLAN_REL"
  mkdir -p "$PLAN_SCRATCH"
  chmod 700 "$PLAN_SCRATCH"
  cat > "$PLAN_SCRATCH/plan.mts" <<'PLAN'
// The origin-stability refusals, READ FROM THE CONTRACT'S OWN MODULE rather than restated here.
//
// It prints one refusal per line and exits 70 when there is at least one -- the same status the origin
// recheck uses for "the serving origin is NOT allowed", because both mean the same thing to a caller: the
// sequence does not start, and this is not a failure of the product.
const root = process.env.PREENTRY_ROOT_URL as string;
const module_ = await import(`${root}src/core/projection/phase13-preentry.ts`);
const number_ = (raw: string | undefined): number | undefined =>
  raw === undefined || raw === '' ? undefined : Number(raw);
const refusals = module_.originStabilityRefusals({
  shortestObservedOriginLifetimeMinutes: number_(process.env.PREENTRY_ORIGIN_LIFETIME_MIN),
  boundedSequenceDurationMinutes: number_(process.env.PREENTRY_SEQUENCE_MINUTES),
  originRecordAgeMinutes: number_(process.env.PREENTRY_RECORD_AGE_MIN),
  allowedOriginCount: number_(process.env.PREENTRY_ALLOWED_ORIGIN_COUNT),
  observedPoolSize: number_(process.env.PREENTRY_OBSERVED_POOL),
}) as readonly string[];
for (const refusal of refusals) console.log(refusal);
process.exit(refusals.length === 0 ? 0 : 70);
PLAN

  # THE ALLOWLIST COUNT COMES FROM THE OPERATOR'S OWN ENDPOINT DOCUMENT WHERE THERE IS ONE, and is left
  # unset where there is not -- an absent count is not a count of zero, and the policy refuses on the pair
  # only when it has both numbers.
  ALLOWED_ORIGIN_COUNT=""
  if [ -f "$INPUT_DIR/endpoint.json" ] && command -v node >/dev/null 2>&1; then
    ALLOWED_ORIGIN_COUNT="$(node -p \
      "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).allowedOrigins.length" \
      "$INPUT_DIR/endpoint.json" 2>/dev/null || printf '')"
  fi

  ROOT_NATIVE="$( (cd "$ROOT" && pwd -W) 2>/dev/null || printf '%s' "$ROOT" )"
  ROOT_URL="file:///$(printf '%s' "$ROOT_NATIVE" | sed 's|^/||')/"
  set +e
  ( cd "$ROOT" \
    && PREENTRY_ROOT_URL="$ROOT_URL" \
       PREENTRY_ORIGIN_LIFETIME_MIN="$ORIGIN_LIFETIME_MIN" \
       PREENTRY_SEQUENCE_MINUTES="$SEQUENCE_MINUTES" \
       PREENTRY_RECORD_AGE_MIN="$RECORD_AGE_MIN" \
       PREENTRY_ALLOWED_ORIGIN_COUNT="$ALLOWED_ORIGIN_COUNT" \
       PREENTRY_OBSERVED_POOL="$OBSERVED_POOL" \
       npx tsx "$PLAN_REL/plan.mts" )
  plan_status=$?
  set -e
  rm -rf "$PLAN_SCRATCH" 2>/dev/null || true
  rmdir "$ROOT/.projection-preentry-readiness" 2>/dev/null || true
  case "$plan_status" in
    0)
      echo >&2
      echo "THE SEQUENCE MAY START. Nothing was contacted to say so; this is a statement about a declared" >&2
      echo "duration and a measured pool, and it closes no claim of any phase." >&2
      exit 0 ;;
    70)
      echo >&2
      echo "THE SEQUENCE MAY NOT START. Each line above is a reason, and NONE of them is a failure of the" >&2
      echo "product. WIDENING THE ORIGIN ALLOWLIST IS A BLOCKER AND NOT A STEP: a rotation is escalated as a" >&2
      echo "count and a digest, never resolved by editing endpoint.json." >&2
      exit 70 ;;
    *)
      echo "the plan could not be evaluated (exit $plan_status), which is NOT the same as permission to" >&2
      echo "start. An unevaluated policy is not a satisfied one." >&2
      exit 1 ;;
  esac
fi

# THE SECRET FILES ARE NAMED HERE SO THE RECORDER CAN REFUSE TO DIGEST THEM, rather than relying on whoever
# adds the next input to remember which ones hold a value.
SECRET_FILES="torbox-credential credential"
SHAPED_FILES="objects.json endpoint.json"

missing=""
for f in $SECRET_FILES $SHAPED_FILES; do
  [ -e "$INPUT_DIR/$f" ] || missing="$missing $f"
done
if [ -n "$missing" ]; then
  echo "SKIPPED (status 77): the operator has supplied no corpus. Missing:$missing" >&2
  echo "      NOTHING WAS CONTACTED, and this is not an answer about the operator's inputs." >&2
  exit 77
fi

command -v node >/dev/null 2>&1 \
  || { echo "the record could not be taken: this host has no node" >&2; exit 1; }

# ----------------------------------------------------------------------------------------------------------
# The recorder. Written as a file rather than inline so an offline suite can EXTRACT it and DRIVE it against
# fixtures — the difference between checking that a string is present and checking that a program answers.
# ----------------------------------------------------------------------------------------------------------
# INSIDE THE REPOSITORY RATHER THAN IN /tmp, for the same reason the plan helper is: mktemp -d under Git
# Bash answers a POSIX path the Node runtime resolves against the wrong drive root, so the helper would be
# written somewhere the shell can see and the runtime cannot find. A program nobody can run on the machine
# it is written on is a program nobody runs before shipping it. Removed on the way out, both ways.
# AND IT IS HANDED TO node AS A PATH RELATIVE TO THE REPOSITORY ROOT, which the invocation below runs from.
SCRATCH_REL=".projection-preentry-readiness/record-$$"
SCRATCH="$ROOT/$SCRATCH_REL"
mkdir -p "$SCRATCH"
trap 'rm -rf "$SCRATCH" 2>/dev/null || true; rmdir "$ROOT/.projection-preentry-readiness" 2>/dev/null || true' EXIT
chmod 700 "$SCRATCH"

cat > "$SCRATCH/record.cjs" <<'RECORD'
// One redaction-safe observation of an input directory. CONTACTS NOTHING and opens no socket.
//
// THE SCRUBBER IS THE LAST THING THAT RUNS AND IT FAILS CLOSED. Every field above it is built to be safe;
// this is what makes "safe" checkable rather than promised, and it refuses to print at all rather than print
// something it cannot stand behind. The pattern list is the shape of a value, not a denylist of known ones:
// a denylist of origins would need to name them, which is the one thing this program may not do.
const { createHash } = require('node:crypto');
const { readFileSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dir = process.argv[2];
const out = process.argv[3];
const secretNames = (process.argv[4] || '').split(',').filter(Boolean);
const shapedNames = (process.argv[5] || '').split(',').filter(Boolean);

if (typeof dir !== 'string' || dir === '' || shapedNames.length === 0) {
  console.error('the recorder was given no input directory or no documents to describe');
  process.exit(1);
}

const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const shortDigest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const mode = (stat) => (stat.mode & 0o7777).toString(8).padStart(4, '0');
const kind = (stat) => (stat.isFile() ? 'regular-file' : stat.isDirectory() ? 'directory' : 'other');

/**
 * The SHAPE of a JSON document: which keys it carries and of what type, and nothing else.
 *
 * A KEY IS A SCHEMA AND A VALUE IS A SECRET. `resolverUrl: string` says the endpoint resolves references
 * before reading, which is exactly the fact a readiness reader needs; the URL itself is a locator nobody
 * needs and this program may not print.
 */
const shapeOf = (value) => {
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value).sort();
  return keys.map((key) => `${key}:${shapeOf(value[key])}`).join(',');
};

const record = { contactedAnything: false, inputs: {}, allowlist: {}, notes: [] };

// THE DIRECTORY ITSELF. A 0777 directory holding 0600 files is still a finding.
try {
  const stat = statSync(dir);
  record.inputs['.'] = { exists: true, type: kind(stat), mode: mode(stat) };
} catch {
  console.error('the input directory could not be described');
  process.exit(1);
}

// THE SECRET FILES: existence, type, mode, non-emptiness. NO SIZE AND NO DIGEST -- a digest of a short token
// is derived from its content, and nothing this program writes may be.
for (const name of secretNames) {
  try {
    const stat = statSync(join(dir, name));
    record.inputs[name] = {
      exists: true, type: kind(stat), mode: mode(stat), nonEmpty: stat.size > 0,
      digested: false, reason: 'a secret is described, never digested',
    };
  } catch {
    record.inputs[name] = { exists: false };
  }
}

// THE SHAPED DOCUMENTS: everything above plus size, a whole-file digest and the key shape.
for (const name of shapedNames) {
  const path = join(dir, name);
  let stat;
  try { stat = statSync(path); } catch { record.inputs[name] = { exists: false }; continue; }
  const entry = { exists: true, type: kind(stat), mode: mode(stat), sizeBytes: stat.size };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch {
    entry.readable = false;
    record.inputs[name] = entry;
    continue;
  }
  // THE WHOLE-FILE DIGEST IS THE CHEAPEST HONEST BEFORE/AFTER EVIDENCE THERE IS. Two records taken an hour
  // apart carry the same one exactly when nobody edited the file, and no contact was needed to say so.
  entry.sha256Prefix = digest(text);
  try {
    entry.shape = shapeOf(JSON.parse(text));
  } catch {
    entry.shape = 'UNPARSEABLE';
    record.notes.push(`${name} is not parseable JSON, which is a finding rather than a value`);
  }
  record.inputs[name] = entry;
}

// THE ALLOWLIST, AS A COUNT AND AS MEMBER DIGESTS. Never as members.
try {
  const endpoint = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'));
  const origins = Array.isArray(endpoint.allowedOrigins) ? endpoint.allowedOrigins : [];
  record.allowlist = {
    allowedOriginCount: origins.length,
    // SORTED, so a record that differs only in the ORDER of an unchanged allowlist does not read as movement.
    allowedOriginDigests: origins.map((origin) => shortDigest(String(origin).replace(/\/$/, ''))).sort(),
    resolvesBeforeReading: typeof endpoint.resolverUrl === 'string' && endpoint.resolverUrl !== '',
    servesStableReferences: typeof endpoint.directBaseUrl === 'string' && endpoint.directBaseUrl !== '',
  };
} catch {
  record.allowlist = { allowedOriginCount: null, allowedOriginDigests: [], unreadable: true };
  record.notes.push('the endpoint document could not be read as JSON, so no allowlist record was taken');
}

// ----------------------------------------------------------------------------------------------------------
// THE SCRUBBER. It runs over the RENDERED record, not over the pieces, so a field added later is covered by
// it without anybody remembering to. It FAILS CLOSED: a suspected leak refuses the whole record.
// ----------------------------------------------------------------------------------------------------------
const rendered = JSON.stringify(record, null, 2);
const FORBIDDEN = [
  [/[a-z][a-z0-9+.-]*:\/\//i, 'a URL or an origin'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'an IP address'],
  [/\b[A-Za-z0-9-]+\.(?:com|net|org|io|app|dev|invalid|local)\b/i, 'a hostname'],
  [/\/mnt\/user\//, 'an operator share path'],
  [/[A-Za-z0-9_-]{24,}/, 'a value-shaped string, which is what a token and a reference both look like'],
];
for (const [pattern, what] of FORBIDDEN) {
  if (pattern.test(rendered)) {
    console.error(`the readiness record would have leaked ${what}, so it was NOT printed`);
    process.exit(1);
  }
}

console.log(rendered);
if (typeof out === 'string' && out !== '') writeFileSync(out, `${rendered}\n`);
RECORD

SECRET_CSV="$(echo "$SECRET_FILES" | tr ' ' ',')"
SHAPED_CSV="$(echo "$SHAPED_FILES" | tr ' ' ',')"

( cd "$ROOT" && node "$SCRATCH_REL/record.cjs" "$INPUT_DIR" "$OUT" "$SECRET_CSV" "$SHAPED_CSV" ) \
  || { echo "the readiness record could not be taken. NOTHING WAS CONTACTED, and an untaken record is not \
an answer about the operator's inputs." >&2; exit 1; }

echo >&2
echo "NOTHING WAS CONTACTED. No provider, CDN, resolver, container, media server or host was reached, and" >&2
echo "no credential value, object reference, URL, origin or allowlist member was read out or printed." >&2
echo "This record closes no claim of any phase. It is comparable with another taken later, by digest." >&2
exit 0
