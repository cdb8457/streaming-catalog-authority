import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidServiceInstallRunbook,
  formatUnraidServiceInstallRunbookJson,
  formatUnraidServiceInstallRunbookText,
  type UnraidServiceInstallRunbook,
} from '../src/ops/unraid-service-install-runbook.js';

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

function assertShape(packet: UnraidServiceInstallRunbook): void {
  assert(packet.report === 'phase-121-unraid-service-install-runbook', 'report');
  assert(packet.code === 'UNRAID_SERVICE_INSTALL_RUNBOOK', 'code');
  assert(packet.sourceReadinessBundle === 'phase-120-unraid-operator-readiness-bundle', 'source');
  assert(packet.redactionSafe === true && packet.inputValuesEchoed === false, 'redaction boundary');
  assert(packet.commandExecution === false && packet.scriptGenerated === false, 'no execution or script');
  assert(packet.serviceInstallApproved === false, 'no service install approval');
  assert(packet.serviceInstalled === false && packet.serviceStarted === false, 'service not installed or started');
  assert(packet.mutatesUnraid === false, 'no Unraid mutation');
  assert(packet.liveServiceContact === false && packet.providerContactAllowed === false, 'no live/provider contact');
  assert(packet.providerModeEnabled === false, 'provider mode disabled');
  assert(packet.productionReady === false && packet.launchApproved === false, 'not production ready');
  assert(packet.closesO4 === false && packet.closesO5 === false, 'does not close gates');
  assert(packet.o4Status === 'closed/authorized' && packet.o5Status === 'closed/authorized', 'O4/O5 already authorized');
  assert(packet.fileCustodianStatus === 'reference-harness-not-production-kms', 'FileCustodian boundary');
  assert(packet.runbookReviewStatus === 'draft-pending-operator-review', 'draft review status');
  assert(packet.runbookSteps.length >= 5, 'runbook steps');
  assert(packet.installBlockedUntil.length >= 4, 'install blockers');
  assert(packet.rollbackEvidenceRequired.length >= 5, 'rollback evidence');
}

function assertNoSentinels(output: string): void {
  for (const sentinel of ['SECRET_VALUE_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'Authorization: Bearer', 'Bearer SECRET', 'http://localhost', 'https://api']) {
    assert(!output.includes(sentinel), `output excludes ${sentinel}`);
  }
}

console.log('Running Phase 121 Unraid service install runbook suite:\n');

test('packet drafts install and rollback review without mutation', () => {
  const packet = buildUnraidServiceInstallRunbook();
  assertShape(packet);
  const stepIds = packet.runbookSteps.map((step) => step.id);
  for (const id of ['preinstall-review', 'layout-plan', 'service-wrapper-plan', 'rollback-plan', 'install-approval']) {
    assert(stepIds.includes(id), `runbook step ${id}`);
  }
  assert(packet.runbookSteps.some((step) => step.status === 'blocked'), 'contains blocking hold');
  assert(packet.installBlockedUntil.every((blocker) => blocker.endsWith('-redacted')), 'install blockers are redacted labels');
  assert(packet.rollbackEvidenceRequired.every((evidence) => evidence.endsWith('-redacted')), 'rollback evidence is redacted labels');
});

test('formatters and CLI emit deterministic redaction-safe output', () => {
  const packet = buildUnraidServiceInstallRunbook();
  const json = formatUnraidServiceInstallRunbookJson(packet);
  const text = formatUnraidServiceInstallRunbookText(packet);
  assertShape(JSON.parse(json) as UnraidServiceInstallRunbook);
  assert(text.includes('Phase 121 Unraid service install runbook'), 'text title');
  assert(text.includes('productionReady: false'), 'production false');
  assert(text.includes('scriptGenerated: false'), 'script false');
  assertNoSentinels(json);
  assertNoSentinels(text);

  const direct = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/unraid-service-install-runbook-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
      DATABASE_URL: 'postgres://secret',
    },
    encoding: 'utf8',
  });
  assertShape(JSON.parse(direct) as UnraidServiceInstallRunbook);
  assertNoSentinels(direct);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:unraid-service-install-runbook -- -- --json', { cwd: root, encoding: 'utf8' });
  assertShape(JSON.parse(output) as UnraidServiceInstallRunbook);
});

test('source and docs preserve runbook-only boundary', () => {
  const source = `${read('src/ops/unraid-service-install-runbook.ts')}\n${read('src/ops/unraid-service-install-runbook-cli.ts')}`;
  const docs = `${read('docs/PHASE_121_UNRAID_SERVICE_INSTALL_RUNBOOK.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  assert(scripts['ops:unraid-service-install-runbook'] === 'tsx src/ops/unraid-service-install-runbook-cli.ts', 'ops script');
  assert(scripts['test:unraid-service-install-runbook'] === 'tsx test/unraid-service-install-runbook.ts', 'test script');
  assert((scripts.test ?? '').includes('test/unraid-operator-readiness-bundle.ts && tsx test/unraid-service-install-runbook.ts'), 'aggregate order');
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  for (const required of [
    'Phase 121',
    'UNRAID_SERVICE_INSTALL_RUNBOOK',
    'phase-121-unraid-service-install-runbook',
    'phase-120-unraid-operator-readiness-bundle',
    'draft-pending-operator-review',
    'o4Status: closed/authorized',
    'o5Status: closed/authorized',
    'inputValuesEchoed: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'serviceInstallApproved: false',
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
