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

console.log('Running Phase 223 versioned release cut suite:\n');

test('phase record cuts v1.0.0 with honest warnings and evidence anchors', () => {
  const doc = read('docs/PHASE_223_RELEASE_CUT.md');
  for (const required of [
    'phase-223-versioned-release-cut',
    'Selected version: `v1.0.0`',
    'Source release commit: `4d1f81830`',
    'RELEASE_FRESH_CLONE_SMOKE_PASS',
    'VERSIONED_RELEASE_CUT_READY_WITH_ACCEPTED_WARNINGS',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
    'JELLYFIN_COLLECTION_WRITE_MEMBERSHIP_NOT_MATERIALIZING',
    'phase-198',
    'phase-199',
    'phase-200',
    'phase-220',
    'phase-222',
    '7b8cb31e703f20b87a7f262cc376f956c26ed14827ec3c2349db22d183ea3055',
    'ac423af0f96afcb2fff905c228cdc3dd43e29ee866340b3b96c89f9a8e3e9b71',
  ]) assert(doc.includes(required), `phase record includes ${required}`);
});

test('release notes and package version align with v1.0.0 scope', () => {
  const release = read('RELEASE.md');
  const pkg = JSON.parse(read('package.json')) as { version: string; scripts: Record<string, string> };
  assert(pkg.version === '1.0.0', 'package version is 1.0.0');
  assert(pkg.scripts['test:versioned-release-cut'] === 'tsx test/versioned-release-cut.ts', 'phase test script present');
  for (const required of [
    '## v1.0.0 - Current Scope Release',
    'source release tag: `v1.0.0`',
    'repo-ops:v1.0.0',
    'O4_CLOSED',
    'O5_DEFERRED_ACCEPTED',
    'Jellyfin read-only integration proven',
    'no Jellyfin write-capable integration claim',
    'ghcr.io/catalog-authority/catalog-authority-ops:v1.0.0',
  ]) assert(release.includes(required), `release notes include ${required}`);
});

test('post-release Unraid evidence records exact image and healthy sidecar posture', () => {
  const doc = read('docs/PHASE_223_RELEASE_CUT.md');
  for (const required of [
    'sha256:a8342b416a005734faf7dd16f312ec6a7254c979b8a6143c9477d4b20ee8d3f5',
    '`catalogauthority-app-1`: healthy',
    '`catalogauthority-sidecar-1`: healthy',
    '`catalogauthority-postgres-1`: healthy',
    'CUSTODIAN_MODE=sidecar',
    'sidecar published ports: `{}`',
    'live check status: `ok:true`',
    'JELLYFIN_COMPOSE_WRITE_GUARD_OK',
  ]) assert(doc.includes(required), `runtime evidence includes ${required}`);
});

test('alignment sweep preserves shipped guard posture', () => {
  const doc = read('docs/PHASE_223_RELEASE_CUT.md');
  const readme = read('README.md');
  const releaseChecklist = read('docs/RELEASE_CHECKLIST.md');
  const compose = read('docker-compose.unraid.runtime.yml');
  assert(doc.includes('PHASE_223_RELEASE_ALIGNMENT_PASS'), 'alignment pass recorded');
  assert(readme.includes('Phase 223 adds `docs/PHASE_223_RELEASE_CUT.md`'), 'README ledger updated');
  assert(releaseChecklist.includes('JELLYFIN_WRITE_CAPABLE_NOT_LAUNCH_READY'), 'release checklist keeps Jellyfin write warning');
  assert(!compose.includes('JELLYFIN_ALLOW_LIVE_PUBLISH=true'), 'runtime compose does not enable Jellyfin live publish');
  assert(compose.includes('${CATALOG_AUTHORITY_OPS_IMAGE:-repo-ops:latest}'), 'runtime compose keeps image override convention');
});

test('phase record is redaction-safe and keeps non-claims explicit', () => {
  const doc = read('docs/PHASE_223_RELEASE_CUT.md');
  for (const required of [
    'no feature work',
    'no runtime behavior change',
    'no Docker Compose behavior change',
    'no media-server state change',
    'no provider live mode',
    'no scraping, downloading, playback',
    'no Jellyfin write-capable integration claim',
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
    'O5_CLOSED',
    'JELLYFIN_WRITE_CAPABLE_LAUNCH_ELIGIBLE',
  ]) assert(!doc.includes(forbidden), `phase record excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
