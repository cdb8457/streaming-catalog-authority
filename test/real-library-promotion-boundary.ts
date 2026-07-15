import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

console.log('Running Phase 229 real-library promotion boundary suite:\n');

test('Phase 229 defines promotion as explicit operator-approved copy only', () => {
  const doc = read('docs/PHASE_229_REAL_LIBRARY_PROMOTION_BOUNDARY.md');
  for (const required of [
    'phase-229-real-library-promotion-boundary',
    'PHASE_229_REAL_LIBRARY_PROMOTION_PLAN_READY',
    'operator-approved copy',
    'Promotion is never automatic',
    'PROMOTION_APPROVED=true',
    'PROMOTION_APPROVAL_REQUIRED',
    'one-shot for the selected item and destination',
    '`/mnt/user/media/Movies`',
    '`/mnt/user/media/Movies/<Title> (<Year>)/<Title> (<Year>).<ext>`',
  ]) assert(doc.includes(required), `Phase 229 record includes ${required}`);
});

test('Phase 229 records collision and rollback policy', () => {
  const doc = read('docs/PHASE_229_REAL_LIBRARY_PROMOTION_BOUNDARY.md');
  for (const required of [
    'Promotion must never overwrite an existing real-library file',
    'PROMOTION_ALREADY_PRESENT',
    'PROMOTION_DESTINATION_COLLISION',
    'no rename, suffixing, overwrite, or replacement is allowed',
    'Withdrawal means removing only the file that Phase 230 promoted',
    'PROMOTION_WITHDRAWAL_REFUSED',
    'PROMOTION_WITHDRAWAL_FAILED',
    'real Movies subtree returns to the prior digest',
  ]) assert(doc.includes(required), `Phase 229 safety policy includes ${required}`);
});

test('Phase 229 extends lifecycle and keeps verification observed-state only', () => {
  const doc = read('docs/PHASE_229_REAL_LIBRARY_PROMOTION_BOUNDARY.md');
  for (const required of [
    '`VISIBLE_IN_JELLYFIN -> PROMOTION_APPROVED -> PROMOTED -> VISIBLE_IN_REAL_LIBRARY`',
    '`PROMOTION_FAILED`',
    '`VISIBLE_IN_JELLYFIN` | `PROMOTION_APPROVED`',
    '`PROMOTION_APPROVED` | `PROMOTED`',
    '`PROMOTED` | `VISIBLE_IN_REAL_LIBRARY`',
    'observed state only, not\naccepted commands or HTTP status codes alone',
    'bounded retry\nwindow is required',
  ]) assert(doc.includes(required), `Phase 229 state machine includes ${required}`);
});

test('Phase 229 forbids Gelato, AIO, providers, downloads, playback, and automatic writes', () => {
  const doc = read('docs/PHASE_229_REAL_LIBRARY_PROMOTION_BOUNDARY.md');
  for (const required of [
    'any Gelato path',
    'any AIO Streams path',
    'Gelato and AIO Streams may remain installed and usable by Jellyfin',
    'they are not promotion\ntargets',
    'provider, downloader, scraper, playback, or media-server-write side effects',
    'Phase 230 is unblocked',
  ]) assert(doc.includes(required), `Phase 229 boundary includes ${required}`);
  for (const forbidden of [
    'provider live mode enabled',
    'download enabled',
    'playback enabled',
    'scraping enabled',
    'automatic promotion enabled',
    'JELLYFIN_WRITE_CAPABLE_LAUNCH_ELIGIBLE',
  ]) assert(!doc.includes(forbidden), `Phase 229 boundary excludes ${forbidden}`);
});

test('Phase 229 is wired into README and package scripts', () => {
  const readme = read('README.md');
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(readme.includes('Phase 229 adds `docs/PHASE_229_REAL_LIBRARY_PROMOTION_BOUNDARY.md`'), 'README ledger entry');
  assert(pkg.scripts['test:real-library-promotion-boundary'] === 'tsx test/real-library-promotion-boundary.ts', 'phase test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/real-library-promotion-boundary.ts && tsx test/real-library-promotion.ts && tsx test/deploy.ts'),
    'aggregate test runs promotion boundary before deploy guard',
  );
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
