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

console.log('Running Phase 217 scheduled doctor alert fix suite:\n');

await test('phase record documents stale compose root cause and corrected launcher', () => {
  const doc = read('docs/PHASE_217_SCHEDULED_DOCTOR_ALERT_FIX.md');
  for (const required of [
    'phase-217-scheduled-doctor-alert-fix',
    'doctor-20260713-174701',
    'zero bytes',
    'docker-compose.deploy.yml',
    'docker-compose.unraid-bind.yml',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh doctor',
    '/boot/config/plugins/user.scripts/scripts/catalog-doctor/script',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('schedule docs now prefer the canonical Unraid launcher for doctor', () => {
  const schedule = read('docs/PHASE_20_UNRAID_OPERATIONS_SCHEDULE.md');
  for (const required of [
    'CATALOG_LAUNCHER="${CATALOG_LAUNCHER:-<canonical-unraid-ops-launcher>}"',
    'OUT="$("$CATALOG_LAUNCHER" doctor)"',
    'doctor-latest.redacted.json',
    'Expected O5 WARN checks are readiness gates to record/review, not health failures.',
  ]) assert(schedule.includes(required), `schedule includes ${required}`);
  assert(!schedule.includes('OUT="$(npm run --silent ops:doctor -- --json)"'), 'old host npm doctor snippet removed');
});

await test('canonical launcher emits doctor JSON without npm banner text', () => {
  const launcher = read('deploy/unraid-ops-launcher.sh');
  assert(launcher.includes('doctor)\n    run_ops_silent ops:doctor -- --json'), 'doctor uses silent runner');
  assert(!launcher.includes('doctor)\n    run_ops ops:doctor -- --json'), 'doctor does not use noisy npm runner');
});

await test('phase record preserves runtime and custody boundaries', () => {
  const doc = read('docs/PHASE_217_SCHEDULED_DOCTOR_ALERT_FIX.md');
  for (const required of [
    'does not change Compose',
    'does not change custody mode',
    'scheduled evidence starts with `{`',
    'Jellyfin live evidence remains blocked',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(doc.includes(required), `boundary includes ${required}`);
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

await test('package, deploy guard, and README wire Phase 217 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:scheduled-doctor-alert-fix'] === 'tsx test/scheduled-doctor-alert-fix.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/arcane-jellyfin-live-capture-button.ts && tsx test/scheduled-doctor-alert-fix.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 217 scheduled doctor alert fix'), 'deploy guard entry');
  assert(deploy.includes('phase-217-scheduled-doctor-alert-fix'), 'deploy guard report id');
  assert(readme.includes('Phase 217 adds `docs/PHASE_217_SCHEDULED_DOCTOR_ALERT_FIX.md`'), 'README ledger entry');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
