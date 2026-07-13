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

console.log('Running Phase 201 launch package suite:\n');

test('phase record packages the Phase 200 launch-ready state', () => {
  const doc = read('docs/PHASE_201_LAUNCH_PACKAGE.md');
  for (const required of [
    'phase-201-launch-package',
    'LAUNCH_PACKAGE_READY_WITH_ACCEPTED_WARNINGS',
    'Phase 200, commit `0d08052`, tag `phase-200`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'self-hosted Catalog Authority backend/operator',
    'not a streaming product package',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

test('gate state, coordinates, buttons, and healthy state are complete', () => {
  const doc = read('docs/PHASE_201_LAUNCH_PACKAGE.md');
  for (const required of [
    'O4_CLOSED',
    'O5_DEFERRED_ACCEPTED',
    'https://github.com/cdb8457/streaming-catalog-authority.git',
    '/mnt/user/appdata/catalog/repo',
    '/mnt/user/appdata/catalog/repo/docker-compose.unraid.runtime.yml',
    '/mnt/user/appdata/catalog/repo/deploy/unraid-ops-launcher.sh',
    'ui-live-check',
    'ui-live-check-save',
    'ui-evidence-review',
    'ui-token-status',
    'catalogauthority-app-1',
    'catalogauthority-sidecar-1',
    'catalogauthority-postgres-1',
    'app custody mode: `sidecar`',
    'sidecar published ports: `none`',
    'operator UI live check: `ok:true`',
  ]) assert(doc.includes(required), `operator package includes ${required}`);
});

test('allowed and forbidden claims are explicit', () => {
  const doc = read('docs/PHASE_201_LAUNCH_PACKAGE.md');
  for (const required of [
    'Catalog Authority is ready as a self-hosted backend/operator foundation',
    'no streaming product claim',
    'no provider live mode claim',
    'no Real-Debrid, TorBox, Usenet, Plex, Jellyfin, Emby, or Stremio integration claim',
    'no scraping, downloading, playback',
    'no claim that O5 is closed',
    'no managed KEK custody/scheduling claim',
  ]) assert(doc.includes(required), `claim boundary includes ${required}`);
});

test('release package and checklist propagate launch warning', () => {
  const release = read('RELEASE.md');
  const checklist = read('docs/RELEASE_CHECKLIST.md');
  const readme = read('README.md');
  for (const required of [
    'Current launch package: `phase-200` / `0d08052`',
    'Launch status: `LAUNCH_READY_WITH_ACCEPTED_WARNINGS`',
    'O4: `O4_CLOSED`',
    'O5: `O5_DEFERRED_ACCEPTED`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'docs/PHASE_201_LAUNCH_PACKAGE.md',
  ]) assert(release.includes(required), `release includes ${required}`);
  assert(checklist.includes('LAUNCH_WARNING_O5_DEFERRED_ACCEPTED'), 'checklist includes warning');
  assert(readme.includes('Phase 201 adds `docs/PHASE_201_LAUNCH_PACKAGE.md`'), 'README phase entry');
});

test('package and deploy guard pin Phase 201 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:launch-package'] === 'tsx test/launch-package.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/launch-readiness-pass.ts && tsx test/launch-package.ts && tsx test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 201 launch package'), 'deploy guard entry');
  assert(deploy.includes('LAUNCH_PACKAGE_READY_WITH_ACCEPTED_WARNINGS'), 'deploy guard status');
});

test('record is redaction-safe and artifact-only', () => {
  const doc = read('docs/PHASE_201_LAUNCH_PACKAGE.md');
  for (const required of [
    'artifact and test work only',
    'makes no runtime, Docker Compose, custody-mode',
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
