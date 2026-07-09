import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildControlSurfaceComposeBoundaryReport,
  type ControlSurfaceComposeBoundaryReport,
} from '../src/ops/control-surface-compose-boundary.js';

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

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/control-surface-compose-boundary-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 140 control surface Compose boundary suite:\n');

test('boundary packet is ready for Compose section but starts nothing', () => {
  const report = buildControlSurfaceComposeBoundaryReport();
  assert(report.report === 'phase-140-control-surface-compose-boundary', 'report');
  assert(report.sourceRestartPersistenceReview === 'phase-139-unraid-restart-persistence-review', 'source');
  assert(report.readyForComposeSection === true, 'ready');
  assert(report.requiresHumanLoopBeforeCompose === true, 'human loop');
  assert(report.composeStarted === false, 'compose not started');
  assert(report.arcaneSelected === false, 'arcane not selected');
  assert(report.dockhandControlsInstalled === false, 'dockhand not installed');
  assert(report.productionReady === false, 'productionReady remains false');
  assert(report.summary.fail === 0 && report.summary.warn === 2, 'warnings only');
});

test('CLI emits fixed redaction-safe JSON without input or secret echoes', () => {
  const result = runCli(['--json', 'PRIVATE_TITLE_SENTINEL', 'SECRET_VALUE_SENTINEL']);
  const stdout = String(result.stdout);
  assert(result.status === 0, 'CLI exits zero');
  const parsed = JSON.parse(stdout) as ControlSurfaceComposeBoundaryReport;
  assert(parsed.nextDecision === 'choose-control-surface-compose-target', 'next decision');
  assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
  assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
});

test('source and docs preserve pre-Compose boundary', () => {
  const source = `${read('src/ops/control-surface-compose-boundary.ts')}\n${read('src/ops/control-surface-compose-boundary-cli.ts')}`;
  const docs = `${read('docs/PHASE_140_CONTROL_SURFACE_COMPOSE_BOUNDARY.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:control-surface-compose-boundary'] === 'tsx test/control-surface-compose-boundary.ts', 'test script');
  assert(scripts['ops:control-surface-compose-boundary'] === 'tsx src/ops/control-surface-compose-boundary-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/unraid-restart-persistence-review.ts && tsx test/control-surface-compose-boundary.ts'), 'aggregate order');
  for (const required of [
    'phase-140-control-surface-compose-boundary',
    'phase-139-unraid-restart-persistence-review',
    'readyForComposeSection: true',
    'requiresHumanLoopBeforeCompose: true',
    'composeStarted: false',
    'arcaneSelected: false',
    'dockhandControlsInstalled: false',
    'commandExecution: false',
    'scriptGenerated: false',
    'mutatesUnraid: false',
    'providerModeEnabled: false',
    'productionReady: false',
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
