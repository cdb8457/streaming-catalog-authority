import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiPacketSourceContractReport,
  formatOperatorUiPacketSourceContractText,
  type OperatorUiPacketSourceContractReport,
} from '../src/ops/operator-ui-packet-source-contract.js';

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
const source = read('src/ops/operator-ui-packet-source-contract.ts');
const cliSource = read('src/ops/operator-ui-packet-source-contract-cli.ts');
const documentedNpmJsonCommand = 'npm run --silent ops:operator-ui-packet-source-contract -- -- --json';

console.log('Running Phase 69 operator UI packet source contract suite:\n');

test('packet source contract report is fixed, synthetic, no-input, and deterministic', () => {
  const first = buildOperatorUiPacketSourceContractReport();
  const second = buildOperatorUiPacketSourceContractReport();
  assert(JSON.stringify(first) === JSON.stringify(second), 'report is deterministic');
  assert(first.ok, 'report ok');
  assert(first.code === 'OPERATOR_UI_PACKET_SOURCE_CONTRACT_REPORTED', 'fixed code');
  assert(first.source === 'fixed-synthetic-packet-source-contract', 'fixed synthetic source');
  assert(first.message === 'Operator UI packet source contract is fixed, synthetic, and no-input.', 'fixed message');
});

test('only sanitized future packet sources are allowed and not implemented', () => {
  const report = buildOperatorUiPacketSourceContractReport();
  assert(report.allowedFutureSources.length === 2, 'two future source options');
  const byId = new Map(report.allowedFutureSources.map((sourceOption) => [sourceOption.id, sourceOption]));
  assert(byId.get('immutable-readonly-packet-snapshot')?.status === 'allowed-future-source/not-implemented', 'snapshot source not implemented');
  assert(byId.get('sanitized-local-packet-endpoint')?.status === 'allowed-future-source/not-implemented', 'endpoint source not implemented');
  assert(byId.get('immutable-readonly-packet-snapshot')?.contract.includes('immutable/read-only packet snapshots'), 'snapshot contract');
  assert(byId.get('sanitized-local-packet-endpoint')?.contract.includes('explicit sanitized local packet endpoint'), 'endpoint contract');
});

test('producer guards require sanitization, allowlists, and redaction-safe synthetic packets', () => {
  const json = JSON.stringify(buildOperatorUiPacketSourceContractReport());
  for (const required of [
    'Packet producer must sit behind explicit sanitization and allowlist checks',
    'Packet producer must emit only redaction-safe operator packets',
    'Packet producer must emit only synthetic labels, counts, and statuses',
    'Packet source must preserve Phase 61 operator UI packet descriptor allowlists',
    'Provider availability remains packet/count/advisory only',
  ]) assert(json.includes(required), `report includes ${required}`);
});

test('direct DB/provider/raw source shapes and sensitive categories are forbidden', () => {
  const report = buildOperatorUiPacketSourceContractReport();
  const json = JSON.stringify(report);
  for (const required of [
    'direct UI DB reads',
    'raw event payloads',
    'provider or adapter reads',
    'live packet ingestion',
    'local state scans',
    'operator data passthrough',
    'real titles',
    'external IDs',
    'provider names/logos',
    'raw provider refs',
    'infohashes',
    'magnets',
    'credentials',
    'paths',
    'artwork',
    'user library data',
    'media-control/retrieval commands',
  ]) assert(json.includes(required), `report forbids ${required}`);
});

test('runtime and product launch remain blocked', () => {
  const report = buildOperatorUiPacketSourceContractReport();
  assert(
    report.runtimeDecision.localReadonlyRuntime === 'blocked/deferred until source, auth, and runtime designs are satisfied',
    'local runtime blocked/deferred',
  );
  assert(report.runtimeDecision.liveProduct === 'not-ready', 'live product not ready');
  const json = JSON.stringify(report);
  for (const required of [
    'No source implementation is added',
    'No endpoint implementation is added',
    'No direct UI DB access is allowed',
    'No packet producer, runtime, or ingestion path is implemented',
    'Local read-only runtime remains blocked/deferred',
    'Live product launch remains not-ready',
  ]) assert(json.includes(required), `boundary includes ${required}`);
});

test('O4/O5 and FileCustodian reference boundary remain visible', () => {
  const json = JSON.stringify(buildOperatorUiPacketSourceContractReport());
  for (const required of [
    'O4 production custodian is open/deferred',
    'O5 managed KEK custody/scheduling is open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(json.includes(required), `report includes ${required}`);
});

test('text output is deterministic and parseable', () => {
  const first = formatOperatorUiPacketSourceContractText();
  const second = formatOperatorUiPacketSourceContractText();
  assert(first === second, 'text is deterministic');
  for (const line of [
    'Operator UI Packet Source Contract',
    '- immutable-readonly-packet-snapshot: allowed-future-source/not-implemented',
    '- sanitized-local-packet-endpoint: allowed-future-source/not-implemented',
    '- direct UI DB reads',
    '- raw event payloads',
    '- local-readonly-runtime: blocked/deferred until source, auth, and runtime designs are satisfied',
    '- live-product: not-ready',
  ]) assert(first.includes(line), `text includes ${line}`);
  assert(first.endsWith('\n'), 'text ends with newline');
});

test('--json CLI output is parseable and redaction-safe', () => {
  const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-packet-source-contract-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: 'SECRET_TOKEN_SENTINEL',
      PRIVATE_TITLE: 'Private Movie Sentinel',
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output) as OperatorUiPacketSourceContractReport;
  assert(parsed.code === 'OPERATOR_UI_PACKET_SOURCE_CONTRACT_REPORTED', 'json code');
  assert(parsed.allowedFutureSources.some((sourceOption) => sourceOption.id === 'immutable-readonly-packet-snapshot'), 'json snapshot source');
  assert(parsed.runtimeDecision.liveProduct === 'not-ready', 'json live not ready');
  for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
    assert(!output.includes(sentinel), `json omits hostile env ${sentinel}`);
  }
});

test('documented npm JSON command output is parseable and redaction-safe', () => {
  const output = execSync(documentedNpmJsonCommand, {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: 'SECRET_TOKEN_SENTINEL',
      PRIVATE_TITLE: 'Private Movie Sentinel',
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output) as OperatorUiPacketSourceContractReport;
  assert(parsed.code === 'OPERATOR_UI_PACKET_SOURCE_CONTRACT_REPORTED', 'documented npm json code');
  assert(parsed.allowedFutureSources.some((sourceOption) => sourceOption.id === 'sanitized-local-packet-endpoint'), 'documented npm json endpoint source');
  for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
    assert(!output.includes(sentinel), `documented npm json omits hostile env ${sentinel}`);
  }
});

test('text CLI output is formatter output', () => {
  const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-packet-source-contract-cli.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert(output === formatOperatorUiPacketSourceContractText(), 'CLI prints formatter output');
  assert(output.includes('- sanitized-local-packet-endpoint: allowed-future-source/not-implemented'), 'CLI text includes endpoint source');
});

test('helper and CLI source has no runtime UI/API/network/DB/env/file/provider execution scope', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
    assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
  }
  assert(pkg.scripts['test:operator-ui-packet-source-contract'] === 'tsx test/operator-ui-packet-source-contract.ts', 'test script');
  assert(pkg.scripts['ops:operator-ui-packet-source-contract'] === 'tsx src/ops/operator-ui-packet-source-contract-cli.ts', 'ops script');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-runtime-boundary.ts && tsx test/operator-ui-packet-source-contract.ts'),
    'suite follows Phase 68',
  );

  const combined = `${source}\n${cliSource}`;
  for (const forbidden of [
    'react',
    'vite',
    'next',
    'express',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'from "pg"',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'Real-Debrid',
    'Plex',
    'Jellyfin',
    'Hermes',
    'scraping',
    'playback',
    'download',
    'writeFile',
    'createWriteStream',
  ]) assert(!combined.includes(forbidden), `source excludes ${forbidden}`);
});

test('docs, README, and deploy guard mention Phase 69 packet source contract', () => {
  const combined = `${read('docs/PHASE_69_OPERATOR_UI_PACKET_SOURCE_CONTRACT.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 69',
    'Sanitized Local Operator Packet Source Contract',
    'operator UI packet source contract',
    'ops:operator-ui-packet-source-contract',
    'test:operator-ui-packet-source-contract',
    documentedNpmJsonCommand,
    'immutable/read-only packet snapshots',
    'explicit sanitized local packet endpoint',
    'explicit sanitization and allowlist checks',
    'redaction-safe operator packets',
    'synthetic labels, counts, and statuses',
    'no direct UI DB reads',
    'no raw event payloads',
    'no raw provider refs',
    'provider availability remains packet/count/advisory only',
    'local read-only runtime remains blocked',
    'live product launch remains not ready',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 69 docs/deploy include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
