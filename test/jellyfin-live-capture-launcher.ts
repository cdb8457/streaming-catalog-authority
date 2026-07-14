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

console.log('Running Phase 215 Jellyfin live capture launcher suite:\n');

await test('phase record documents guarded launcher status and dependencies', () => {
  const doc = read('docs/PHASE_215_JELLYFIN_LIVE_CAPTURE_LAUNCHER.md');
  for (const required of [
    'phase-215-jellyfin-live-capture-launcher',
    'JELLYFIN_LIVE_CAPTURE_LAUNCHER_READY',
    'LAUNCHER_READY_SECRET_STILL_REQUIRED',
    'deploy/unraid-jellyfin-live-capture.sh',
    'Phase 214 secret install operator packet',
    '/mnt/user/appdata/catalog/secrets/jellyfin_api_key',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('launcher refuses missing secrets before live capture', () => {
  const script = read('deploy/unraid-jellyfin-live-capture.sh');
  for (const required of [
    '#!/usr/bin/env sh',
    'set -eu',
    '[ ! -f "$SECRET_FILE" ]',
    '[ ! -s "$SECRET_FILE" ]',
    'Install it with the Phase 214 no-echo operator packet',
    'exit 2',
  ]) assert(script.includes(required), `script includes ${required}`);
});

await test('launcher runs readiness before read-only capture with safe mounts', () => {
  const script = read('deploy/unraid-jellyfin-live-capture.sh');
  const readiness = script.indexOf('ops:jellyfin-secret-readiness');
  const capture = script.indexOf('ops:jellyfin-live-evidence-capture');
  assert(readiness > -1, 'readiness command present');
  assert(capture > readiness, 'capture follows readiness');
  for (const required of [
    'repo-ops:latest',
    '$SECRET_FILE:$SECRET_MOUNT:ro',
    'JELLYFIN_API_KEY_FILE=$SECRET_MOUNT',
    'JELLYFIN_ENABLE_NETWORK=true',
    'http://host.docker.internal:8096',
    '--add-host=host.docker.internal:host-gateway',
    '--out "/evidence/$(basename "$tmp_out")"',
    'phase-211-jellyfin-live-readonly-smoke.json',
  ]) assert(script.includes(required), `script includes ${required}`);
});

await test('package, deploy guard, and README wire Phase 215 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:jellyfin-live-capture-launcher'] === 'tsx test/jellyfin-live-capture-launcher.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/scheduled-doctor-alert-fix.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 215 Jellyfin live capture launcher'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_LIVE_CAPTURE_LAUNCHER_READY'), 'deploy guard status');
  assert(readme.includes('Phase 215 adds `deploy/unraid-jellyfin-live-capture.sh`'), 'README ledger entry');
});

await test('phase record is redaction-safe and preserves deferred launch state', () => {
  const doc = read('docs/PHASE_215_JELLYFIN_LIVE_CAPTURE_LAUNCHER.md');
  for (const required of [
    'does not create the Jellyfin API key',
    'does not contact Jellyfin during tests',
    'does not install Jellyfin',
    'does not publish ports',
    'does not change Compose',
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'Phase 214 remains `JELLYFIN_SECRET_INSTALL_PACKET_READY`',
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
