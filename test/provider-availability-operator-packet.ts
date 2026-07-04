import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PROVIDER_AVAILABILITY_OPERATOR_PACKET,
  formatProviderAvailabilityOperatorPacketJson,
  formatProviderAvailabilityOperatorPacketText,
  type ProviderAvailabilityOperatorPacket,
} from '../src/ops/provider-availability-operator-packet.js';

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

console.log('Running Phase 59 provider availability operator packet suite:\n');

test('packet covers sanitized bridge reports through count-only summary review', () => {
  const packet = PROVIDER_AVAILABILITY_OPERATOR_PACKET;
  assert(packet.report === 'phase-59-provider-availability-operator-packet', 'report name');
  assert(packet.steps.length === 3, 'three ordered steps');
  assert(packet.steps.map((step) => step.number).join(',') === '1,2,3', 'steps numbered');
  for (const phase of ['Phase 56', 'Phase 58', 'Phase 59']) {
    assert(packet.steps.some((step) => step.phase === phase), `contains ${phase}`);
  }
  assert(packet.steps.some((step) => step.commandShapes.some((shape) => shape.includes('ops:provider-availability-summary'))), 'contains summary command');
});

test('packet is static and keeps provider mode and production gates closed', () => {
  const packet = PROVIDER_AVAILABILITY_OPERATOR_PACKET;
  assert(packet.providerContact === false, 'no provider contact');
  assert(packet.commandExecution === false, 'no command execution');
  assert(packet.credentialValuesIncluded === false, 'no credential values');
  assert(packet.credentialPathsIncluded === false, 'no credential paths');
  assert(packet.rawRefsIncluded === false, 'no raw refs');
  assert(packet.providerPayloadsIncluded === false, 'no provider payloads');
  assert(packet.itemRowsIncluded === false, 'no item rows');
  assert(packet.mediaIdentityIncluded === false, 'no media identity');
  assert(packet.summaryValuesEchoed === false, 'no summary values echoed');
  assert(packet.enablesProviderMode === false, 'provider mode not enabled');
  assert(packet.persisted === false, 'not persisted');
  assert(packet.closesO4 === false && packet.closesO5 === false, 'does not close production gates');
  assert(packet.o4Status === 'open/deferred' && packet.o5Status === 'open/deferred', 'O4/O5 visible');
});

test('text and JSON output contain placeholders but no concrete secret/path/ref values', () => {
  const text = formatProviderAvailabilityOperatorPacketText();
  const json = formatProviderAvailabilityOperatorPacketJson();
  const parsed = JSON.parse(json) as ProviderAvailabilityOperatorPacket;
  assert(parsed.report === 'phase-59-provider-availability-operator-packet', 'json report name');
  for (const placeholder of PROVIDER_AVAILABILITY_OPERATOR_PACKET.placeholders) {
    assert(text.includes(placeholder), `text includes ${placeholder}`);
    assert(json.includes(placeholder), `json includes ${placeholder}`);
  }
  for (const forbidden of [
    'Bearer ',
    'TORBOX_TOKEN=',
    'api.torbox.app/v1',
    'postgres://',
    '/mnt/user/',
    '/run/secrets',
    'RAW-INFOHASH',
    'SECRET-PROVIDER-PAYLOAD',
    'Private Movie Title',
  ]) {
    assert(!text.includes(forbidden), `text excludes ${forbidden}`);
    assert(!json.includes(forbidden), `json excludes ${forbidden}`);
  }
});

test('CLI output is deterministic and ignores hostile environment values', () => {
  const env = {
    ...process.env,
    TORBOX_TOKEN: 'SCARY_SENTINEL_TORBOX_TOKEN',
    PROVIDER_RAW_REF: 'SCARY_SENTINEL_RAW_REF',
    PROVIDER_PAYLOAD: 'SCARY_SENTINEL_PAYLOAD',
    DATABASE_URL: 'postgresql://scary:secret@example.invalid/db',
  };
  const text = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/provider-availability-operator-packet-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/provider-availability-operator-packet-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text === formatProviderAvailabilityOperatorPacketText(), 'fixed text');
  assert(json === formatProviderAvailabilityOperatorPacketJson(), 'fixed json');
  for (const sentinel of ['SCARY_SENTINEL', 'postgresql://scary']) {
    assert(!text.includes(sentinel), `text omits ${sentinel}`);
    assert(!json.includes(sentinel), `json omits ${sentinel}`);
  }
});

test('npm JSON invocation returns parseable JSON', () => {
  const out = execFileSync('npm', ['run', '--silent', 'ops:provider-availability-operator-packet', '--', '--json'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const parsed = JSON.parse(out) as ProviderAvailabilityOperatorPacket;
  assert(parsed.report === 'phase-59-provider-availability-operator-packet', 'parsed JSON report name');
  assert(parsed.providerContact === false && parsed.commandExecution === false, 'parsed JSON is static');
});

test('source has no filesystem, env, network, DB, Docker, adapter-mode, execution, or UI creep', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assert(pkg.scripts['ops:provider-availability-operator-packet'] === 'tsx src/ops/provider-availability-operator-packet-cli.ts', 'ops script');
  assert(pkg.scripts['test:provider-availability-operator-packet'] === 'tsx test/provider-availability-operator-packet.ts', 'test script');
  assert((pkg.scripts.test ?? '').includes('test/provider-availability-operator-packet.ts'), 'suite in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke not in npm test');

  const packet = read('src/ops/provider-availability-operator-packet.ts');
  const cli = read('src/ops/provider-availability-operator-packet-cli.ts');
  const combined = `${packet}\n${cli}`;
  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'execFileSync',
    'spawnSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
  ]) assert(!combined.includes(forbidden), `source excludes ${forbidden}`);
});

test('docs preserve the static redaction boundary', () => {
  const doc = read('docs/PHASE_59_PROVIDER_AVAILABILITY_OPERATOR_PACKET.md');
  const readme = read('README.md');
  const deploy = read('test/deploy.ts');
  const combined = `${doc}\n${readme}\n${deploy}`;
  for (const kw of [
    'phase-59-provider-availability-operator-packet',
    'ops:provider-availability-operator-packet',
    'Provider availability operator packet (Phase 59)',
    'sanitized Phase 56 bridge reports',
    'Phase 58 count-only summary',
    'no credential values',
    'no raw refs',
    'no live TorBox contact or any provider contact',
    'does not enable provider mode',
    'O4 and O5 remain open/deferred',
    'FileCustodian',
  ]) assert(combined.includes(kw), `docs include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
