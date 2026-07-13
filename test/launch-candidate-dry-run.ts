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

console.log('Running Phase 202 launch candidate consumer dry-run suite:\n');

test('phase record defines the consumer dry run and accepted warning', () => {
  const doc = read('docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md');
  for (const required of [
    'phase-202-launch-candidate-consumer-dry-run',
    'LAUNCH_CANDIDATE_CONSUMER_DRY_RUN_READY_WITH_ACCEPTED_WARNINGS',
    'Phase 201, commit `9378a07`, tag `phase-201`',
    'Phase 200, commit `0d08052`, tag `phase-200`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'fresh operator',
    'hidden local history',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

test('documented consumer procedure uses one canonical Unraid path', () => {
  const doc = read('docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md');
  const release = read('RELEASE.md');
  for (const required of [
    '/mnt/user/appdata/catalog/repo',
    '/mnt/user/appdata/catalog',
    '/mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh',
    'git clone https://github.com/cdb8457/streaming-catalog-authority.git .',
    'git fetch origin --tags --force',
    'git checkout master',
    'git reset --hard origin/master',
    'docker build -t repo-ops:latest .',
    'docker compose -f docker-compose.unraid.runtime.yml up -d postgres app sidecar',
  ]) {
    assert(doc.includes(required), `phase doc includes ${required}`);
    assert(release.includes(required), `release includes ${required}`);
  }
  assert(!release.includes('docker-compose.unraid.override'), 'release avoids alternate Unraid compose override');
});

test('required secrets and operator commands are discoverable', () => {
  const doc = read('docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md');
  const release = read('RELEASE.md');
  const packageDoc = read('docs/PHASE_201_LAUNCH_PACKAGE.md');
  for (const required of [
    '/mnt/user/appdata/catalog/secrets/postgres_password',
    '/mnt/user/appdata/catalog/secrets/admin_database_url',
    '/mnt/user/appdata/catalog/secrets/database_url',
    '/mnt/user/appdata/catalog/secrets/completion_secret',
    '/mnt/user/appdata/catalog/secrets/custodian_kek',
    '/mnt/user/appdata/catalog/secrets/operator_ui_token',
  ]) assert(release.includes(required), `release lists secret ${required}`);
  for (const required of [
    'unraid-ops-launcher.sh status',
    'unraid-ops-launcher.sh start-ui',
    'unraid-ops-launcher.sh restart-ui',
    'unraid-ops-launcher.sh ui-live-check',
    'unraid-ops-launcher.sh ui-live-check-save',
    'unraid-ops-launcher.sh ui-evidence-review',
    'unraid-ops-launcher.sh ui-logs',
    'unraid-ops-launcher.sh ui-token-status',
  ]) {
    assert(doc.includes(required), `phase doc lists ${required}`);
    assert(packageDoc.includes(required), `phase 201 package lists ${required}`);
  }
});

test('healthy state and stop lines are explicit', () => {
  const doc = read('docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md');
  for (const required of [
    'app, sidecar, and Postgres are running and healthy',
    'app custody mode is `sidecar`',
    'sidecar publishes no ports',
    '`ui-live-check` returns `ok:true`',
    'fresh clone cannot find the documented Compose file or launcher',
    'documented procedure requires a second Compose file',
    'O5 is claimed closed',
  ]) assert(doc.includes(required), `healthy/stop line includes ${required}`);
});

test('package and deploy guard pin Phase 202 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:launch-candidate-dry-run'] === 'tsx test/launch-candidate-dry-run.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/launch-package.ts && tsx test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 202 launch candidate consumer dry run'), 'deploy guard entry');
  assert(deploy.includes('LAUNCH_CANDIDATE_CONSUMER_DRY_RUN_READY_WITH_ACCEPTED_WARNINGS'), 'deploy guard status');
});

test('record is redaction-safe and artifact-only', () => {
  const doc = read('docs/PHASE_202_LAUNCH_CANDIDATE_DRY_RUN.md');
  for (const required of [
    'artifact, documentation, and test work only',
    'makes no runtime, Docker Compose,',
    'no provider or media runtime behavior enabled',
  ]) assert(doc.includes(required), `boundary includes ${required}`);
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
    '192.168.',
    'localhost:',
    'O5_CLOSED',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
