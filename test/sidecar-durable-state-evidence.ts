import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildDurableSidecarStateEvidencePacket,
  formatDurableSidecarStateEvidenceText,
  type DurableSidecarStateEvidencePacket,
} from '../src/ops/sidecar-durable-state-evidence.js';

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
const documentedNpmJsonCommand = 'npm run --silent ops:sidecar-durable-state-evidence -- -- --json';

console.log('Running Phase 103/104 durable sidecar state evidence suite:\n');

await test('durable state evidence proves restart persistence and restore fail-closed behavior', async () => {
  const report = await buildDurableSidecarStateEvidencePacket();
  assert(report.ok === true, 'report ok');
  assert(report.report === 'phase-103-104-durable-sidecar-state-evidence', 'report id');
  assert(report.durableStatePrototypeImplemented === true, 'durable state prototype implemented');
  assert(report.restartPersistenceExercised === true, 'restart persistence exercised');
  assert(report.restoreFailClosedExercised === true, 'restore fail closed exercised');
  assert(report.localSocketOnly === true, 'local socket only');
  assert(report.sidecarStateValuesEchoed === false, 'state values not echoed');
  assert(report.serviceInstallAllowed === false && report.liveValidationAllowed === false, 'service install and live validation blocked');
  assert(report.closesO4 === false && report.closesO5 === false, 'no gate closure');
  for (const check of report.checks) assert(check.status === 'pass', `check passes: ${check.id}`);
  assert(new Set(report.checks.map((check) => check.id)).has('restart-preserves-active-key'), 'restart persistence check present');
  assert(new Set(report.checks.map((check) => check.id)).has('mismatched-state-read-fails-closed'), 'mismatch fail-closed check present');
  assert(report.evidenceHarness.reviewReadiness === 'ready-for-review', 'manifest ready for review');
  assertNoLeak(report);
  assertNoLeak(formatDurableSidecarStateEvidenceText(report));
});

await test('CLI and documented npm command emit parseable redaction-safe JSON', () => {
  const sentinels = ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://user:pass@example.invalid/db'];
  const direct = execFileSync('node', ['--import', 'tsx', 'src/ops/sidecar-durable-state-evidence-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: sentinels[0],
      PRIVATE_TITLE: sentinels[1],
      DATABASE_URL: sentinels[2],
    },
    encoding: 'utf8',
  });
  const directParsed = JSON.parse(direct) as DurableSidecarStateEvidencePacket;
  assert(directParsed.report === 'phase-103-104-durable-sidecar-state-evidence', 'direct JSON report id');
  const documented = execSync(documentedNpmJsonCommand, { cwd: root, encoding: 'utf8' });
  const documentedParsed = JSON.parse(documented) as DurableSidecarStateEvidencePacket;
  assert(documentedParsed.ok === true, 'documented command ok');
  for (const sentinel of sentinels) {
    assert(!direct.includes(sentinel), `direct output omits ${sentinel}`);
    assert(!documented.includes(sentinel), `documented output omits ${sentinel}`);
  }
});

await test('source and docs preserve durable-state prototype boundary', () => {
  const source = `${read('src/ops/sidecar-durable-state-evidence.ts')}\n${read('src/ops/sidecar-durable-state-evidence-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_103_104_DURABLE_SIDECAR_STATE_EVIDENCE.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const forbidden of [
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 103/104 source excludes ${forbidden}`);
  for (const required of [
    'phase-103-104-durable-sidecar-state-evidence',
    'DURABLE_SIDECAR_STATE_EVIDENCE',
    'restartPersistenceExercised: true',
    'restoreFailClosedExercised: true',
    'sidecarStateValuesEchoed: false',
    'serviceInstallAllowed: false',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 103/104 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

function assertNoLeak(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const sentinel of [
    'phase-103-104-sidecar-secret',
    'durable-item-redacted',
    'wrappedHex',
    'dekBase64',
    'postgres://',
    'http://',
    'https://',
    'PRIVATE',
  ]) assert(!text.includes(sentinel), `evidence leaked ${sentinel}`);
}
