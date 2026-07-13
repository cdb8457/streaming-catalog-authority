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

console.log('Running Phase 199 O5 final disposition suite:\n');

test('phase record formally accepts O5 deferral with launch warning', () => {
  const doc = read('docs/PHASE_199_O5_FINAL_DISPOSITION.md');
  for (const required of [
    'phase-199-o5-final-disposition',
    'Disposition date: `2026-07-13`',
    'O5_DEFERRED_ACCEPTED',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'explicit disposition, not a lingering open state',
    'not authorize any claim of `O5_CLOSED`',
    'managed KEK custody and scheduling gate',
    'no managed KEK custody service has been accepted',
    'no repository-owned automated KEK rotation scheduler is enabled',
    'Historical Phase 117 through Phase 119 O5 authorization tools',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

test('phase record cites O4 closure context without changing O4', () => {
  const doc = read('docs/PHASE_199_O5_FINAL_DISPOSITION.md');
  for (const required of [
    'O4_CLOSED',
    'Phase 198 closed O4',
    'commit `a3681d3`',
    'tag `phase-198`',
    'O4 closure confirms the sidecar custody path',
    'That sidecar posture does not close O5',
    'O4 remains `O4_CLOSED`; this phase does not edit O4 closure evidence.',
  ]) assert(doc.includes(required), `O4 context includes ${required}`);
});

test('residual risks and reopening criteria are concrete', () => {
  const doc = read('docs/PHASE_199_O5_FINAL_DISPOSITION.md');
  for (const required of [
    'No automated KEK rotation cadence.',
    'Manual recovery burden for KEK-related incidents.',
    'Single-custodian exposure window',
    'Human process drift around KEK custody review.',
    'Delayed O5 closure after launch.',
    'suspected KEK compromise',
    'sidecar custody incident',
    'multi-user, shared, or production-scale',
    'provider live mode, download orchestration, playback orchestration, or media-server',
    '90 days have elapsed',
  ]) assert(doc.includes(required), `risk/reopen includes ${required}`);
});

test('launch warning is visible in launch-facing docs', () => {
  const readme = read('README.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');
  const dashboard = read('docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md');
  for (const required of [
    'Phase 199 adds `docs/PHASE_199_O5_FINAL_DISPOSITION.md`',
    'O5_DEFERRED_ACCEPTED',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
  ]) assert(readme.includes(required), `README includes ${required}`);
  for (const required of [
    'Launch custody warning',
    'O4: `O4_CLOSED`',
    'O5: `O5_DEFERRED_ACCEPTED`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'Do not claim `O5_CLOSED`',
  ]) assert(checklist.includes(required), `release checklist includes ${required}`);
  for (const required of [
    'O4     Closed',
    'O5     Deferred accepted',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
  ]) assert(dashboard.includes(required), `dashboard examples include ${required}`);
});

test('package and deploy guard pin the final O5 disposition', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:o5-disposition'] === 'tsx test/o5-disposition.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/o5-kek-final-authorization.ts && tsx test/o5-disposition.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 199 O5 final disposition'), 'deploy guard entry');
  assert(deploy.includes('O5_DEFERRED_ACCEPTED'), 'deploy guard pins O5 disposition');
  assert(deploy.includes('LAUNCH_WARNING_O5_DEFERRED_ACCEPTED'), 'deploy guard pins warning');
});

test('record remains redaction-safe and artifact-only', () => {
  const doc = read('docs/PHASE_199_O5_FINAL_DISPOSITION.md');
  for (const required of [
    'artifact and test work only',
    'makes no runtime, Docker Compose, custody-mode',
    'sidecar service',
  ]) assert(doc.includes(required), `boundary includes ${required}`);
  for (const forbidden of [
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'token:',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'wrappedHex',
    'dekBase64',
    '/mnt/user/',
    '/boot/config/',
    'C:\\',
    '\\\\.\\pipe\\',
    'http://',
    'https://',
    '192.168.',
    'localhost:',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
