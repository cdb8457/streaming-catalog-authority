import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidInstallEvidenceManifest,
  formatUnraidInstallEvidenceManifestJson,
  formatUnraidInstallEvidenceManifestText,
  type UnraidInstallEvidenceManifest,
} from '../src/ops/unraid-install-evidence-manifest.js';

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

function assertShape(packet: UnraidInstallEvidenceManifest): void {
  assert(packet.report === 'phase-124-unraid-install-evidence-manifest', 'report');
  assert(packet.code === 'UNRAID_INSTALL_EVIDENCE_MANIFEST', 'code');
  assert(packet.sourceInstallAuthorization === 'phase-123-unraid-service-install-authorization', 'source');
  assert(packet.evidenceManifestStatus === 'ready-for-operator-capture', 'status');
  assert(packet.redactionSafe === true && packet.inputValuesEchoed === false, 'redaction boundary');
  assert(packet.commandExecution === false && packet.scriptGenerated === false, 'no command/script');
  assert(packet.serviceInstallApproved === true, 'install window approved');
  assert(packet.serviceInstalled === false && packet.serviceStarted === false, 'service not installed or started');
  assert(packet.mutatesUnraid === false, 'no Unraid mutation');
  assert(packet.liveServiceContact === false && packet.providerContactAllowed === false, 'no live/provider contact');
  assert(packet.providerModeEnabled === false, 'provider mode disabled');
  assert(packet.productionReady === false && packet.launchApproved === false, 'not production ready');
  assert(packet.closesO4 === false && packet.closesO5 === false, 'does not close gates');
  assert(packet.o4Status === 'closed/authorized' && packet.o5Status === 'closed/authorized', 'O4/O5 status');
  assert(packet.fileCustodianStatus === 'reference-harness-not-production-kms', 'FileCustodian boundary');
  assert(packet.evidenceItems.length >= 5, 'evidence items');
  assert(packet.remainingReviewGates.length >= 4, 'remaining gates');
}

function assertNoSentinels(output: string): void {
  for (const sentinel of ['SECRET_VALUE_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'Authorization: Bearer', 'Bearer SECRET', 'http://localhost', 'https://api']) {
    assert(!output.includes(sentinel), `output excludes ${sentinel}`);
  }
}

console.log('Running Phase 124 Unraid install evidence manifest suite:\n');

test('manifest defines redacted operator evidence without mutating Unraid', () => {
  const packet = buildUnraidInstallEvidenceManifest();
  assertShape(packet);
  const ids = packet.evidenceItems.map((item) => item.id);
  for (const id of ['preinstall-state-capture', 'install-window-result', 'service-install-result', 'rollback-readiness', 'post-install-validation-plan']) {
    assert(ids.includes(id), `evidence item ${id}`);
  }
  assert(packet.evidenceItems.every((item) => item.redacted === true && item.label.endsWith('-redacted')), 'evidence labels redacted');
});

test('formatters and CLI emit deterministic redaction-safe output', () => {
  const packet = buildUnraidInstallEvidenceManifest();
  const json = formatUnraidInstallEvidenceManifestJson(packet);
  const text = formatUnraidInstallEvidenceManifestText(packet);
  assertShape(JSON.parse(json) as UnraidInstallEvidenceManifest);
  assert(text.includes('Phase 124 Unraid install evidence manifest'), 'text title');
  assert(text.includes('serviceInstallApproved: true'), 'install approved');
  assert(text.includes('serviceInstalled: false'), 'service installed false');
  assertNoSentinels(json);
  assertNoSentinels(text);

  const direct = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/unraid-install-evidence-manifest-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
      DATABASE_URL: 'postgres://secret',
    },
    encoding: 'utf8',
  });
  assertShape(JSON.parse(direct) as UnraidInstallEvidenceManifest);
  assertNoSentinels(direct);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:unraid-install-evidence-manifest -- -- --json', { cwd: root, encoding: 'utf8' });
  assertShape(JSON.parse(output) as UnraidInstallEvidenceManifest);
});

test('source and docs preserve evidence-manifest-only boundary', () => {
  const source = `${read('src/ops/unraid-install-evidence-manifest.ts')}\n${read('src/ops/unraid-install-evidence-manifest-cli.ts')}`;
  const docs = `${read('docs/PHASE_124_UNRAID_INSTALL_EVIDENCE_MANIFEST.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['ops:unraid-install-evidence-manifest'] === 'tsx src/ops/unraid-install-evidence-manifest-cli.ts', 'ops script');
  assert(scripts['test:unraid-install-evidence-manifest'] === 'tsx test/unraid-install-evidence-manifest.ts', 'test script');
  assert((scripts.test ?? '').includes('test/unraid-service-install-authorization.ts && tsx test/unraid-install-evidence-manifest.ts'), 'aggregate order');
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
    'Phase 124',
    'UNRAID_INSTALL_EVIDENCE_MANIFEST',
    'phase-124-unraid-install-evidence-manifest',
    'phase-123-unraid-service-install-authorization',
    'ready-for-operator-capture',
    'serviceInstallApproved: true',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerContactAllowed: false',
    'providerModeEnabled: false',
    'productionReady: false',
    'launchApproved: false',
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
