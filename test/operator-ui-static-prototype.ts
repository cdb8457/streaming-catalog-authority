import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_UI_CATEGORY_LABELS,
  OPERATOR_UI_DISPLAY_FIELD_LABELS,
  OPERATOR_UI_SCREEN_IDS,
  OPERATOR_UI_STATUS_LABELS,
} from '../src/ops/operator-ui-packet-contract.js';
import { OPERATOR_UI_FIXTURE_PACKETS } from '../src/ops/operator-ui-fixtures.js';
import { renderOperatorUiStaticPrototypeHtml } from '../src/ops/operator-ui-static-prototype.js';

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
const source = read('src/ops/operator-ui-static-prototype.ts');
const cliSource = read('src/ops/operator-ui-static-prototype-cli.ts');

console.log('Running Phase 63 static operator UI prototype suite:\n');

test('renderer emits deterministic complete static HTML', () => {
  const first = renderOperatorUiStaticPrototypeHtml();
  const second = renderOperatorUiStaticPrototypeHtml();
  assert(first === second, 'stable render');
  assert(first.startsWith('<!doctype html><html lang="en">'), 'complete document start');
  assert(first.endsWith('</html>'), 'complete document end');
  assert(first.includes('<style>') && first.includes('</style>'), 'inline CSS only');
  assert(first.includes('<script>') && first.includes('</script>'), 'Phase 81 fixed inline script');
  assert(first.includes('/operator-ui/packets.json'), 'Phase 81 local packet endpoint path');
  assert(!first.includes(' src=') && !first.includes(' rel="stylesheet"'), 'no external asset link');
});

test('all nine conceptual screens appear in nav and panels', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  assert(OPERATOR_UI_FIXTURE_PACKETS.length === 9, 'fixture count');
  for (const screenId of OPERATOR_UI_SCREEN_IDS) {
    assert(html.includes(`href="#${screenId}"`), `nav has ${screenId}`);
    assert(html.includes(`id="${screenId}"`), `panel has ${screenId}`);
  }
  for (const label of [
    'Overview',
    'Catalog Authority',
    'Privacy Crypto-Shredding',
    'Key Custodian O4 Status',
    'Reconciler',
    'Backup Restore',
    'Provider Availability Packets',
    'Audit Queue',
    'Settings Operator Configuration',
  ]) assert(html.includes(label), `screen label ${label}`);
});

test('visual tokens and read-only appliance labels are present', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  for (const token of [
    '#111214',
    '#1A1B1E',
    '#232428',
    '#303238',
    '#D18A3A',
    '#7E9B75',
    '#C09A4A',
    '#B96A64',
    '#7D91A8',
    'border-radius:8px',
    'border-radius:6px',
    'Fixture Only',
    'Read Only',
    'Static Fixture Console',
    'Sanitized Activity',
    'O4 O5 Deferred',
  ]) assert(html.includes(token), `html includes ${token}`);
});

test('output is generated from Phase 62 fixture packets', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  assert(renderOperatorUiStaticPrototypeHtml.length === 0, 'renderer has no public packet parameter');
  for (const packet of OPERATOR_UI_FIXTURE_PACKETS) {
    assert(html.includes(packet.screenId), `screen id ${packet.screenId}`);
    assert(html.includes(packet.screenLabel), `screen label ${packet.screenLabel}`);
    for (const row of packet.rows) {
      for (const cell of row.cells) {
        assert(html.includes(cell.label), `field label ${cell.label}`);
        if (cell.statusLabel !== undefined) assert(html.includes(cell.statusLabel), `status ${cell.statusLabel}`);
        if (cell.categoryLabel !== undefined) assert(html.includes(cell.categoryLabel), `category ${cell.categoryLabel}`);
      }
    }
  }

  for (const label of OPERATOR_UI_DISPLAY_FIELD_LABELS) assert(html.includes(label), `field allowlist label ${label}`);
  for (const label of ['Verified', 'Warning', 'Synced', 'Count Only', 'Advisory', 'Reference Harness', 'Not Production KMS']) {
    assert(html.includes(label), `status label ${label}`);
  }
  for (const label of OPERATOR_UI_CATEGORY_LABELS) assert(html.includes(label), `category label ${label}`);
  for (const label of OPERATOR_UI_STATUS_LABELS) assert(source.includes(label) || html.includes(label), `status covered ${label}`);
});

test('renderer ignores hostile caller-provided packet objects', () => {
  const hostile = [{
    screenId: 'overview',
    screenLabel: 'Provider Availability',
    descriptor: {
      screenId: 'overview',
      fields: [{ label: 'Private Movie Title', statusLabel: 'Verified', categoryLabel: 'Provider Availability' }],
    },
    rows: [{
      cells: [{
        label: 'Private Movie Title',
        statusLabel: 'Verified',
        categoryLabel: 'Provider Availability',
        providerRef: 'magnet:?xt=urn:btih:ABCDEF',
        token: 'SECRET_TOKEN_SENTINEL',
        url: 'https://provider.example.invalid/private',
      }],
    }],
  }];
  const html = (renderOperatorUiStaticPrototypeHtml as unknown as (packets: unknown) => string)(hostile);
  assert(html === renderOperatorUiStaticPrototypeHtml(), 'external packets do not affect output');
  for (const sentinel of [
    'Private Movie Title',
    'magnet:',
    'ABCDEF',
    'SECRET_TOKEN_SENTINEL',
    'provider.example.invalid',
    'providerRef',
  ]) assert(!html.includes(sentinel), `hostile caller value omitted: ${sentinel}`);
});

test('output omits unsafe identity, runtime, provider-control, and framework terms', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  for (const forbidden of [
    'Private Movie',
    'Episode',
    'externalId',
    'providerRef',
    'infohash',
    'magnet',
    'credential',
    'token=',
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
    'user library',
    'media identity',
    'playback',
    'download',
    'stream',
    'NODE-001',
    'Admin',
    'System_Daemon',
    'React',
    'Vite',
    'Next',
    'Express',
    'process.env',
    'window.',
    'localStorage',
    'provider controls',
  ]) assert(!html.includes(forbidden), `html omits ${forbidden}`);
});

test('source has no frontend framework, DB, network, env, file, or provider adapter scope creep', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react']) {
    assert(!allDeps.includes(dep), `no frontend/API dependency ${dep}`);
  }
  assert(pkg.scripts['test:operator-ui-static-prototype'] === 'tsx test/operator-ui-static-prototype.ts', 'test script');
  assert(pkg.scripts['ops:operator-ui-static-prototype'] === 'tsx src/ops/operator-ui-static-prototype-cli.ts', 'ops script');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-fixtures.ts && tsx test/operator-ui-static-prototype.ts'), 'suite follows Phase 62');

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
    'playback',
    'download',
  ]) assert(!`${source}\n${cliSource}`.includes(forbidden), `source excludes ${forbidden}`);
});

test('CLI emits deterministic HTML and ignores hostile environment values', () => {
  const env = {
    ...process.env,
    TOKEN: 'SECRET_TOKEN_SENTINEL',
    PRIVATE_TITLE: 'Private Movie Sentinel',
    DATABASE_URL: 'postgres://user:pass@example.invalid/db',
  };
  const first = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-static-prototype-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const second = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-static-prototype-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(first === second, 'CLI stable');
  assert(first.trim() === renderOperatorUiStaticPrototypeHtml(), 'CLI prints renderer output');
  for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
    assert(!first.includes(sentinel), `CLI output omits hostile env ${sentinel}`);
  }
});

test('docs and deploy guard mention Phase 63 boundaries', () => {
  const combined = `${read('docs/PHASE_63_STATIC_OPERATOR_UI_PROTOTYPE.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 63',
    'read-only static operator UI prototype',
    'Phase 62 fixture packets only',
    'Graphite + Muted Orange',
    'no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database read, provider adapter, network call, env read, file read, browser storage, external asset, remote font, provider control, playback, download, or streaming behavior',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Phase 64',
  ]) assert(combined.includes(kw), `docs/deploy include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
