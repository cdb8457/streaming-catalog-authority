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

console.log('Running Phase 210 Jellyfin live evidence capture preflight suite:\n');

await test('phase record captures blocked secret-file preflight without running live smoke', () => {
  const doc = read('docs/PHASE_210_JELLYFIN_LIVE_EVIDENCE_CAPTURE_PREFLIGHT.md');
  for (const required of [
    'phase-210-jellyfin-live-evidence-capture-preflight',
    'JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING',
    'LIVE_EVIDENCE_CAPTURE_READY_AFTER_SECRET_SETUP',
    '981ba0f',
    'phase-209',
    'Jellyfin listener present on port `8096`',
    'Catalog Authority operator UI remains on port `8099`',
    'Plex remains on port `32400`',
    'Jellyfin API key secret file missing',
    '/mnt/user/appdata/catalog/secrets/jellyfin_api_key',
    'no live smoke was run in this phase',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('operator setup uses secret file and validates without printing key', () => {
  const doc = read('docs/PHASE_210_JELLYFIN_LIVE_EVIDENCE_CAPTURE_PREFLIGHT.md');
  for (const required of [
    "umask 077",
    "printf '%s\\n' '<paste-jellyfin-api-key-here>' > /mnt/user/appdata/catalog/secrets/jellyfin_api_key",
    'chmod 600 /mnt/user/appdata/catalog/secrets/jellyfin_api_key',
    'test -s /mnt/user/appdata/catalog/secrets/jellyfin_api_key',
    "stat -c '%a %U:%G' /mnt/user/appdata/catalog/secrets/jellyfin_api_key",
    'Expected mode is `600` or stricter',
  ]) assert(doc.includes(required), `secret setup includes ${required}`);
});

await test('capture command uses existing Jellyfin and Phase 209 read-only runner', () => {
  const doc = read('docs/PHASE_210_JELLYFIN_LIVE_EVIDENCE_CAPTURE_PREFLIGHT.md');
  for (const required of [
    'cd /mnt/user/appdata/catalog/repo',
    'JELLYFIN_ENABLE_NETWORK=true',
    'JELLYFIN_BASE_URL=http://<unraid-host>:8096',
    'JELLYFIN_API_KEY_FILE=/mnt/user/appdata/catalog/secrets/jellyfin_api_key',
    'npm run ops:jellyfin-live-readonly-smoke -- --ref-type <type> --ref-value <value>',
    '/mnt/user/appdata/catalog/evidence/phase-210-jellyfin-live-readonly-smoke.json',
    'report` equals `phase-209-jellyfin-live-readonly-smoke',
    'writeMode: false',
    'allowed method `GET`',
    'evidenceDigest',
  ]) assert(doc.includes(required), `capture rule includes ${required}`);
});

await test('package, deploy guard, and README wire Phase 210 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:jellyfin-live-evidence-capture-preflight'] === 'tsx test/jellyfin-live-evidence-capture-preflight.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 210 Jellyfin live evidence capture preflight'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING'), 'deploy guard status');
  assert(readme.includes('Phase 210 adds `docs/PHASE_210_JELLYFIN_LIVE_EVIDENCE_CAPTURE_PREFLIGHT.md`'), 'README ledger entry');
});

await test('phase record is redaction-safe and preserves deferred launch state', () => {
  const doc = read('docs/PHASE_210_JELLYFIN_LIVE_EVIDENCE_CAPTURE_PREFLIGHT.md');
  for (const required of [
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'Phase 209 remains `LIVE_READONLY_SMOKE_RUNNER_READY_NO_EVIDENCE_CAPTURED`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
  ]) assert(doc.includes(required), `status includes ${required}`);
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

