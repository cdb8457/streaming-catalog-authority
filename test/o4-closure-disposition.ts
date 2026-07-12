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

console.log('Running Phase 198 O4 final closure disposition suite:\n');

test('phase record closes O4 with a complete evidence matrix', () => {
  const doc = read('docs/PHASE_198_O4_FINAL_CLOSURE_DISPOSITION.md');
  for (const required of [
    'phase-198-o4-final-closure-disposition',
    'O4 final status: `O4_CLOSED`',
    'Disposition date: `2026-07-12`',
    'phase-198-evidence-chain-satisfied',
    'Phase 191 acceptance record',
    'commit `7990ac2`',
    'tag `phase-191`',
    'sha256:a3b1c61af28ac37b8e24ed7cfb941eb128a119a201036263e4ac2e7daee1fe8a',
    'sha256:f75d46172af9ff3c1a1c452dad4a1914958908e6a2210871510c017d6fdea0f2',
    'Phase 193',
    'Phase 196 corrected checkpoint semantics',
    'Phase 194',
    'local socket only, no public ports',
    'Phase 197',
    'commit `23444a3`',
    'tag `phase-197`',
    'post-switch manifest digest',
    'persistence manifest digest',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

test('phase record preserves the Phase 195/196 rollback and parser-fix history', () => {
  const doc = read('docs/PHASE_198_O4_FINAL_CLOSURE_DISPOSITION.md');
  for (const required of [
    'Phase 195 attempted the production custody switch and rolled back.',
    '`post_switch_doctor_failed`',
    'retained post-switch doctor output later parsed as `ok:true`',
    'Phase 196 identified the root cause as a false negative',
    'brittle text matching',
    '`ops:cutover-doctor-check`',
    'healthy',
    'unhealthy',
    'parse-error',
    'attempt=1 doctor_exit=0 parser_exit=0 verdict=healthy',
  ]) assert(doc.includes(required), `history includes ${required}`);
});

test('residual risks and O5 boundary are explicit', () => {
  const doc = read('docs/PHASE_198_O4_FINAL_CLOSURE_DISPOSITION.md');
  for (const required of [
    'Sidecar single-instance recovery',
    'Socket permission drift',
    'Rollback complexity',
    'Evidence freshness',
    'O5 status after Phase 198: `open/deferred`',
    'O4 closure does not close O5',
    'O5 final disposition: `open/deferred`',
    'Next custody gate: O5 managed KEK custody/scheduling disposition.',
  ]) assert(doc.includes(required), `residual/boundary includes ${required}`);
});

test('phase record is redaction-safe and has no runtime mutation claims', () => {
  const doc = read('docs/PHASE_198_O4_FINAL_CLOSURE_DISPOSITION.md');
  for (const required of [
    'artifact and test work only',
    'makes no runtime, Docker Compose, custody-mode, sidecar service',
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
    'O5_CLOSED',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

test('package, README, and deploy guard pin Phase 198 final status', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const readme = read('README.md');
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:o4-closure-disposition'] === 'tsx test/o4-closure-disposition.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/o4-sidecar-closure-readiness.ts && tsx test/o4-closure-disposition.ts && tsx test/runtime-cutover-plan.ts'), 'aggregate order present');
  assert(readme.includes('Phase 198 adds `docs/PHASE_198_O4_FINAL_CLOSURE_DISPOSITION.md`'), 'README phase entry');
  assert(deploy.includes('Phase 198 O4 final closure disposition'), 'deploy guard entry');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
