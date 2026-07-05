import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_UI_CATEGORY_LABELS,
  OPERATOR_UI_DISPLAY_FIELD_LABELS,
  OPERATOR_UI_SCREEN_IDS,
  OPERATOR_UI_STATUS_LABELS,
  validateOperatorUiPacketDescriptor,
} from '../src/ops/operator-ui-packet-contract.js';
import {
  formatOperatorUiFixtureReport,
  OPERATOR_UI_FIXTURE_PACKETS,
  validateOperatorUiFixturePacket,
  validateOperatorUiFixturePackets,
} from '../src/ops/operator-ui-fixtures.js';

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

console.log('Running Phase 62 operator UI fixture packet suite:\n');

test('all nine screens have exactly one deterministic fixture packet', () => {
  assert(OPERATOR_UI_FIXTURE_PACKETS.length === 9, 'nine fixture packets');
  const seen = new Set(OPERATOR_UI_FIXTURE_PACKETS.map((packet) => packet.screenId));
  assert(seen.size === 9, 'no duplicate fixture screens');
  for (const screenId of OPERATOR_UI_SCREEN_IDS) assert(seen.has(screenId), `fixture covers ${screenId}`);
  assert(JSON.stringify(OPERATOR_UI_FIXTURE_PACKETS) === JSON.stringify([...OPERATOR_UI_FIXTURE_PACKETS]), 'stable order');
});

test('every fixture descriptor passes the Phase 61 validator', () => {
  for (const packet of OPERATOR_UI_FIXTURE_PACKETS) {
    const descriptorResult = validateOperatorUiPacketDescriptor(packet.descriptor);
    assert(descriptorResult.ok, `descriptor ${packet.screenId} passes`);
    const packetResult = validateOperatorUiFixturePacket(packet);
    assert(packetResult.ok, `fixture ${packet.screenId} passes`);
  }

  const report = validateOperatorUiFixturePackets();
  assert(report.ok, 'fixture report accepted');
  assert(report.code === 'OPERATOR_UI_FIXTURE_PACKET_ACCEPTED', 'accepted code');
  assert(report.message === 'Operator UI fixture packets are redaction-safe.', 'accepted message');
  assert(report.acceptedCount === 9 && report.rejectedCount === 0, 'fixed counts');
});

test('fixture strings are limited to allowed synthetic labels and fixed categories', () => {
  const allowed = new Set<string>([
    ...OPERATOR_UI_SCREEN_IDS,
    ...OPERATOR_UI_DISPLAY_FIELD_LABELS,
    ...OPERATOR_UI_STATUS_LABELS,
    ...OPERATOR_UI_CATEGORY_LABELS,
  ]);
  const strings = JSON.stringify(OPERATOR_UI_FIXTURE_PACKETS).match(/"([^"]+)"/g) ?? [];
  for (const quoted of strings) {
    const value = quoted.slice(1, -1);
    if (['screenId', 'screenLabel', 'descriptor', 'fields', 'rows', 'cells', 'label', 'statusLabel', 'categoryLabel'].includes(value)) continue;
    assert(allowed.has(value), `fixture string is allowlisted: ${value}`);
  }
});

test('fixtures contain no identity, provider detail, path, artwork, raw, or stream data', () => {
  const fixtureJson = JSON.stringify(OPERATOR_UI_FIXTURE_PACKETS);
  for (const forbidden of [
    'Private Movie',
    'Episode',
    'externalId',
    'providerRef',
    'infohash',
    'magnet:',
    'credential',
    'token',
    'secret',
    'databaseUrl',
    'postgres://',
    '/mnt/',
    'C:\\',
    'http://',
    'https://',
    'poster',
    'artwork',
    'providerName',
    'providerLogo',
    'rawPayload',
    'rawLog',
    'library',
    'playback',
    'download',
    'stream',
    'NODE-001',
    'Admin',
    'System_Daemon',
  ]) assert(!fixtureJson.includes(forbidden), `fixture output omits ${forbidden}`);
});

test('fixture validation failures use fixed messages and do not echo hostile input', () => {
  const hostile = {
    screenId: 'overview',
    descriptor: {
      screenId: 'https://example.invalid/private?token=SECRET',
      fields: [
        {
          label: 'Private Movie Title',
          providerRef: 'magnet:?xt=urn:btih:ABCDEF',
          rawPayload: 'databaseUrl postgres://user:pass@example.invalid/db',
        },
      ],
    },
  };
  const result = validateOperatorUiFixturePacket(hostile);
  const formatted = formatOperatorUiFixtureReport({
    ok: false,
    code: 'OPERATOR_UI_FIXTURE_PACKET_REJECTED',
    message: 'Operator UI fixture packet rejected by static contract.',
    screens: ['overview'],
    acceptedCount: 0,
    rejectedCount: 1,
  });
  const combined = `${JSON.stringify(result)}\n${formatted}`;
  assert(!result.ok, 'hostile fixture rejected');
  const wrapperResult = validateOperatorUiFixturePacket({
    ...OPERATOR_UI_FIXTURE_PACKETS[0],
    rawPayload: 'https://example.invalid/private?token=SECRET',
  });
  assert(!wrapperResult.ok, 'hostile wrapper rejected');
  for (const sentinel of [
    'example.invalid',
    'SECRET',
    'Private Movie',
    'magnet:',
    'ABCDEF',
    'postgres://',
    'providerRef',
    'rawPayload',
  ]) assert(!combined.includes(sentinel), `failure output omits ${sentinel}`);
});

test('source has no frontend/API/runtime/DB/provider/network/env/file-read scope creep', () => {
  const source = read('src/ops/operator-ui-fixtures.ts');
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
    'download',
    'playback',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
});

test('docs, package scripts, and deploy guard mention Phase 62 fixtures', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['test:operator-ui-fixtures'] === 'tsx test/operator-ui-fixtures.ts', 'test script');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-packet-contract.ts && tsx test/operator-ui-fixtures.ts'), 'suite near Phase 61');

  const combined = `${read('docs/PHASE_62_OPERATOR_UI_FIXTURES.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 62',
    'operator UI fixture packets',
    'static fixture purpose',
    'overview',
    'settings-operator-configuration',
    'Item A',
    'Provider Count',
    'Review Required',
    'privacy/non-goals',
    'Phase 63',
    'fixture packets only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 62 docs/deploy include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
