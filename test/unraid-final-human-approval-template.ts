import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidFinalHumanApprovalTemplate,
  formatUnraidFinalHumanApprovalTemplateJson,
  type UnraidFinalHumanApprovalTemplate,
} from '../src/ops/unraid-final-human-approval-template.js';

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

function assertShape(packet: UnraidFinalHumanApprovalTemplate): void {
  assert(packet.report === 'phase-128-unraid-final-human-approval-template', 'report');
  assert(packet.sourceProductionReadinessDecision === 'phase-127-unraid-production-readiness-decision', 'source');
  assert(packet.finalHumanApprovalStatus === 'awaiting-explicit-human-approval', 'status');
  assert(packet.requiredApprovalRecord.record === 'phase-128-unraid-final-human-production-approval-record', 'record label');
  assert(packet.redactionSafe === true && packet.inputValuesEchoed === false, 'redaction boundary');
  assert(packet.commandExecution === false && packet.scriptGenerated === false, 'no command/script');
  assert(packet.serviceInstalled === false && packet.serviceStarted === false, 'service not installed/started');
  assert(packet.providerContactAllowed === false && packet.providerModeEnabled === false, 'no provider mode');
  assert(packet.productionReady === false && packet.launchApproved === false, 'not production/launch approved');
}

console.log('Running Phase 128 final human approval template suite:\n');

test('template requires explicit human approval and does not approve production', () => {
  assertShape(buildUnraidFinalHumanApprovalTemplate());
});

test('CLI emits parseable JSON', () => {
  const output = execSync('npm run --silent ops:unraid-final-human-approval-template -- -- --json', { cwd: root, encoding: 'utf8' });
  assertShape(JSON.parse(output) as UnraidFinalHumanApprovalTemplate);
});

test('source and docs preserve approval-template-only boundary', () => {
  const source = `${read('src/ops/unraid-final-human-approval-template.ts')}\n${read('src/ops/unraid-final-human-approval-template-cli.ts')}`;
  const docs = `${read('docs/PHASE_128_UNRAID_FINAL_HUMAN_APPROVAL_TEMPLATE.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-final-human-approval-template'] === 'tsx test/unraid-final-human-approval-template.ts', 'test script');
  assert(scripts['ops:unraid-final-human-approval-template'] === 'tsx src/ops/unraid-final-human-approval-template-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-production-gates.ts && tsx test/unraid-final-human-approval-template.ts'), 'aggregate order');
  for (const required of [
    'phase-128-unraid-final-human-approval-template',
    'phase-128-unraid-final-human-production-approval-record',
    'phase-127-unraid-production-readiness-decision',
    'awaiting-explicit-human-approval',
    'productionReady: false',
    'launchApproved: false',
    'serviceInstalled: false',
    'serviceStarted: false',
    'providerModeEnabled: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'globalThis.fetch', 'fetch(', "from 'pg'", 'ProviderAdapter', 'TorBoxReadOnlyClient', 'JellyfinHttpClient']) {
    assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  }
  assert(formatUnraidFinalHumanApprovalTemplateJson().includes('"productionReady": false'), 'json formatter false');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
