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

console.log('Running Phase 216 Arcane Jellyfin live capture button suite:\n');

await test('phase record defines the Arcane Jellyfin button packet', () => {
  const doc = read('docs/PHASE_216_ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON.md');
  for (const required of [
    'phase-216-arcane-jellyfin-live-capture-button',
    'ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON_READY',
    'BUTTON_READY_SECRET_STILL_REQUIRED',
    'Phase 214 secret install operator packet',
    'Phase 215 guarded launcher',
    '/mnt/user/appdata/catalog/secrets/jellyfin_api_key',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('Arcane runbook contains the guarded button and exact command', () => {
  const runbook = read('docs/PHASE_153_ARCANE_OPERATOR_RUNBOOK.md');
  for (const required of [
    '`jellyfin-live-capture`',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-jellyfin-live-capture.sh tmdb 603',
    'Runs the guarded read-only Jellyfin evidence capture after secret readiness passes.',
  ]) assert(runbook.includes(required), `runbook includes ${required}`);
});

await test('button packet forbids secret exposure and write-capable controls', () => {
  const combined = [
    read('docs/PHASE_216_ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON.md'),
    read('docs/PHASE_153_ARCANE_OPERATOR_RUNBOOK.md'),
  ].join('\n');
  for (const required of [
    'must not contain the Jellyfin API key value',
    'direct `JELLYFIN_API_KEY`',
    'JELLYFIN_ALLOW_LIVE_PUBLISH=true',
    'does not publish ports',
    'does not change Compose',
    'failure before network contact when the secret is missing',
  ]) assert(combined.includes(required), `boundary includes ${required}`);
});

await test('package, deploy guard, and README wire Phase 216 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:arcane-jellyfin-live-capture-button'] === 'tsx test/arcane-jellyfin-live-capture-button.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/scheduled-doctor-alert-fix.ts && tsx test/jellyfin-live-readonly-evidence-acceptance.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 216 Arcane Jellyfin live capture button'), 'deploy guard entry');
  assert(deploy.includes('ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON_READY'), 'deploy guard status');
  assert(readme.includes('Phase 216 adds `docs/PHASE_216_ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON.md`'), 'README ledger entry');
});

await test('phase record is redaction-safe and preserves deferred launch state', () => {
  const doc = read('docs/PHASE_216_ARCANE_JELLYFIN_LIVE_CAPTURE_BUTTON.md');
  for (const required of [
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'Phase 214 remains `JELLYFIN_SECRET_INSTALL_PACKET_READY`',
    'Phase 215 remains `JELLYFIN_LIVE_CAPTURE_LAUNCHER_READY`',
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
