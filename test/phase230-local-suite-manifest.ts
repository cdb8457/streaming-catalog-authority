import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression guard for the `test:phase230-local` harness: it must run every Phase 230 local safety
// suite and must NOT pull in the full npm-test aggregate or the legacy/live/known-failing suites (e.g.
// the CRLF-sensitive doc-string suites, embedded-Postgres suites, or live Jellyfin suites). This keeps
// the local safety gate green and self-contained. It reads package.json only.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as { scripts: Record<string, string> };
const script = pkg.scripts['test:phase230-local'] ?? '';

// Every Phase 230 local safety suite (all pass on any platform — no CRLF/live/DB dependency).
const LOCAL_SUITES = [
  'test/promotion-approval.ts',
  'test/promotion-evidence-review.ts',
  'test/promotion-readiness.ts',
  'test/promotion-acceptance-seal.ts',
  'test/real-library-promotion.ts',
  'test/promotion-rehearsal.ts',
  'test/promotion-rehearsal-matrix.ts',
  'test/promotion-artifact-integrity.ts',
  'test/promotion-artifact-schema.ts',
  'test/promotion-dashboard.ts',
  'test/promotion-handoff.ts',
  'test/promotion-fixture-bundle.ts',
  'test/promotion-bundle-replay.ts',
  'test/promotion-evidence-packet.ts',
  'test/promotion-bundle-diff.ts',
  'test/promotion-tamper-corpus.ts',
  'test/promotion-review-transcript.ts',
  'test/promotion-provenance-ledger.ts',
  'test/promotion-gate-dag.ts',
  'test/promotion-changelog.ts',
  'test/promotion-archive-manifest.ts',
  'test/promotion-acceptance-meta.ts',
  'test/promotion-injection-corpus.ts',
  'test/promotion-live-boundary-guard.ts',
  'test/phase230-local-suite-manifest.ts',
  'test/phase230-closure.ts',
];

// Legacy / live / known-failing suites that must NOT be in the local gate.
const EXCLUDED = [
  'test/real-library-promotion-boundary.ts', // CRLF-sensitive doc-string assertions
  'test/deploy.ts',                            // CRLF-sensitive + broad deploy guard
  'test/config.ts',                            // full-aggregate entry point
  'test/run.ts',                               // embedded PostgreSQL
  'test/integration.ts',
  'test/jellyfin-http.ts',                     // Jellyfin suites
  'test/jellyfin-live-evidence-capture.ts',
  'test/backup.ts',
];

console.log('Running Phase 230 local-suite manifest guard:\n');

test('test:phase230-local script is defined', () => {
  assert(script.length > 0, 'test:phase230-local must exist in package.json');
});

for (const suite of LOCAL_SUITES) {
  test(`local gate includes ${suite}`, () => {
    assert(script.includes(`tsx ${suite}`), `test:phase230-local must run ${suite}`);
  });
}

test('local gate excludes every legacy/live/known-failing suite', () => {
  for (const suite of EXCLUDED) {
    assert(!script.includes(suite), `test:phase230-local must not include ${suite}`);
  }
});

test('local gate is not the full npm-test aggregate', () => {
  assert(script !== pkg.scripts.test, 'test:phase230-local must differ from the full aggregate');
  assert(!script.includes('test/config.ts'), 'test:phase230-local must not chain the full aggregate');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
