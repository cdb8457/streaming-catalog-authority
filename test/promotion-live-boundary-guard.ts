import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Negative live-boundary harness: statically guards the Phase 230 local-only tooling and its docs
// against live hooks. It asserts none of the local tools reach a live surface (network fetch, Jellyfin
// write/auth env, the deploy launcher, the live promotion CLI), that any fixture-promotion call is
// sandboxed, and that each local-tool doc states its non-live / no-Phase-231 boundary.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

// The Phase 230 local-only tooling (NOT real-library-promotion.ts/-cli, which is the guarded live
// promotion service). Every one of these must be reachable and side-effect-free without any live call.
const LOCAL_TOOL_SOURCES = [
  'src/ops/promotion-approval.ts', 'src/ops/promotion-approval-cli.ts',
  'src/ops/promotion-evidence-review.ts', 'src/ops/promotion-evidence-review-cli.ts',
  'src/ops/promotion-readiness.ts', 'src/ops/promotion-readiness-cli.ts',
  'src/ops/promotion-acceptance-seal.ts', 'src/ops/promotion-acceptance-seal-cli.ts',
  'src/ops/promotion-rehearsal.ts', 'src/ops/promotion-rehearsal-cli.ts',
  'src/ops/promotion-rehearsal-matrix.ts', 'src/ops/promotion-rehearsal-matrix-cli.ts',
  'src/ops/promotion-artifact-integrity.ts', 'src/ops/promotion-artifact-integrity-cli.ts',
  'src/ops/promotion-handoff.ts', 'src/ops/promotion-handoff-cli.ts',
  'src/ops/promotion-artifact-schema.ts', 'src/ops/promotion-artifact-schema-cli.ts',
  'src/ops/promotion-dashboard.ts', 'src/ops/promotion-dashboard-cli.ts',
  'src/ops/promotion-fixture-bundle.ts', 'src/ops/promotion-fixture-bundle-cli.ts',
  'src/ops/promotion-bundle-replay.ts', 'src/ops/promotion-bundle-replay-cli.ts',
  'src/ops/promotion-evidence-packet.ts', 'src/ops/promotion-evidence-packet-cli.ts',
  'src/ops/promotion-bundle-diff.ts', 'src/ops/promotion-bundle-diff-cli.ts',
  'src/ops/promotion-tamper-corpus.ts', 'src/ops/promotion-tamper-corpus-cli.ts',
  'src/ops/promotion-review-transcript.ts', 'src/ops/promotion-review-transcript-cli.ts',
  'src/ops/promotion-provenance-ledger.ts', 'src/ops/promotion-provenance-ledger-cli.ts',  'src/ops/promotion-gate-dag.ts', 'src/ops/promotion-gate-dag-cli.ts',
];

const FORBIDDEN_LIVE_HOOKS = [
  'fetch(',                         // network
  'Library/Refresh',                // Jellyfin scan/write
  'X-Emby-Token',                   // Jellyfin auth header
  'JELLYFIN_ENABLE_NETWORK',        // live Jellyfin env
  'JELLYFIN_ALLOW_LIVE_PUBLISH',
  'JELLYFIN_API_KEY',
  'JELLYFIN_BASE_URL',
  'JELLYFIN_TRIGGER_LIBRARY_SCAN',
  'unraid-real-library-promotion.sh', // deploy launcher
  'node:child_process',             // process spawning belongs only in tests
  'real-library-promotion-cli',     // the live promotion CLI
];

const LOCAL_TOOL_DOCS = [
  'docs/PHASE_230_PROMOTION_APPROVAL_ATTESTATION.md',
  'docs/PHASE_230_PROMOTION_EVIDENCE_REVIEW.md',
  'docs/PHASE_230_PROMOTION_READINESS.md',
  'docs/PHASE_230_PROMOTION_ACCEPTANCE_SEAL.md',
  'docs/PHASE_230_PROMOTION_REHEARSAL.md',
  'docs/PHASE_230_PROMOTION_REHEARSAL_MATRIX.md',
  'docs/PHASE_230_PROMOTION_ARTIFACT_INTEGRITY.md',
  'docs/PHASE_230_PROMOTION_HANDOFF.md',
  'docs/PHASE_230_PROMOTION_ARTIFACT_SCHEMA.md',
  'docs/PHASE_230_PROMOTION_DASHBOARD.md',
  'docs/PHASE_230_LOCAL_SAFETY_SUITE.md',
  'docs/PHASE_230_LOCAL_TOOLING_INDEX.md',
  'docs/PHASE_230_PROMOTION_FIXTURE_BUNDLE.md',
  'docs/PHASE_230_PROMOTION_BUNDLE_REPLAY.md',
  'docs/PHASE_230_PROMOTION_EVIDENCE_PACKET.md',
  'docs/PHASE_230_PROMOTION_BUNDLE_DIFF.md',
  'docs/PHASE_230_PROMOTION_TAMPER_CORPUS.md',
  'docs/PHASE_230_PROMOTION_REVIEW_TRANSCRIPT.md',
  'docs/PHASE_230_LOCAL_CLOSURE_INDEX.md',
  'docs/PHASE_230_PROMOTION_PROVENANCE_LEDGER.md',  'docs/PHASE_230_PROMOTION_GATE_DAG.md',
];

console.log('Running Phase 230 live-boundary guard suite:\n');

for (const rel of LOCAL_TOOL_SOURCES) {
  test(`${rel} contains no live hooks`, () => {
    const src = read(rel);
    for (const hook of FORBIDDEN_LIVE_HOOKS) {
      assert(!src.includes(hook), `${rel} must not contain live hook "${hook}"`);
    }
  });
}

test('any fixture-promotion call in the local tools is sandboxed', () => {
  for (const rel of LOCAL_TOOL_SOURCES) {
    const src = read(rel);
    if (src.includes('runRealLibraryPromotion(')) {
      assert(src.includes('allowCustomTargetRootForTests'), `${rel} runs promotion without the sandbox flag`);
      assert(src.includes('assertSandboxSafe'), `${rel} runs promotion without a sandbox-safety guard`);
    }
  }
});

test('the rehearsal is the only local tool that runs the promotion service', () => {
  const callers = LOCAL_TOOL_SOURCES.filter((rel) => read(rel).includes('runRealLibraryPromotion('));
  assert(callers.length === 1 && callers[0] === 'src/ops/promotion-rehearsal.ts', `unexpected promotion callers: ${callers.join(',')}`);
});

for (const rel of LOCAL_TOOL_DOCS) {
  test(`${rel} states its non-live / no-Phase-231 boundary`, () => {
    const doc = read(rel);
    assert(doc.includes('Phase 231'), `${rel} must reference the Phase 231 boundary`);
    assert(/no Phase 231|does not authorize Phase 231|no live-promotion|no live Jellyfin|never contacts Jellyfin/i.test(doc), `${rel} must state the non-live boundary`);
  });
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
