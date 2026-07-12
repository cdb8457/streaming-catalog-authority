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

console.log('Running Phase 193 runtime cutover plan suite:\n');

test('plan declares plan-only boundary and Phase 192 relationship', () => {
  const doc = read('docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md');
  for (const required of [
    'phase-193-runtime-cutover-plan',
    'plan-only phase',
    'does not edit',
    'does not install or start the sidecar service',
    'does not satisfy Phase 194 or Phase 195',
    'Phase 192 readiness gate is present with verdict `O4_READY_PENDING_EXECUTION`',
    'This plan satisfies the Phase 193 criterion in the Phase 192 gate.',
    'Phase 194 is now unblocked.',
  ]) assert(doc.includes(required), `plan includes ${required}`);
});

test('plan defines preconditions with evidence IDs and backups', () => {
  const doc = read('docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md');
  for (const required of [
    '## Preconditions',
    'Phase 194 sidecar service install evidence exists',
    'local socket only',
    'no public ports',
    'clean pre-cutover evidence snapshot',
    'fresh backup of custody-relevant state',
    'database backup',
    'file-custodian keystore snapshot',
    'sidecar state snapshot',
    'runtime compose snapshot',
    'Phase 189 evidence digest: `sha256:a3b1c61af28ac37b8e24ed7cfb941eb128a119a201036263e4ac2e7daee1fe8a`',
    'Phase 190 review digest: `sha256:f75d46172af9ff3c1a1c452dad4a1914958908e6a2210871510c017d6fdea0f2`',
  ]) assert(doc.includes(required), `precondition includes ${required}`);
});

test('plan shows exact before and after runtime fragments', () => {
  const doc = read('docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md');
  for (const required of [
    '## Exact Runtime Diff',
    'CUSTODIAN_MODE: file',
    'COMPLETION_SECRET_FILE: /run/secrets/completion_secret',
    'CUSTODIAN_KEYSTORE_DIR: /var/lib/catalog/keystore',
    'CUSTODIAN_KEK_FILE: /run/secrets/custodian_kek',
    'CUSTODIAN_MODE: sidecar',
    'CUSTODIAN_SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock',
    '${CATALOG_AUTHORITY_APPDATA_DIR:-<canonical-appdata>}/sidecar/run:/run/catalog-sidecar',
    'completion_secret and custodian_kek are not mounted into app/ops in sidecar mode',
    'No sidecar port is published.',
  ]) assert(doc.includes(required), `diff includes ${required}`);
});

test('plan defines cutover sequence, verification matrix, rollback, and abort points', () => {
  const doc = read('docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md');
  for (const required of [
    '## Cutover Sequence',
    'Pre-check Phase 192',
    'Pre-check Phase 194',
    'Capture pre-cutover evidence',
    'Stop app only',
    'Apply the runtime diff',
    'Restart app',
    'Run post-switch evidence',
    'Run persistence-check restart',
    'Confirm UI/API health',
    '## Verification Matrix',
    '| Checkpoint | Healthy Means | Command Or Evidence |',
    '## Rollback',
    'Rollback direction: `CUSTODIAN_MODE=sidecar` back to `CUSTODIAN_MODE=file`.',
    'Rollback triggers:',
    'Data-safety notes:',
    '## Abort Points',
    'Safe abort points:',
    'Not-safe-to-ignore points:',
  ]) assert(doc.includes(required), `procedure includes ${required}`);
});

test('plan keeps O4 and O5 open and excludes unsafe material', () => {
  const doc = read('docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md');
  for (const required of [
    'O4 status after this phase: `open/deferred`',
    'O5 status after this phase: `open/deferred`',
    'It does not close O4',
    'does not close O5',
    'does not authorize production custody switch execution',
  ]) assert(doc.includes(required), `status includes ${required}`);
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
  ]) assert(!doc.includes(forbidden), `plan excludes ${forbidden}`);
});

test('package, README, and deploy guard include Phase 193 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const readme = read('README.md');
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:runtime-cutover-plan'] === 'tsx test/runtime-cutover-plan.ts', 'test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/o4-sidecar-closure-readiness.ts && tsx test/runtime-cutover-plan.ts && tsx test/sidecar-service-install.ts && tsx test/production-custody-switch.ts && tsx test/sidecar-unraid-service-plan.ts'),
    'aggregate order present',
  );
  assert(readme.includes('Phase 193 adds `docs/PHASE_193_RUNTIME_CUTOVER_PLAN.md`'), 'README phase entry');
  assert(deploy.includes('Phase 193 runtime cutover plan'), 'deploy guard entry');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
