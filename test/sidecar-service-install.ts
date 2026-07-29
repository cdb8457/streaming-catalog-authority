import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';

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

function sidecarBlock(compose: string): string {
  const startMatch = /^  sidecar:\r?$/m.exec(compose);
  assert(startMatch, 'sidecar service exists');
  if (!startMatch) throw new Error('sidecar service exists');
  const start = startMatch.index;
  const endMatch = /\r?\n  app:\r?\n/.exec(compose.slice(start));
  assert(endMatch, 'sidecar service is before app');
  if (!endMatch) throw new Error('sidecar service is before app');
  const end = start + endMatch.index;
  return compose.slice(start, end);
}

console.log('Running Phase 194 sidecar service install suite:\n');

test('runtime compose preserves sidecar service after production custody switch', () => {
  const compose = read('docker-compose.unraid.runtime.yml');
  const sidecar = sidecarBlock(compose);
  assert(sidecar.includes('restart: unless-stopped'), 'sidecar restart policy');
  assert(sidecar.includes('SIDECAR_SOCKET_PATH: /run/catalog-sidecar/catalog-sidecar.sock'), 'socket env');
  assert(sidecar.includes('SIDECAR_STATE_DIR: /var/lib/catalog-sidecar/state'), 'state env');
  assert(sidecar.includes('SIDECAR_COMPLETION_SECRET_FILE: /run/secrets/completion_secret'), 'completion secret env');
  // PHASE 289. THE STEADY STATE IS ROOT-ONLY, AND THE STATIC KEK IS IN THE TEMPORARY OVERLAY.
  //
  // This used to require the static KEK in the shipped runtime file, which is what every installation ran
  // forever — with a comment telling the operator to hand-edit three lines after migrating and an upgrade
  // silently putting them back. The property that matters is unchanged: an installation that has not
  // migrated must still be able to get its static key, and that is what the overlay is for.
  assert(sidecar.includes('SIDECAR_ROOT_KEY_FILE: /run/catalog-custody/custodian_root_key'), 'root key env');
  assert(!sidecar.includes('SIDECAR_KEK_FILE'), 'and no static KEK in the steady state');
  const overlay = read('docker-compose.unraid.bootstrap.yml');
  assert(overlay.includes('SIDECAR_KEK_FILE: /run/secrets/custodian_kek'), 'the overlay wires the static KEK');
  assert(sidecar.includes('NPM_CONFIG_CACHE: /tmp/npm-cache'), 'npm cache stays on tmpfs');
  assert(sidecar.includes('command: ["ops:sidecar-daemon", "--", "--serve"]'), 'serve command');
  // PHASE 284. NOT a socket-FILE test. A socket appears the instant `listen` is called and survives a crashed
  // process, and a daemon that serves it while unable to read its keystore fails every request — which the app
  // in front of it renders as an empty catalog with no error anywhere. The check is a handshake the daemon
  // answers only after exercising its custodian.
  assert(!sidecar.includes('test -S /run/catalog-sidecar/catalog-sidecar.sock'), 'no socket-file healthcheck');
  assert(sidecar.includes('ops:sidecar-health'), 'the healthcheck is a real handshake');
  assert((compose.match(/CUSTODIAN_MODE: sidecar/g) ?? []).length >= 2, 'app and ops switched to sidecar by Phase 197');
  assert((compose.match(/CUSTODIAN_SIDECAR_SOCKET_PATH:/g) ?? []).length >= 2, 'app and ops sidecar socket configured by Phase 197');
});

test('sidecar service is socket-only and least-privilege', () => {
  const sidecar = sidecarBlock(read('docker-compose.unraid.runtime.yml'));
  for (const required of [
    '${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/sidecar/run:/run/catalog-sidecar',
    '${CATALOG_AUTHORITY_APPDATA_DIR:-/mnt/user/appdata/catalog}/sidecar/state:/var/lib/catalog-sidecar/state',
    'read_only: true',
    'tmpfs:',
    '- /tmp',
    'cap_drop:',
    '- ALL',
    'security_opt:',
    '- no-new-privileges:true',
    'pids_limit: 128',
    'mem_limit: 256m',
  ]) assert(sidecar.includes(required), `sidecar includes ${required}`);
  for (const forbidden of [
    'ports:',
    'network_mode: host',
    'privileged: true',
    '/var/run/docker.sock',
    '0.0.0.0',
    '8099:8099',
  ]) assert(!sidecar.includes(forbidden), `sidecar excludes ${forbidden}`);
});

test('phase doc records install, evidence, rollback, and non-switch status', () => {
  const doc = read('docs/PHASE_194_UNRAID_SIDECAR_SERVICE_INSTALL.md');
  for (const required of [
    'phase-194-unraid-sidecar-service-install',
    'installed-and-idle',
    'App custody mode after install: `file`',
    'Ops custody mode after install: `file`',
    'local-filecustodian-reference-harness',
    'local-unix-socket-only',
    'Public exposure: `none`',
    'phase-194-sidecar-install-evidence',
    'phase-194-sidecar-health-evidence',
    'phase-194-sidecar-exposure-proof',
    'phase-194-sidecar-restart-persistence',
    'phase-194-app-custody-unchanged',
    '## Rollback',
    'Phase 195 remains unsatisfied',
    'O4 status after install: `open/deferred`',
    'O5 status after install: `open/deferred`',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

test('phase doc and compose preserve no-provider and no-secret boundary', () => {
  const doc = read('docs/PHASE_194_UNRAID_SIDECAR_SERVICE_INSTALL.md');
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
    'C:\\',
    '\\\\.\\pipe\\',
    'http://',
    'https://',
    '192.168.',
    'localhost:',
    'o4Status: closed/authorized',
    'authorizationStatus: o4-authorized',
    'authorizesO4Closure: true',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

test('package, README, and deploy guard include Phase 194 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const readme = read('README.md');
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:sidecar-service-install'] === 'tsx test/sidecar-service-install.ts', 'test script present');
  assert(
    (AGGREGATE_SUITE_COMMAND ?? '').includes('test/runtime-cutover-plan.ts && tsx test/sidecar-service-install.ts && tsx test/sidecar-unraid-service-plan.ts'),
    'aggregate order present',
  );
  assert(readme.includes('Phase 194 adds the long-running `sidecar` service'), 'README phase entry');
  assert(deploy.includes('Phase 194 sidecar service install'), 'deploy guard entry');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
