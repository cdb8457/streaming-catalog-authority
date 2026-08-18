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

INPUT_DIR="${PROJECTION_PREENTRY_INPUT_DIR:-/mnt/user/appdata/catalog/secrets/real-provider/torbox}"
OUT=""

usage() {
  echo "usage: projection-preentry-readiness.sh [--out <file>]"
  echo
  echo "  Reads the operator's inputs and writes ONE redaction-safe observation. CONTACTS NOTHING."
  echo
  echo "  --out   where to write the observation. Defaults to stdout only."
  echo
  echo "  PROJECTION_PREENTRY_INPUT_DIR   the approved input DIRECTORY. Never a value, never a file."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) shift; OUT="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; echo "unknown argument" >&2; exit 1 ;;
  esac
  shift
done

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
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH" 2>/dev/null || true' EXIT
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

node "$SCRATCH/record.cjs" "$INPUT_DIR" "$OUT" "$SECRET_CSV" "$SHAPED_CSV" \
  || { echo "the readiness record could not be taken. NOTHING WAS CONTACTED, and an untaken record is not \
an answer about the operator's inputs." >&2; exit 1; }

echo >&2
echo "NOTHING WAS CONTACTED. No provider, CDN, resolver, container, media server or host was reached, and" >&2
echo "no credential value, object reference, URL, origin or allowlist member was read out or printed." >&2
echo "This record closes no claim of any phase. It is comparable with another taken later, by digest." >&2
exit 0
