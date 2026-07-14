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

console.log('Running Phase 218 Jellyfin live read-only evidence acceptance suite:\n');

await test('phase record accepts the retained live read-only smoke evidence by digest', () => {
  const doc = read('docs/PHASE_218_JELLYFIN_LIVE_READONLY_EVIDENCE_ACCEPTANCE.md');
  for (const required of [
    'phase-218-jellyfin-live-readonly-evidence-acceptance',
    'phase-211-jellyfin-live-readonly-smoke.json',
    'cd3dd6b2b10725f5115376a56400a7c42e33bc59784cf8701f73da8353cebde9',
    '24641bd15aeb533b31611f2787df46d21bbbbc943b825a4c89fae1f9ab518101',
    '2026-07-14T02:21:15.929Z',
    'phase-209-jellyfin-live-readonly-smoke',
    'JELLYFIN_LIVE_READONLY_SMOKE_PASS',
    'JELLYFIN_LIVE_READONLY_SMOKE_ACCEPTED',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('acceptance matrix preserves read-only and redaction-safe facts', () => {
  const doc = read('docs/PHASE_218_JELLYFIN_LIVE_READONLY_EVIDENCE_ACCEPTANCE.md');
  for (const required of [
    'Valid JSON',
    '`ok: true`',
    '`redactionSafe: true`',
    '`hostEchoed: false`',
    '`existingServerOnly: true`',
    '`installAttempted: false`',
    '`newPortBindingAttempted: false`',
    '`apiKeyEchoed: false`',
    '`writeMode: false`',
    '`GET /System/Info`',
    '`GET /Items`',
    'forbidden `POST`, `PUT`, `PATCH`, `DELETE`, playback, downloads, providers, scraping, and catalog mutation',
  ]) assert(doc.includes(required), `acceptance includes ${required}`);
});

await test('acceptance does not launch integration or expand media scope', () => {
  const doc = read('docs/PHASE_218_JELLYFIN_LIVE_READONLY_EVIDENCE_ACCEPTANCE.md');
  for (const required of [
    'does not contact Jellyfin',
    'does not install Jellyfin',
    'does not add a Jellyfin container',
    'does not bind ports',
    'does not change Compose',
    'does not change sidecar custody',
    'does not enable writes',
    'does not launch runtime Jellyfin integration',
    'Phase 205 live read-only mapping evidence remains pending',
    'Phase 206 disposable write proof remains optional and not enabled',
  ]) assert(doc.includes(required), `boundary includes ${required}`);
  assert(!doc.includes('JELLYFIN_INTEGRATION_LAUNCHED'), 'does not claim launch');
});

await test('O4/O5 and default runtime boundaries remain unchanged', () => {
  const doc = read('docs/PHASE_218_JELLYFIN_LIVE_READONLY_EVIDENCE_ACCEPTANCE.md');
  assert(doc.includes('O4 remains `O4_CLOSED`'), 'O4 closed unchanged');
  assert(doc.includes('O5 remains `O5_DEFERRED_ACCEPTED`'), 'O5 deferred unchanged');
  assert(doc.includes('LAUNCH_WARNING_O5_DEFERRED_ACCEPTED'), 'O5 launch warning preserved');
  assert(doc.includes('Default Compose files must not enable Jellyfin networking or write mode'), 'default compose guard recorded');
  assert(!doc.includes('O5_CLOSED'), 'does not close O5');
});

await test('package, deploy guard, and README wire Phase 218 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:jellyfin-live-readonly-evidence-acceptance'] === 'tsx test/jellyfin-live-readonly-evidence-acceptance.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/scheduled-doctor-alert-fix.ts && tsx test/jellyfin-live-readonly-evidence-acceptance.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 218 Jellyfin live read-only evidence acceptance'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_LIVE_READONLY_SMOKE_ACCEPTED'), 'deploy guard status');
  assert(readme.includes('Phase 218 adds `docs/PHASE_218_JELLYFIN_LIVE_READONLY_EVIDENCE_ACCEPTANCE.md`'), 'README ledger entry');
});

await test('acceptance record is redaction-safe', () => {
  const doc = read('docs/PHASE_218_JELLYFIN_LIVE_READONLY_EVIDENCE_ACCEPTANCE.md');
  for (const forbidden of [
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'wrappedHex',
    'dekBase64',
    '192.168.',
    'http://',
    'https://',
    'tt0133093',
    'O5_CLOSED',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
