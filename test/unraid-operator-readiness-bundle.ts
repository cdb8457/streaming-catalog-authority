import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidOperatorReadinessBundle,
  formatUnraidOperatorReadinessBundleJson,
  formatUnraidOperatorReadinessBundleText,
  type UnraidOperatorReadinessBundle,
} from '../src/ops/unraid-operator-readiness-bundle.js';

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

function assertShape(packet: UnraidOperatorReadinessBundle): void {
  assert(packet.report === 'phase-120-unraid-operator-readiness-bundle', 'report');
  assert(packet.code === 'UNRAID_OPERATOR_READINESS_BUNDLE', 'code');
  assert(packet.sourceO4Authorization === 'phase-116-sidecar-unraid-o4-final-authorization', 'O4 source');
  assert(packet.sourceO5Authorization === 'phase-119-o5-kek-final-authorization', 'O5 source');
  assert(packet.redactionSafe === true && packet.inputValuesEchoed === false, 'redaction boundary');
  assert(packet.commandExecution === false, 'no command execution');
  assert(packet.serviceInstallApproved === false, 'no service install approval');
  assert(packet.serviceInstalled === false && packet.serviceStarted === false, 'service not installed or started');
  assert(packet.liveServiceContact === false && packet.providerContactAllowed === false, 'no live/provider contact');
  assert(packet.providerModeEnabled === false, 'provider mode disabled');
  assert(packet.productionReady === false && packet.launchApproved === false, 'not production ready');
  assert(packet.closesO4 === false && packet.closesO5 === false, 'does not close gates');
  assert(packet.o4Status === 'closed/authorized' && packet.o5Status === 'closed/authorized', 'O4/O5 already authorized');
  assert(packet.fileCustodianStatus === 'reference-harness-not-production-kms', 'FileCustodian boundary');
  assert(packet.bundleItems.length >= 4, 'bundle item list');
  assert(packet.remainingProductionGates.length >= 4, 'remaining gates');
}

function assertNoSentinels(output: string): void {
  for (const sentinel of ['SECRET_VALUE_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'Authorization: Bearer', 'Bearer SECRET', 'http://localhost', 'https://api']) {
    assert(!output.includes(sentinel), `output excludes ${sentinel}`);
  }
}

console.log('Running Phase 120 Unraid operator readiness bundle suite:\n');

test('packet summarizes O4/O5 authorization without production approval', () => {
  const packet = buildUnraidOperatorReadinessBundle();
  assertShape(packet);
  const itemIds = packet.bundleItems.map((item) => item.id);
  for (const id of ['o4-final-authorization', 'o5-final-authorization', 'unraid-readonly-inspection-notes', 'service-install-runbook']) {
    assert(itemIds.includes(id), `bundle item ${id}`);
  }
  assert(packet.bundleItems.every((item) => item.redacted === true), 'all bundle items are redacted labels');
  assert(packet.remainingProductionGates.every((gate) => gate.endsWith('-redacted')), 'remaining gates are redacted labels');
});

test('formatters and CLI emit deterministic redaction-safe output', () => {
  const packet = buildUnraidOperatorReadinessBundle();
  const json = formatUnraidOperatorReadinessBundleJson(packet);
  const text = formatUnraidOperatorReadinessBundleText(packet);
  assertShape(JSON.parse(json) as UnraidOperatorReadinessBundle);
  assert(text.includes('Phase 120 Unraid operator readiness bundle'), 'text title');
  assert(text.includes('productionReady: false'), 'production false');
  assert(text.includes('serviceInstallApproved: false'), 'service approval false');
  assertNoSentinels(json);
  assertNoSentinels(text);

  const direct = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/unraid-operator-readiness-bundle-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
      DATABASE_URL: 'postgres://secret',
    },
    encoding: 'utf8',
  });
  assertShape(JSON.parse(direct) as UnraidOperatorReadinessBundle);
  assertNoSentinels(direct);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:unraid-operator-readiness-bundle -- -- --json', { cwd: root, encoding: 'utf8' });
  assertShape(JSON.parse(output) as UnraidOperatorReadinessBundle);
});

test('source and docs preserve offline planning boundary', () => {
  const source = `${read('src/ops/unraid-operator-readiness-bundle.ts')}\n${read('src/ops/unraid-operator-readiness-bundle-cli.ts')}`;
  const docs = `${read('docs/PHASE_120_UNRAID_OPERATOR_READINESS_BUNDLE.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  assert(scripts['ops:unraid-operator-readiness-bundle'] === 'tsx src/ops/unraid-operator-readiness-bundle-cli.ts', 'ops script');
  assert(scripts['test:unraid-operator-readiness-bundle'] === 'tsx test/unraid-operator-readiness-bundle.ts', 'test script');
  assert((scripts.test ?? '').includes('test/o5-kek-final-authorization.ts && tsx test/o5-disposition.ts && tsx test/launch-readiness-pass.ts && tsx test/launch-package.ts && tsx test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order');
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  for (const required of [
    'Phase 120',
    'UNRAID_OPERATOR_READINESS_BUNDLE',
    'phase-120-unraid-operator-readiness-bundle',
    'phase-116-sidecar-unraid-o4-final-authorization',
    'phase-119-o5-kek-final-authorization',
    'o4Status: closed/authorized',
    'o5Status: closed/authorized',
    'productionReady: false',
    'serviceInstallApproved: false',
    'providerModeEnabled: false',
    'commandExecution: false',
    'closesO4: false',
    'closesO5: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
