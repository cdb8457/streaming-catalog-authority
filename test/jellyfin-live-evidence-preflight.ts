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

console.log('Running Phase 208 existing Jellyfin live evidence preflight suite:\n');

await test('phase record discovers existing Jellyfin without install or new port binding', () => {
  const doc = read('docs/PHASE_208_EXISTING_JELLYFIN_LIVE_EVIDENCE_PREFLIGHT.md');
  for (const required of [
    'phase-208-existing-jellyfin-live-evidence-preflight',
    'EXISTING_JELLYFIN_DISCOVERED_LIVE_EVIDENCE_PREFLIGHT_READY',
    'LIVE_EVIDENCE_PREFLIGHT_READY_NO_INSTALL',
    'ddc8d0a',
    'phase-207',
    'existing Jellyfin listener found on port `8096`',
    'Jellyfin HTTPS port `8920` not open',
    'Catalog Authority operator UI remains on port `8099`',
    'Plex remains on port `32400`',
    'http://<unraid-host>:8096',
    'never start a second Jellyfin instance',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('preflight requires port scan before live evidence', () => {
  const doc = read('docs/PHASE_208_EXISTING_JELLYFIN_LIVE_EVIDENCE_PREFLIGHT.md');
  for (const required of [
    'ss -ltnp',
    "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Ports}}'",
    'if `8096` is already owned by Jellyfin, use that existing service',
    'if `8096` is owned by something else, stop and investigate',
    'if `8920` is closed, do not switch the evidence command to HTTPS',
    'if Catalog Authority is using `8099`, do not reuse that port',
    'if Plex is using `32400`, do not reuse that port',
  ]) assert(doc.includes(required), `port rule includes ${required}`);
});

await test('secret-file and redaction boundaries are explicit', () => {
  const doc = read('docs/PHASE_208_EXISTING_JELLYFIN_LIVE_EVIDENCE_PREFLIGHT.md');
  for (const required of [
    'JELLYFIN_API_KEY_FILE=<operator-secret-file>',
    'must not appear in shell history',
    'committed files',
    'retained evidence',
    'logs',
    'screenshots',
    'Arcane button definitions',
    "must not contain the operator's private host address",
  ]) assert(doc.includes(required), `secret boundary includes ${required}`);
});

await test('decision preserves deferred integration and O4/O5 state', () => {
  const doc = read('docs/PHASE_208_EXISTING_JELLYFIN_LIVE_EVIDENCE_PREFLIGHT.md');
  for (const required of [
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'Integration remains deferred until retained live evidence is captured and reviewed',
  ]) assert(doc.includes(required), `status includes ${required}`);
});

await test('package, deploy guard, and README wire Phase 208 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:jellyfin-live-evidence-preflight'] === 'tsx test/jellyfin-live-evidence-preflight.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 208 existing Jellyfin live evidence preflight'), 'deploy guard entry');
  assert(deploy.includes('LIVE_EVIDENCE_PREFLIGHT_READY_NO_INSTALL'), 'deploy guard status');
  assert(readme.includes('Phase 208 adds `docs/PHASE_208_EXISTING_JELLYFIN_LIVE_EVIDENCE_PREFLIGHT.md`'), 'README ledger entry');
});

await test('record is redaction-safe and avoids private host coordinates', () => {
  const doc = read('docs/PHASE_208_EXISTING_JELLYFIN_LIVE_EVIDENCE_PREFLIGHT.md');
  for (const forbidden of [
    '192.168.',
    '10.0.',
    '172.16.',
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
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
