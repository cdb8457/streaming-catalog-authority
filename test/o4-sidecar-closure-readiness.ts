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

console.log('Running Phase 192 O4 sidecar closure readiness suite:\n');

test('gate cites Phase 191 source artifact and Phase 190 passing evidence', () => {
  const doc = read('docs/PHASE_192_O4_SIDECAR_CLOSURE_READINESS.md');
  for (const required of [
    'phase-192-o4-sidecar-closure-readiness',
    'phase-191-sidecar-evidence-acceptance-record',
    'commit `7990ac2`',
    'tag `phase-191`',
    'sha256:a3b1c61af28ac37b8e24ed7cfb941eb128a119a201036263e4ac2e7daee1fe8a',
    'sha256:f75d46172af9ff3c1a1c452dad4a1914958908e6a2210871510c017d6fdea0f2',
    'Phase 190 review verdict: `ok:true`',
    'Phase 190 review counts: `reviewed:1`, `passed:1`, `failed:0`',
    'accepted-for-o4-closure-readiness-input',
  ]) assert(doc.includes(required), `gate cites ${required}`);
});

test('criteria matrix has all O4 execution criteria satisfied after Phase 195', () => {
  const doc = read('docs/PHASE_192_O4_SIDECAR_CLOSURE_READINESS.md');
  for (const required of [
    '| Criterion | Required Evidence | Current State | Status |',
    'Phase 191 acceptance record exists, is redaction-safe, and cites Phase 190 passing evidence',
    '`satisfied`',
    'Runtime cutover plan exists and is reviewed',
    'Present and reviewed',
    'Sidecar service installed on Unraid, local socket only, no public ports',
    'Installed, healthy, socket-only, no public ports',
    'Production custody switched with post-switch evidence, persistence checks restarted, UI/API healthy',
    'Switched with post-switch evidence retained',
  ]) assert(doc.includes(required), `criteria includes ${required}`);
});

test('readiness verdict is closure-eligible and keeps O5 open', () => {
  const doc = read('docs/PHASE_192_O4_SIDECAR_CLOSURE_READINESS.md');
  for (const required of [
    'Readiness verdict: `O4_CLOSURE_ELIGIBLE`',
    'O4 closure criteria are explicitly defined.',
    'Phase 193 runtime cutover plan evidence is satisfied.',
    'Phase 194 sidecar service install evidence is satisfied.',
    'Phase 195 production custody switch evidence is satisfied.',
    'O4 status after this gate: `closure-eligible`',
    'O5 status after this gate: `open/deferred`',
    'O5 is unchanged and out of scope for this gate.',
    'This gate does not close O5.',
  ]) assert(doc.includes(required), `verdict includes ${required}`);
});

test('gate is redaction-safe and artifact-only', () => {
  const doc = read('docs/PHASE_192_O4_SIDECAR_CLOSURE_READINESS.md');
  for (const required of [
    'No runtime, Docker Compose, sidecar service, custody-mode, provider, playback, or media-server',
    'Allowed in this phase:',
    'Forbidden in this phase:',
    'closing O4',
    'closing O5',
    'changing Docker Compose',
    'switching runtime custody mode',
    'installing or starting a production sidecar service',
    'publishing ports',
    'contacting providers',
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
    'o4Status: closed/authorized',
    'authorizationStatus: o4-authorized',
    'authorizesO4Closure: true',
  ]) assert(!doc.includes(forbidden), `gate excludes ${forbidden}`);
});

test('package, README, and deploy guard include Phase 192 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const readme = read('README.md');
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:o4-sidecar-closure-readiness'] === 'tsx test/o4-sidecar-closure-readiness.ts', 'test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-factory-evidence-acceptance-record.ts && tsx test/o4-sidecar-closure-readiness.ts && tsx test/runtime-cutover-plan.ts && tsx test/sidecar-service-install.ts && tsx test/production-custody-switch.ts && tsx test/sidecar-unraid-service-plan.ts'),
    'aggregate order present',
  );
  assert(readme.includes('Phase 192 adds `docs/PHASE_192_O4_SIDECAR_CLOSURE_READINESS.md`'), 'README phase entry');
  assert(deploy.includes('Phase 192 O4 sidecar closure readiness gate'), 'deploy guard entry');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
