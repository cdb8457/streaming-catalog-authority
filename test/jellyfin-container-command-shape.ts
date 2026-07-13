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

console.log('Running Phase 213 Jellyfin container command shape suite:\n');

await test('phase record corrects host npm command to containerized repo-ops execution', () => {
  const doc = read('docs/PHASE_213_JELLYFIN_CONTAINER_COMMAND_SHAPE_FIX.md');
  for (const required of [
    'phase-213-jellyfin-container-command-shape-fix',
    'JELLYFIN_CONTAINER_COMMAND_SHAPE_READY',
    'CONTAINER_COMMAND_SHAPE_FIXED_SECRET_STILL_MISSING',
    'direct host `npm run ops:jellyfin-secret-readiness` exits `127`',
    'repo-ops:latest',
    'docker run --rm',
    'JELLYFIN_SECRET_NOT_READY',
    'JELLYFIN_SECRET_READY',
    'mounting a missing secret path',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('secret readiness command has absent-secret and mounted-secret shapes', () => {
  const doc = read('docs/PHASE_213_JELLYFIN_CONTAINER_COMMAND_SHAPE_FIX.md');
  assert(doc.includes('-e JELLYFIN_API_KEY_FILE=/run/secrets/jellyfin_api_key'), 'container env path');
  assert(doc.includes('-v /mnt/user/appdata/catalog/secrets/jellyfin_api_key:/run/secrets/jellyfin_api_key:ro'), 'read-only secret mount');
  assert(doc.includes('npm run ops:jellyfin-secret-readiness'), 'readiness script');
});

await test('live evidence capture command mounts secret and evidence only', () => {
  const doc = read('docs/PHASE_213_JELLYFIN_CONTAINER_COMMAND_SHAPE_FIX.md');
  for (const required of [
    '-v /mnt/user/appdata/catalog/secrets/jellyfin_api_key:/run/secrets/jellyfin_api_key:ro',
    '-v /mnt/user/appdata/catalog/evidence:/evidence',
    '-e JELLYFIN_ENABLE_NETWORK=true',
    '-e JELLYFIN_BASE_URL=http://<unraid-host>:8096',
    'npm run ops:jellyfin-live-evidence-capture --',
    '--out /evidence/phase-211-jellyfin-live-readonly-smoke.json',
    'does not expose or publish any new port',
  ]) assert(doc.includes(required), `capture command includes ${required}`);
});

await test('package, deploy guard, and README wire Phase 213 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:jellyfin-container-command-shape'] === 'tsx test/jellyfin-container-command-shape.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 213 Jellyfin container command shape fix'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_CONTAINER_COMMAND_SHAPE_READY'), 'deploy guard status');
  assert(readme.includes('Phase 213 adds `docs/PHASE_213_JELLYFIN_CONTAINER_COMMAND_SHAPE_FIX.md`'), 'README ledger entry');
});

await test('phase record is redaction-safe and preserves deferred launch state', () => {
  const doc = read('docs/PHASE_213_JELLYFIN_CONTAINER_COMMAND_SHAPE_FIX.md');
  for (const required of [
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'Phase 210 remains `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`',
    'Phase 211 remains `LIVE_EVIDENCE_CAPTURE_COMMAND_READY_AWAITING_SECRET`',
    'Phase 212 remains `JELLYFIN_SECRET_READINESS_GATE_READY`',
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

