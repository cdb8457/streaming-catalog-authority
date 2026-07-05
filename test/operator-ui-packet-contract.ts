import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_UI_CATEGORY_LABELS,
  OPERATOR_UI_DISPLAY_FIELD_LABELS,
  OPERATOR_UI_EXAMPLE_PACKET_DESCRIPTORS,
  OPERATOR_UI_FORBIDDEN_FIELD_CATEGORIES,
  OPERATOR_UI_SCREEN_IDS,
  OPERATOR_UI_STATUS_LABELS,
  validateOperatorUiPacketDescriptor,
} from '../src/ops/operator-ui-packet-contract.js';

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

console.log('Running Phase 61 operator UI packet contract suite:\n');

test('all nine Phase 60 conceptual screens are represented', () => {
  assert(OPERATOR_UI_SCREEN_IDS.length === 9, 'nine screen ids');
  for (const screenId of [
    'overview',
    'catalog-authority',
    'privacy-crypto-shredding',
    'key-custodian-o4-status',
    'reconciler',
    'backup-restore',
    'provider-availability-packets',
    'audit-queue',
    'settings-operator-configuration',
  ]) {
    assert(OPERATOR_UI_SCREEN_IDS.includes(screenId as never), `screen id ${screenId}`);
    assert(OPERATOR_UI_EXAMPLE_PACKET_DESCRIPTORS.some((descriptor) => descriptor.screenId === screenId), `example ${screenId}`);
  }
});

test('allowlists contain only Phase 60 synthetic labels and fixed status/category labels', () => {
  for (const label of [
    'Item A',
    'Item B',
    'Provider Count',
    'Shred State',
    'Backup Integrity',
    'Reconcile Status',
    'Event Sequence',
    'Packet Count',
    'Review Required',
    'Key State',
    'Custodian Status',
    'Backup Verified',
  ]) assert(OPERATOR_UI_DISPLAY_FIELD_LABELS.includes(label as never), `field label ${label}`);

  for (const label of ['Open', 'Deferred', 'Verified', 'Warning', 'Failed', 'Blocked', 'Synced']) {
    assert(OPERATOR_UI_STATUS_LABELS.includes(label as never), `status label ${label}`);
  }
  for (const label of ['System Health', 'Catalog Authority', 'Provider Availability', 'Audit Review']) {
    assert(OPERATOR_UI_CATEGORY_LABELS.includes(label as never), `category label ${label}`);
  }
});

test('valid packet descriptors with synthetic labels pass', () => {
  for (const descriptor of OPERATOR_UI_EXAMPLE_PACKET_DESCRIPTORS) {
    const result = validateOperatorUiPacketDescriptor(descriptor);
    assert(result.ok, `descriptor ${descriptor.screenId} passes`);
    assert(result.code === 'OPERATOR_UI_PACKET_ACCEPTED', 'accepted code');
    assert(result.message === 'Operator UI packet descriptor is redaction-safe.', 'safe message');
    assert(result.issues.length === 0, 'no issues');
  }
});

test('unsafe fields fail closed without echoing unsafe values', () => {
  const hostile = {
    screenId: 'overview',
    fields: [
      {
        label: 'Private Movie Title',
        title: 'Extremely Identifying Title',
        providerRef: 'magnet:?xt=urn:btih:ABCDEF',
        token: 'SECRET_TOKEN_SENTINEL',
      },
    ],
    rawPayload: { url: 'https://provider.example.invalid/private' },
  };
  const result = validateOperatorUiPacketDescriptor(hostile);
  const json = JSON.stringify(result);
  assert(!result.ok, 'rejected');
  assert(result.code === 'OPERATOR_UI_PACKET_REJECTED', 'rejected code');
  for (const unsafe of [
    'Private Movie Title',
    'Extremely Identifying Title',
    'magnet:',
    'ABCDEF',
    'SECRET_TOKEN_SENTINEL',
    'provider.example.invalid',
    'rawPayload',
    'providerRef',
  ]) assert(!json.includes(unsafe), `result omits ${unsafe}`);
  for (const code of [
    'OPERATOR_UI_PACKET_FORBIDDEN_DESCRIPTOR_KEY',
    'OPERATOR_UI_PACKET_FORBIDDEN_FIELD_KEY',
    'OPERATOR_UI_PACKET_FORBIDDEN_FIELD_LABEL',
  ]) assert(json.includes(code), `result includes fixed code ${code}`);
});

test('validator output is deterministic and redaction-safe for hostile strings', () => {
  const hostile = {
    screenId: 'https://example.invalid/secret?token=abc',
    fields: [
      {
        label: 'databaseUrl postgres://user:pass@example.invalid/db',
        statusLabel: 'Bearer SECRET',
        categoryLabel: '/mnt/user/media/private-title',
      },
    ],
    poster: 'https://image.example.invalid/poster.jpg',
  };
  const a = validateOperatorUiPacketDescriptor(hostile);
  const b = validateOperatorUiPacketDescriptor(JSON.parse(JSON.stringify(hostile)) as unknown);
  const json = JSON.stringify(a);
  assert(JSON.stringify(a) === JSON.stringify(b), 'deterministic result');
  assert(!a.ok, 'hostile descriptor rejected');
  for (const sentinel of [
    'example.invalid',
    'postgres://',
    'Bearer',
    'SECRET',
    '/mnt/user',
    'private-title',
    'poster.jpg',
    'token=abc',
  ]) assert(!json.includes(sentinel), `validator result omits ${sentinel}`);
});

test('forbidden category denylist covers identity, provider, credential, path, artwork, raw, and playback risks', () => {
  for (const category of [
    'title',
    'externalId',
    'providerRef',
    'infohash',
    'magnet',
    'credential',
    'token',
    'secret',
    'path',
    'url',
    'poster',
    'artwork',
    'providerName',
    'providerLogo',
    'rawPayload',
    'rawLog',
    'databaseUrl',
    'playback',
    'download',
    'stream',
  ]) assert(OPERATOR_UI_FORBIDDEN_FIELD_CATEGORIES.includes(category as never), `denylist includes ${category}`);
});

test('source has no frontend/API/runtime/DB/provider/network/env/file-read scope creep', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react']) {
    assert(!allDeps.includes(dep), `no frontend/API dependency ${dep}`);
  }
  assert(pkg.scripts['test:operator-ui-packet-contract'] === 'tsx test/operator-ui-packet-contract.ts', 'test script');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-packet-contract.ts'), 'suite in npm test');

  const source = read('src/ops/operator-ui-packet-contract.ts');
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
    'download controls',
    'playback controls',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'document.',
    'window.',
    'localStorage',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
});

test('docs and deploy guard preserve the static Phase 61 boundary', () => {
  const combined = `${read('docs/PHASE_61_OPERATOR_UI_PACKET_CONTRACT.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 61',
    'operator UI packet contract',
    'static contract',
    'allowed screens',
    'allowed fields',
    'forbidden data categories',
    'no React, Vite, Next, Express, frontend framework, CSS, image, HTTP route, API route, database read, provider adapter, network call, env read, or file read',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Phase 62',
  ]) assert(combined.includes(kw), `docs/deploy include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
