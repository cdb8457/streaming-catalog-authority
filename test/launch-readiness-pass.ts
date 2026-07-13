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

console.log('Running Phase 200 launch readiness pass suite:\n');

test('phase record declares launch ready with accepted O5 warning', () => {
  const doc = read('docs/PHASE_200_LAUNCH_READINESS_PASS.md');
  for (const required of [
    'phase-200-launch-readiness-pass',
    'Launch readiness status: `LAUNCH_READY_WITH_ACCEPTED_WARNINGS`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'self-hosted catalog authority backend/operator foundation',
    'O4_CLOSED',
    'O5_DEFERRED_ACCEPTED',
    'This is not a streaming product launch',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

test('gate matrix cites O4, O5, Unraid sync, image, and live health evidence', () => {
  const doc = read('docs/PHASE_200_LAUNCH_READINESS_PASS.md');
  for (const required of [
    'commit `a3681d3`',
    'tag `phase-198`',
    'commit `4998c65`',
    'tag `phase-199`',
    'phase-200-unraid-sync-4998c65de',
    'phase-200-repo-ops-latest-build',
    'catalogauthority-app-1',
    'catalogauthority-sidecar-1',
    'catalogauthority-postgres-1',
    'phase-200-ui-live-check-ok-true',
    'CUSTODIAN_MODE=sidecar',
    'published ports `none`',
    'OPERATOR_UI_SERVICE_HEALTHY',
  ]) assert(doc.includes(required), `evidence includes ${required}`);
});

test('scope forbids provider, playback, download, scraping, and media-server claims', () => {
  const doc = read('docs/PHASE_200_LAUNCH_READINESS_PASS.md');
  for (const required of [
    'no streaming product claim',
    'no provider live mode',
    'no Real-Debrid, TorBox, Usenet, Plex, Jellyfin, Emby, or Stremio integration claim',
    'no scraping, downloading, playback',
    'no claim that managed KEK custody/scheduling is closed',
    'single-owner/self-hosted operation only',
  ]) assert(doc.includes(required), `scope includes ${required}`);
});

test('O5 warning remains binding with reopening criteria', () => {
  const doc = read('docs/PHASE_200_LAUNCH_READINESS_PASS.md');
  for (const required of [
    'suspected KEK compromise',
    'custody incident or custody-path failure',
    'multi-user, shared, or production-scale milestone',
    'provider live mode, download orchestration, playback orchestration, or media-server mutation',
    '90-day O5 review interval reached',
    'launch readiness returns to hold',
  ]) assert(doc.includes(required), `reopen includes ${required}`);
});

test('package, README, and deploy guard pin Phase 200 launch readiness', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const readme = read('README.md');
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:launch-readiness-pass'] === 'tsx test/launch-readiness-pass.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/o5-disposition.ts && tsx test/launch-readiness-pass.ts && tsx test/launch-package.ts && tsx test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(readme.includes('Phase 200 adds `docs/PHASE_200_LAUNCH_READINESS_PASS.md`'), 'README phase entry');
  assert(deploy.includes('Phase 200 launch readiness pass'), 'deploy guard entry');
  assert(deploy.includes('LAUNCH_READY_WITH_ACCEPTED_WARNINGS'), 'deploy guard status');
});

test('record is redaction-safe and artifact-only', () => {
  const doc = read('docs/PHASE_200_LAUNCH_READINESS_PASS.md');
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
    '/mnt/user/',
    '/boot/config/',
    'C:\\',
    '\\\\.\\pipe\\',
    'http://',
    'https://',
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
