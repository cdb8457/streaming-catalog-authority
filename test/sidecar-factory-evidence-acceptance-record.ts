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

console.log('Running Phase 191 sidecar evidence acceptance record suite:\n');

test('record cites Phase 190 verdict and evidence identifiers only', () => {
  const doc = read('docs/PHASE_191_SIDECAR_EVIDENCE_ACCEPTANCE_RECORD.md');
  for (const required of [
    'phase-191-sidecar-evidence-acceptance-record',
    'phase-189-sidecar-factory-evidence',
    'sha256:a3b1c61af28ac37b8e24ed7cfb941eb128a119a201036263e4ac2e7daee1fe8a',
    'phase-190-sidecar-factory-evidence-review',
    'sha256:f75d46172af9ff3c1a1c452dad4a1914958908e6a2210871510c017d6fdea0f2',
    'Phase 190 review verdict: `ok:true`',
    'Phase 190 passed files: `1`',
    'Phase 190 failed files: `0`',
    'accepted-for-o4-closure-readiness-input',
    'ready-for-o4-closure-readiness-review',
  ]) assert(doc.includes(required), `record includes ${required}`);
});

test('record enumerates verified sidecar custody behavior and exposure boundary', () => {
  const doc = read('docs/PHASE_191_SIDECAR_EVIDENCE_ACCEPTANCE_RECORD.md');
  for (const required of [
    'evidence chain is intact',
    'sidecar daemon wrapper was exercised',
    'custodian factory mode',
    'provision, commit, get, destroy',
    'fail-closed-after-destroy',
    'local socket / local IPC only',
    'no public TCP listener',
    'no service install',
    'no Compose change',
    'no runtime custody cutover',
    'provider contact, scraping, downloading, playback, and media-server mutation remained forbidden',
  ]) assert(doc.includes(required), `record verifies ${required}`);
});

test('record is redaction-safe and publishable', () => {
  const doc = read('docs/PHASE_191_SIDECAR_EVIDENCE_ACCEPTANCE_RECORD.md');
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
  ]) assert(!doc.includes(forbidden), `record excludes ${forbidden}`);
});

test('record explicitly keeps O4 and O5 open and does not mutate runtime', () => {
  const doc = read('docs/PHASE_191_SIDECAR_EVIDENCE_ACCEPTANCE_RECORD.md');
  for (const required of [
    'O4 status: `open/deferred`',
    'O5 status: `open/deferred`',
    'This record is an input to Phase 192 O4 closure readiness.',
    'not an O4 closure action',
    'not an O5 closure action',
    'not a production custody switch',
    'This record does not close O4 and does not close O5.',
    'artifact-only record',
    'does not install a service',
    'change Docker Compose',
    'switch runtime custody mode',
  ]) assert(doc.includes(required), `record preserves ${required}`);
});

test('package, README, and deploy guard include Phase 191 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const readme = read('README.md');
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:sidecar-factory-evidence-acceptance-record'] === 'tsx test/sidecar-factory-evidence-acceptance-record.ts', 'test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-factory-evidence-review.ts && tsx test/sidecar-factory-evidence-acceptance-record.ts && tsx test/o4-sidecar-closure-readiness.ts'),
    'aggregate order present',
  );
  assert(readme.includes('Phase 191 adds `docs/PHASE_191_SIDECAR_EVIDENCE_ACCEPTANCE_RECORD.md`'), 'README phase entry');
  assert(deploy.includes('Phase 191 sidecar evidence acceptance record'), 'deploy guard entry');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
