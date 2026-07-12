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

function serviceBlock(compose: string, name: 'ops' | 'app' | 'sidecar'): string {
  const start = compose.indexOf(`  ${name}:\n`);
  assert(start >= 0, `${name} service exists`);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  [a-z][a-z0-9_-]*:\n/);
  return next >= 0 ? compose.slice(start, start + 1 + next) : compose.slice(start);
}

console.log('Running Phase 195 production custody switch suite:\n');

test('runtime compose switches app and ops to sidecar custody', () => {
  const compose = read('docker-compose.unraid.runtime.yml');
  for (const service of ['ops', 'app'] as const) {
    const block = serviceBlock(compose, service);
    assert(block.includes('CUSTODIAN_MODE: sidecar'), `${service} sidecar mode`);
    assert(block.includes('CUSTODIAN_SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock'), `${service} socket env`);
    assert(block.includes('${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/sidecar/run:/run/catalog-sidecar'), `${service} socket mount`);
    assert(!block.includes('CUSTODIAN_MODE: file'), `${service} not file mode`);
    assert(!block.includes('COMPLETION_SECRET_FILE:'), `${service} no app-held completion secret`);
    assert(!block.includes('CUSTODIAN_KEYSTORE_DIR:'), `${service} no file keystore dir`);
    assert(!block.includes('CUSTODIAN_KEK_FILE:'), `${service} no app-held KEK`);
    assert(!block.includes('/var/lib/catalog/keystore'), `${service} no file-custodian keystore mount`);
    assert(!block.includes('- completion_secret'), `${service} no completion secret mount`);
    assert(!block.includes('- custodian_kek'), `${service} no KEK secret mount`);
  }
});

test('sidecar remains socket-only and privileged settings stay forbidden', () => {
  const sidecar = serviceBlock(read('docker-compose.unraid.runtime.yml'), 'sidecar');
  for (const required of [
    'restart: unless-stopped',
    'test -S /run/catalog-sidecar/catalog-sidecar.sock',
    'read_only: true',
    'cap_drop:',
    '- ALL',
    '- no-new-privileges:true',
  ]) assert(sidecar.includes(required), `sidecar keeps ${required}`);
  for (const forbidden of [
    'ports:',
    'network_mode: host',
    'privileged: true',
    '/var/run/docker.sock',
  ]) assert(!sidecar.includes(forbidden), `sidecar excludes ${forbidden}`);
});

test('doctor and operator UI status are sidecar-cutover ready', () => {
  const doctor = read('src/ops/doctor.ts');
  const doctorCli = read('src/ops/doctor-cli.ts');
  const ui = read('src/ops/operator-ui-service.ts');
  const opsDoctorTest = read('test/ops-doctor.ts');
  for (const required of [
    'completion secret is delegated to the sidecar custodian',
    "custodianConfig.mode === 'sidecar'",
    'doctor - sidecar mode delegates completion secret out of app/ops',
  ]) assert(`${doctor}\n${doctorCli}\n${ui}\n${opsDoctorTest}`.includes(required), `sidecar doctor readiness includes ${required}`);
});

test('phase record captures execution, evidence, rollback, and O4/O5 status', () => {
  const doc = read('docs/PHASE_195_PRODUCTION_CUSTODY_SWITCH.md');
  for (const required of [
    'phase-195-production-custody-switch',
    'executed-as-written',
    'file-to-sidecar',
    'phase-195-precondition-evidence',
    'phase-195-pre-cutover-evidence-snapshot',
    'phase-195-custody-state-backup-verified',
    'phase-195-runtime-diff-evidence',
    'phase-195-post-switch-custody-evidence',
    'phase-195-sidecar-exposure-proof',
    'phase-195-restart-persistence-evidence',
    'phase-195-ui-api-health-evidence',
    'O4 status after Phase 195: `closure-eligible`',
    'O5 status after Phase 195: `open/deferred`',
    'O5 remains unchanged and out of scope',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

test('package, README, and deploy guard include Phase 195 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const readme = read('README.md');
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:production-custody-switch'] === 'tsx test/production-custody-switch.ts', 'test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/sidecar-service-install.ts && tsx test/production-custody-switch.ts && tsx test/sidecar-unraid-service-plan.ts'),
    'aggregate order present',
  );
  assert(readme.includes('Phase 195 executes the production custody switch'), 'README phase entry');
  assert(deploy.includes('Phase 195 production custody switch'), 'deploy guard entry');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
