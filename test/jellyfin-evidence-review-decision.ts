import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

console.log('Running Phase 207 Jellyfin evidence review decision suite:\n');

await test('phase record reviews phases 203-206 and defers launch pending live evidence', () => {
  const doc = read('docs/PHASE_207_JELLYFIN_EVIDENCE_REVIEW_DECISION.md');
  for (const required of [
    'phase-207-jellyfin-evidence-review-decision',
    'JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE',
    'd5c5b13',
    'phase-203',
    '55352a1',
    'phase-204',
    '10d3355',
    'phase-205',
    'c088fc4',
    'phase-206',
    'Phase 204 live read-only smoke retained and passing',
    'Phase 205 live read-only mapping retained and passing',
    'Phase 206 disposable write proof retained and passing',
    'Not satisfied',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('decision forbids runtime integration and media-scope expansion', () => {
  const doc = read('docs/PHASE_207_JELLYFIN_EVIDENCE_REVIEW_DECISION.md');
  for (const required of [
    'does not run live Jellyfin',
    'does not enable Jellyfin runtime integration',
    'does not change Compose',
    'does not change sidecar custody',
    'Jellyfin integration is not approved for launch yet',
    'Default Compose files must not enable Jellyfin networking or write mode',
    'Plex or Emby is ready',
    'provider/debrid integration is ready',
    'downloads, scraping, playback',
  ]) assert(doc.includes(required), `boundary includes ${required}`);
});

await test('O4/O5 and launch warning remain unchanged', () => {
  const doc = read('docs/PHASE_207_JELLYFIN_EVIDENCE_REVIEW_DECISION.md');
  assert(doc.includes('O4 remains `O4_CLOSED`'), 'O4 closed unchanged');
  assert(doc.includes('O5 remains `O5_DEFERRED_ACCEPTED`'), 'O5 deferred unchanged');
  assert(doc.includes('LAUNCH_WARNING_O5_DEFERRED_ACCEPTED'), 'O5 launch warning preserved');
  assert(!doc.includes('O5_CLOSED'), 'does not close O5');
});

await test('package, deploy guard, and README wire Phase 207 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:jellyfin-evidence-review-decision'] === 'tsx test/jellyfin-evidence-review-decision.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 207 Jellyfin evidence review decision'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE'), 'deploy guard status');
  assert(readme.includes('Phase 207 adds `docs/PHASE_207_JELLYFIN_EVIDENCE_REVIEW_DECISION.md`'), 'README ledger entry');
});

await test('decision record is redaction-safe', () => {
  const doc = read('docs/PHASE_207_JELLYFIN_EVIDENCE_REVIEW_DECISION.md');
  for (const forbidden of [
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'wrappedHex',
    'dekBase64',
    '192.168.',
    'http://',
    'https://',
    'O5_CLOSED',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
