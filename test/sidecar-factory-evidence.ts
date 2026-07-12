import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarFactoryEvidencePacket,
  formatSidecarFactoryEvidenceText,
  type SidecarFactoryEvidencePacket,
} from '../src/ops/sidecar-factory-evidence.js';

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

console.log('Running Phase 189 sidecar factory evidence suite:\n');

await test('evidence packet proves daemon plus factory sidecar path without cutover', async () => {
  const report = await buildSidecarFactoryEvidencePacket();
  assert(report.ok === true, 'report ok');
  assert(report.report === 'phase-189-sidecar-factory-evidence', 'report id');
  assert(report.code === 'SIDECAR_FACTORY_EVIDENCE', 'report code');
  assert(report.daemonWrapperExercised === true, 'daemon wrapper exercised');
  assert(report.custodianFactorySidecarModeExercised === true, 'factory sidecar mode exercised');
  assert(report.localSocketOnly === true, 'local socket only');
  assert(report.appHeldCompletionSecretRequired === false, 'app-held completion secret not required for sidecar factory mode');
  assert(report.appHeldKekRequired === false, 'app-held KEK not required for sidecar factory mode');
  assert(report.serviceInstallAllowed === false, 'service install blocked');
  assert(report.composeChangeAllowed === false, 'compose change blocked');
  assert(report.runtimeCutoverAllowed === false, 'runtime cutover blocked');
  assert(report.providerContactAllowed === false && report.playbackAllowed === false && report.mediaServerMutationAllowed === false, 'provider/media behavior blocked');
  assert(report.closesO4 === false && report.closesO5 === false, 'no O4/O5 closure');
  for (const check of report.checks) assert(check.status === 'pass', `check passes: ${check.id}`);
  assertNoLeak(report);
  assertNoLeak(formatSidecarFactoryEvidenceText(report));
});

await test('CLI and documented npm command emit parseable redaction-safe JSON', () => {
  const sentinels = ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://user:pass@example.invalid/db'];
  const direct = execFileSync('node', ['--import', 'tsx', 'src/ops/sidecar-factory-evidence-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: sentinels[0],
      PRIVATE_TITLE: sentinels[1],
      DATABASE_URL: sentinels[2],
    },
    encoding: 'utf8',
  });
  const directParsed = JSON.parse(direct) as SidecarFactoryEvidencePacket;
  assert(directParsed.report === 'phase-189-sidecar-factory-evidence', 'direct JSON report id');

  const documented = execSync('npm run --silent ops:sidecar-factory-evidence -- -- --json', { cwd: root, encoding: 'utf8' });
  const documentedParsed = JSON.parse(documented) as SidecarFactoryEvidencePacket;
  assert(documentedParsed.ok === true, 'documented command ok');
  for (const sentinel of sentinels) {
    assert(!direct.includes(sentinel), `direct output omits ${sentinel}`);
    assert(!documented.includes(sentinel), `documented output omits ${sentinel}`);
  }
});

await test('source and docs preserve sidecar factory evidence boundary', () => {
  const source = `${read('src/ops/sidecar-factory-evidence.ts')}\n${read('src/ops/sidecar-factory-evidence-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_189_SIDECAR_FACTORY_EVIDENCE.md')}\n${read('README.md')}\n${read('package.json')}`;
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
  ]) assert(!source.includes(forbidden), `Phase 189 source excludes ${forbidden}`);
  for (const required of [
    'phase-189-sidecar-factory-evidence',
    'SIDECAR_FACTORY_EVIDENCE',
    'ops:sidecar-factory-evidence',
    'test:sidecar-factory-evidence',
    'daemonWrapperExercised: true',
    'custodianFactorySidecarModeExercised: true',
    'appHeldCompletionSecretRequired: false',
    'appHeldKekRequired: false',
    'serviceInstallAllowed: false',
    'composeChangeAllowed: false',
    'runtimeCutoverAllowed: false',
    'providerContactAllowed: false',
    'mediaServerMutationAllowed: false',
    'O4 remains open',
    'O5 remains open',
  ]) assert(combined.includes(required), `Phase 189 surface preserves ${required}`);
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
    'phase-189-sidecar-factory-secret',
    'phase-189-item-redacted',
    'key_',
    'rcpt_',
    'wrappedHex',
    'dekBase64',
    'postgres://',
    'http://',
    'https://',
    'PRIVATE',
  ]) assert(!text.includes(sentinel), `evidence leaked ${sentinel}`);
}
