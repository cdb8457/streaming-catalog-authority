import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildLongRunningServiceBoundaryReport,
  type LongRunningServiceBoundaryReport,
} from '../src/ops/long-running-service-boundary.js';

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
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/long-running-service-boundary-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 146 long-running service boundary suite:\n');

test('boundary selects API plus minimal operator UI without implementation', () => {
  const report = buildLongRunningServiceBoundaryReport();
  assert(report.report === 'phase-146-long-running-service-boundary', 'report');
  assert(report.selectedServiceShape === 'api-plus-minimal-operator-ui', 'service shape');
  assert(report.productFraming === 'backend-orchestration-rail-not-streaming-product', 'product framing');
  assert(report.plannedOperatorPort === 8099, 'planned port');
  assert(report.authBoundary === 'local-admin-token-file', 'auth boundary');
  assert(report.initialDataMode === 'read-only-first', 'read-only first');
  assert(report.logsFirstClass === true, 'logs first class');
  assert(report.allowedLogClasses.includes('system') && report.allowedLogClasses.includes('operation') && report.allowedLogClasses.includes('connector'), 'log classes');
  assert(report.implementationStarted === false, 'implementation not started');
  assert(report.composeChanged === false, 'compose unchanged');
  assert(report.serviceAdded === false, 'service not added');
  assert(report.portPublishedNow === false, 'port not published now');
  assert(report.nextPhase === 'phase-147-implement-first-always-on-service', 'next phase');
});

test('boundary forbids provider and player behavior while allowing future connector classes', () => {
  const report = buildLongRunningServiceBoundaryReport();
  for (const allowed of [
    'availability-provider-connectors',
    'usenet-connectors',
    'library-consumer-connectors',
    'metadata-consumer-connectors',
  ]) assert(report.allowedFutureConnectorClasses.includes(allowed as never), `future connector ${allowed}`);
  for (const forbidden of [
    'streaming-product',
    'player',
    'media-server-replacement',
    'downloader-ui',
    'provider-search-ui',
  ]) assert(report.forbiddenProductClaims.includes(forbidden as never), `forbidden claim ${forbidden}`);
  for (const forbidden of [
    'provider-contact',
    'scraping',
    'downloading',
    'playback',
    'debrid-provider-live-mode',
    'usenet-provider-live-mode',
    'library-consumer-mutation',
    'media-server-mutation',
    'external-app-publish',
    'raw-secret-exposure',
    'raw-identity-exposure',
  ]) assert(report.forbiddenRuntimeCapabilities.includes(forbidden as never), `forbidden runtime ${forbidden}`);
});

test('CLI emits fixed redaction-safe JSON without input or secret echoes', () => {
  const result = runCli(['--json', 'PRIVATE_TITLE_SENTINEL', 'SECRET_VALUE_SENTINEL']);
  const stdout = String(result.stdout);
  assert(result.status === 0, 'CLI exits zero');
  const parsed = JSON.parse(stdout) as LongRunningServiceBoundaryReport;
  assert(parsed.report === 'phase-146-long-running-service-boundary', 'parsed report');
  assert(parsed.plannedOperatorPort === 8099, 'json port');
  assert(!stdout.includes('PRIVATE_TITLE_SENTINEL'), 'stdout omits hostile title');
  assert(!stdout.includes('SECRET_VALUE_SENTINEL'), 'stdout omits hostile secret');
});

test('source and docs preserve boundary before Phase 147 implementation', () => {
  const source = `${read('src/ops/long-running-service-boundary.ts')}\n${read('src/ops/long-running-service-boundary-cli.ts')}`;
  const docs = `${read('docs/PHASE_146_LONG_RUNNING_SERVICE_BOUNDARY.md')}\n${read('README.md')}\n${read('package.json')}`;
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  assert(scripts['test:long-running-service-boundary'] === 'tsx test/long-running-service-boundary.ts', 'test script');
  assert(scripts['ops:long-running-service-boundary'] === 'tsx src/ops/long-running-service-boundary-cli.ts', 'ops script');
  assert((scripts.test ?? '').includes('test/control-surface-compose-boundary.ts && tsx test/long-running-service-boundary.ts'), 'aggregate order');
  for (const required of [
    'phase-146-long-running-service-boundary',
    'API plus minimal operator UI',
    'backend orchestration rail',
    'It is not the streaming product',
    'local-admin-token-file',
    '/mnt/user/appdata/catalog/secrets/operator_ui_token',
    'read-only first',
    '8099',
    'system logs',
    'operation logs',
    'connector logs',
    'No accidental ports',
    'phase-147-implement-first-always-on-service',
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
