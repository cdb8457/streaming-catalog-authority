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

console.log('Running Phase 214 Jellyfin secret install operator packet suite:\n');

await test('phase record defines the redaction-safe secret install packet', () => {
  const doc = read('docs/PHASE_214_JELLYFIN_SECRET_INSTALL_OPERATOR_PACKET.md');
  for (const required of [
    'phase-214-jellyfin-secret-install-operator-packet',
    'JELLYFIN_SECRET_INSTALL_PACKET_READY',
    'SECRET_INSTALL_PACKET_READY_LIVE_CAPTURE_STILL_BLOCKED',
    '/mnt/user/appdata/catalog/secrets/jellyfin_api_key',
    'read -rsp',
    'unset JELLYFIN_KEY',
    'chmod 600',
    'Do not use `echo <api-key> > ...`',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('readiness and capture commands use repo-ops container shape', () => {
  const doc = read('docs/PHASE_214_JELLYFIN_SECRET_INSTALL_OPERATOR_PACKET.md');
  for (const required of [
    'docker run --rm',
    '-v /mnt/user/appdata/catalog/secrets/jellyfin_api_key:/run/secrets/jellyfin_api_key:ro',
    '-e JELLYFIN_API_KEY_FILE=/run/secrets/jellyfin_api_key',
    'repo-ops:latest',
    'npm run ops:jellyfin-secret-readiness',
    'JELLYFIN_SECRET_READY',
    'npm run ops:jellyfin-live-evidence-capture --',
    '--out /evidence/phase-211-jellyfin-live-readonly-smoke.json',
  ]) assert(doc.includes(required), `command surface includes ${required}`);
});

await test('phase record preserves no-install no-port and no-live-contact boundaries', () => {
  const doc = read('docs/PHASE_214_JELLYFIN_SECRET_INSTALL_OPERATOR_PACKET.md');
  for (const required of [
    'does not create the secret',
    'does not contact Jellyfin',
    'does not install Jellyfin',
    'does not add a Jellyfin container',
    'does not bind ports',
    'does not change Compose',
    'does not change custody mode',
    'does not expose or publish any new port',
    'binding port `8096`, `8920`, `8099`, or `32400`',
  ]) assert(doc.includes(required), `boundary includes ${required}`);
});

await test('package, deploy guard, and README wire Phase 214 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:jellyfin-secret-install-operator-packet'] === 'tsx test/jellyfin-secret-install-operator-packet.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 214 Jellyfin secret install operator packet'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_SECRET_INSTALL_PACKET_READY'), 'deploy guard status');
  assert(readme.includes('Phase 214 adds `docs/PHASE_214_JELLYFIN_SECRET_INSTALL_OPERATOR_PACKET.md`'), 'README ledger entry');
});

await test('phase record is redaction-safe and preserves deferred launch state', () => {
  const doc = read('docs/PHASE_214_JELLYFIN_SECRET_INSTALL_OPERATOR_PACKET.md');
  for (const required of [
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'Phase 210 remains `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`',
    'Phase 211 remains `LIVE_EVIDENCE_CAPTURE_COMMAND_READY_AWAITING_SECRET`',
    'Phase 212 remains `JELLYFIN_SECRET_READINESS_GATE_READY`',
    'Phase 213 remains `JELLYFIN_CONTAINER_COMMAND_SHAPE_READY`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(doc.includes(required), `status includes ${required}`);
  for (const forbidden of [
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
    'provider mode enabled',
    'playback enabled',
    'download enabled',
    '192.168.',
    'postgres://',
    'postgresql://',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
