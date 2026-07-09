import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidSwitchEvidenceCapturePacket,
  formatUnraidSwitchEvidenceCaptureJson,
  type UnraidSwitchEvidenceCapturePacket,
} from '../src/ops/unraid-switch-evidence-capture.js';

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

function assertShape(packet: UnraidSwitchEvidenceCapturePacket): void {
  assert(packet.report === 'phase-131-unraid-switch-evidence-capture', 'report');
  assert(packet.sourceRunbook === 'phase-130-unraid-production-switch-runbook', 'source runbook');
  assert(packet.requiredApprovalPreflight === 'phase-129-unraid-final-human-approval-record-preflight', 'approval preflight');
  assert(packet.requiredLiveEvidence === 'unraid-live-operating-test-2026-07-08.redacted.md', 'live evidence');
  assert(packet.composeFile === 'docker-compose.unraid.yml', 'compose file');
  assert(packet.captureReadiness === 'ready-for-operator-capture-after-switch', 'capture readiness');
  assert(packet.redactionSafe === true && packet.inputValuesEchoed === false, 'redaction boundary');
  assert(packet.commandExecution === false && packet.scriptGenerated === false && packet.mutatesUnraid === false, 'no execution');
  assert(packet.serviceInstalled === false && packet.serviceStarted === false, 'no service state change');
  assert(packet.providerContactAllowed === false && packet.providerModeEnabled === false, 'no provider mode');
  assert(packet.productionReady === false && packet.launchApproved === false, 'no production/launch approval');
  assert(packet.requiredEvidenceLabels.includes('post-switch-doctor-redacted-json'), 'post doctor label');
  assert(packet.forbiddenEvidence.some((item) => item.includes('No KEK or DEK material')), 'forbids key material');
}

console.log('Running Phase 131 Unraid switch evidence capture suite:\n');

test('packet defines post-switch evidence capture without mutating Unraid', () => {
  assertShape(buildUnraidSwitchEvidenceCapturePacket());
});

test('CLI emits parseable JSON', () => {
  const output = execSync('npm run --silent ops:unraid-switch-evidence-capture -- -- --json', { cwd: root, encoding: 'utf8' });
  assertShape(JSON.parse(output) as UnraidSwitchEvidenceCapturePacket);
});

test('source and docs preserve capture-only boundary', () => {
  const source = `${read('src/ops/unraid-switch-evidence-capture.ts')}\n${read('src/ops/unraid-switch-evidence-capture-cli.ts')}`;
  const docs = `${read('docs/PHASE_131_UNRAID_SWITCH_EVIDENCE_CAPTURE.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-switch-evidence-capture'] === 'tsx test/unraid-switch-evidence-capture.ts', 'test script');
  assert(scripts['ops:unraid-switch-evidence-capture'] === 'tsx src/ops/unraid-switch-evidence-capture-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-production-switch-runbook.ts && tsx test/unraid-switch-evidence-capture.ts'), 'aggregate order');
  assert(formatUnraidSwitchEvidenceCaptureJson().includes('"productionReady": false'), 'json formatter false');
  for (const required of [
    'phase-131-unraid-switch-evidence-capture',
    'phase-130-unraid-production-switch-runbook',
    'phase-129-unraid-final-human-approval-record-preflight',
    'ready-for-explicit-operator-window',
    'ready-for-operator-capture-after-switch',
    'unraid-live-operating-test-2026-07-08.redacted.md',
    'docker-compose.unraid.yml',
    'post-switch-doctor-redacted-json',
    'productionReady: false',
    'launchApproved: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerModeEnabled: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
  for (const forbidden of ['node:fs', 'node:http', 'node:https', 'node:net', 'globalThis.fetch', 'fetch(', "from 'pg'", 'docker compose', 'execSync', 'spawnSync', 'ProviderAdapter', 'TorBoxReadOnlyClient', 'JellyfinHttpClient']) {
    assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
