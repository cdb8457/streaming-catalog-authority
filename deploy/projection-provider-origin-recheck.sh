#!/usr/bin/env bash
# IS THE PROVIDER'S CURRENT CDN ORIGIN STILL IN THE OPERATOR'S ALLOWLIST? One question, one word out.
#
# WHY THIS EXISTS. Projection Phase 3 is blocked because TorBox rotated the CDN origin it hands back and the
# operator's `allowedOrigins` no longer names it, so `projectiond` refuses every resolved URL and every read
# fails EIO. `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6.16 records the same thing happening once before
# and documents the allowlist as PERISHABLE. Rechecking it should not cost a forty-minute gate run, and
# guessing from a stale note is how a tranche wastes a night.
#
# WHAT IT MAY AND MAY NOT EMIT. The resolved URL, its host, the stable reference, the object's identity and
# both secrets NEVER leave the container that already holds them. The comparison happens in there and what
# comes out is a status, a boolean, a count, a scheme and ONE-WAY DIGESTS — the same `opaqueRef` idea the
# media-server reports use, so two runs can be compared without either naming anything.
#
# WHAT IT MUTATES: NOTHING. It reads the four operator inputs read-only, copies the two secrets at 0600 into
# a 0700 scratch directory it removes on the way out, and writes one redaction-safe observation into the
# reliability loop's existing evidence directory. It never edits `endpoint.json`, never touches provider or
# account state, and never writes anywhere else.
#
# WHAT IT COSTS THE OPERATOR'S ACCOUNT: one resolution. No ranged GET, no byte of media.
#
#   exit 0   the resolved origin IS allowed      -> the blocker is gone; the loop can run
#   exit 70  the resolved origin is NOT allowed  -> the blocker stands; running the loop would be futile
#   exit 77  the operator has supplied nothing   -> nothing was contacted
#   exit 1   the measurement could not be taken  -> NOT the same as "not allowed", and never reported as it
set -euo pipefail
export MSYS_NO_PATHCONV=1

NODE_IMAGE="node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"
INPUT_DIR="${PROJECTION_TORBOX_INPUT_DIR:-/mnt/user/appdata/catalog/secrets/real-provider/torbox}"
RESOLVER_PORT="${PROJECTION_ORIGIN_RECHECK_PORT:-8145}"
EVIDENCE_DIR="$PWD/.projection-reliability-loop-gate/evidence"
CONTAINER="projection-origin-recheck-$$"
SCRATCH=""

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [ -n "$SCRATCH" ] && rm -rf "$SCRATCH" 2>/dev/null || true
}
trap cleanup EXIT

missing=""
for f in torbox-credential credential objects.json endpoint.json; do
  [ -f "$INPUT_DIR/$f" ] || missing="$missing $f"
done
if [ -n "$missing" ]; then
  echo "SKIPPED (status 77): the operator has supplied no corpus. Missing:$missing" >&2
  echo "      NOTHING WAS CONTACTED. This is not an answer about the allowlist." >&2
  exit 77
fi

SCRATCH="$(mktemp -d)"
chmod 700 "$SCRATCH"
install -m 600 "$INPUT_DIR/torbox-credential" "$SCRATCH/torbox-credential"
install -m 600 "$INPUT_DIR/credential" "$SCRATCH/gate-secret"
install -m 600 "$INPUT_DIR/objects.json" "$SCRATCH/objects.json"
install -m 600 "$INPUT_DIR/endpoint.json" "$SCRATCH/endpoint.json"

cat > "$SCRATCH/compare.cjs" <<'COMPARE'
// Resolves ONE reference through the operator's own resolver and answers the question with words.
//
// NOTHING IT LEARNS IS PRINTED. The URL is parsed, its origin is compared, and the origin itself is emitted
// only as the first 12 hex of its sha256 — enough to tell two runs apart, not enough to be a locator. The
// same is done for each allowlisted origin so a reader can see WHICH one it failed to match, without
// learning any of them.
const { readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const http = require('node:http');
const port = Number(process.argv[2]);
const out = process.argv[3];
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

const objects = JSON.parse(readFileSync('/inputs/objects.json', 'utf8'));
const endpoint = JSON.parse(readFileSync('/inputs/endpoint.json', 'utf8'));
const secret = readFileSync('/inputs/gate-secret', 'utf8').trim();
const allowed = (endpoint.allowedOrigins || []).map((origin) => String(origin).replace(/\/$/, ''));
const observation = {
  observedAtUnixMs: Date.now(),
  allowedOriginCount: allowed.length,
  allowedOriginDigests: allowed.map(digest),
};
const finish = (extra, status) => {
  Object.assign(observation, extra);
  for (const [key, value] of Object.entries(observation)) {
    if (Array.isArray(value)) for (const entry of value) console.log(`${key}=${entry}`);
    else console.log(`${key}=${String(value)}`);
  }
  writeFileSync(out, `${JSON.stringify(observation, null, 2)}\n`);
  process.exit(status);
};

const body = JSON.stringify({ objectRef: objects[0].ref });
const req = http.request({
  host: '127.0.0.1', port, path: '/resolve', method: 'POST', timeout: 30000,
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    Authorization: `Bearer ${secret}` },
}, (res) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => {
    if (res.statusCode !== 200) {
      // A RESOLVER THAT WOULD NOT ANSWER IS NOT AN ANSWER ABOUT THE ALLOWLIST, and it exits 1 rather than
      // 70 for exactly that reason: "could not measure" and "measured, and disallowed" are different facts.
      finish({ resolverStatus: res.statusCode, resolved: 'no', verdict: 'not-measured' }, 1);
    }
    let url;
    try {
      url = new URL(JSON.parse(Buffer.concat(chunks).toString('utf8')).url);
    } catch {
      finish({ resolverStatus: 200, resolved: 'unparseable', verdict: 'not-measured' }, 1);
      return;
    }
    const isAllowed = allowed.includes(url.origin);
    finish({
      resolverStatus: 200,
      resolved: 'yes',
      resolvedOriginScheme: url.protocol.replace(':', ''),
      resolvedOriginDigest: digest(url.origin),
      resolvedOriginInAllowlist: isAllowed ? 'yes' : 'NO',
      verdict: isAllowed ? 'allowed' : 'disallowed',
    }, isAllowed ? 0 : 70);
  });
});
req.on('timeout', () => { req.destroy(); finish({ resolverStatus: 'timeout', verdict: 'not-measured' }, 1); });
req.on('error', () => finish({ resolverStatus: 'unreachable', verdict: 'not-measured' }, 1));
req.end(body);
COMPARE

# THE RESOLVER IS LOOPBACK-ONLY AND UNPUBLISHED, exactly as the real gate runs it: a resolver anything on the
# network could reach is a credential oracle. No --fixture-mode, so it is pinned to the official origin.
docker run -d --name "$CONTAINER" \
  -v "$PWD:/workspace:ro" -w /workspace -v "$SCRATCH:/inputs:ro" \
  -e npm_config_update_notifier=false \
  "$NODE_IMAGE" ./node_modules/.bin/tsx src/ops/torbox-resolver-cli.ts serve \
  --credential /inputs/torbox-credential --gate-secret /inputs/gate-secret \
  --port "$RESOLVER_PORT" >/dev/null \
  || { echo "the resolver did not start; nothing was measured" >&2; exit 1; }

ready=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" node -e \
    "require('node:net').connect($RESOLVER_PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" \
    >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
test "$ready" -eq 1 || { echo "the resolver never came up; nothing was measured" >&2; exit 1; }

set +e
docker exec "$CONTAINER" node /inputs/compare.cjs "$RESOLVER_PORT" /inputs/observation.json
status=$?
set -e

# THE OBSERVATION IS PRESERVED WHERE THE LOOP'S OTHER EVIDENCE ALREADY LIVES, at 0600 under a 0700 directory,
# and it is the same redaction-safe document that was printed. It cannot hold a URL, a host, a reference or a
# secret, because the program that wrote it never put one in.
if docker cp "$CONTAINER:/inputs/observation.json" "$SCRATCH/observation.json" >/dev/null 2>&1; then
  mkdir -p "$EVIDENCE_DIR" && chmod 700 "$EVIDENCE_DIR"
  kept="$EVIDENCE_DIR/origin-recheck-$(date -u +%Y%m%dT%H%M%SZ).json"
  cp "$SCRATCH/observation.json" "$kept" && chmod 600 "$kept"
  echo "  observation kept at .projection-reliability-loop-gate/evidence/$(basename "$kept")"
fi

case "$status" in
  0)  echo "  THE BLOCKER IS GONE: the origin the provider now returns is in the operator's allowlist." ;;
  70) echo "  THE BLOCKER STANDS: the origin the provider now returns is NOT in the operator's allowlist." >&2
      echo "  This is the egress allowlist working. Running the full loop would fail on the first read." >&2 ;;
  *)  echo "  NOT MEASURED. This is not the same as 'not allowed' and must not be reported as it." >&2 ;;
esac
exit "$status"
