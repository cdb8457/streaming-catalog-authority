import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildUnraidProductionDisposition,
  parseUnraidProductionDispositionJson,
  type UnraidProductionDisposition,
} from '../src/ops/unraid-production-disposition.js';

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

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record: 'phase-133-unraid-production-disposition-record',
    sourceEvidenceReview: 'phase-132-unraid-switch-evidence-review',
    sourceEvidenceReviewStatus: 'ready-for-final-production-disposition',
    serviceEvidenceStatus: 'service-evidence-present',
    verdict: 'GO',
    redactionSafe: true,
    dispositionValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/unraid-production-disposition-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 133 Unraid production disposition suite:\n');

test('GO disposition is ready for launch-readiness decision but approves nothing', () => {
  const report = buildUnraidProductionDisposition(record());
  assert(report.report === 'phase-133-unraid-production-disposition', 'report');
  assert(report.verdict === 'GO', 'GO');
  assert(report.dispositionStatus === 'ready-for-launch-readiness-decision', 'ready');
  assert(report.productionReady === false && report.launchApproved === false, 'no approval flip');
  assert(report.commandExecution === false && report.mutatesUnraid === false, 'no execution');
});

test('HOLD or unsafe disposition blocks launch-readiness decision', () => {
  const hold = buildUnraidProductionDisposition(record({ verdict: 'HOLD' }));
  assert(hold.dispositionStatus === 'not-ready-for-launch-readiness-decision', 'HOLD blocks');
  const bad = buildUnraidProductionDisposition(record({ sourceEvidenceReviewStatus: 'not-ready-for-final-production-disposition' }));
  assert(bad.summary.fail > 0, 'bad evidence review fails');
  assert(bad.dispositionStatus === 'not-ready-for-launch-readiness-decision', 'bad blocks');
});

test('parser and CLI read one explicit disposition file without value leaks', () => {
  assert(parseUnraidProductionDispositionJson('{bad') === 'PRODUCTION_DISPOSITION_JSON_MALFORMED', 'malformed');
  assert(parseUnraidProductionDispositionJson('[]') === 'PRODUCTION_DISPOSITION_OBJECT_REQUIRED', 'array');
  const dir = mkdtempSync(join(tmpdir(), 'production-disposition-'));
  try {
    const input = join(dir, 'disposition.json');
    writeFileSync(input, JSON.stringify(record({ notes: 'PRIVATE_TITLE_SENTINEL SECRET_VALUE_SENTINEL KEK_SENTINEL' })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as UnraidProductionDisposition;
    assert(parsed.dispositionStatus === 'ready-for-launch-readiness-decision', 'stdout ready');
    assert(!stdout.includes(input), 'stdout omits path');
    assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
    assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
    assert(!stdout.includes('KEK_SENTINEL'), 'stdout omits hostile KEK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve disposition-only boundary', () => {
  const source = `${read('src/ops/unraid-production-disposition.ts')}\n${read('src/ops/unraid-production-disposition-cli.ts')}`;
  const docs = `${read('docs/PHASE_133_UNRAID_PRODUCTION_DISPOSITION.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:unraid-production-disposition'] === 'tsx test/unraid-production-disposition.ts', 'test script');
  assert(scripts['ops:unraid-production-disposition'] === 'tsx src/ops/unraid-production-disposition-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-switch-evidence-review.ts && tsx test/unraid-production-disposition.ts'), 'aggregate order');
  for (const required of [
    'phase-133-unraid-production-disposition',
    'phase-133-unraid-production-disposition-record',
    'phase-132-unraid-switch-evidence-review',
    'ready-for-final-production-disposition',
    'service-evidence-present',
    'ready-for-launch-readiness-decision',
    'productionReady: false',
    'launchApproved: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'providerModeEnabled: false',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'globalThis.fetch', 'fetch(', "from 'pg'", 'docker compose', 'execSync', 'ProviderAdapter', 'TorBoxReadOnlyClient', 'JellyfinHttpClient']) {
    assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
