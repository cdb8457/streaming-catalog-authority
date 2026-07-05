import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_UI_CATEGORY_LABELS,
  OPERATOR_UI_DISPLAY_FIELD_LABELS,
  OPERATOR_UI_SCREEN_IDS,
  OPERATOR_UI_STATUS_LABELS,
} from '../src/ops/operator-ui-packet-contract.js';
import {
  extractOperatorUiRenderedTextSegments,
  inspectOperatorUiRenderedHtml,
  OPERATOR_UI_RENDER_ALLOWED_TEXT,
  OPERATOR_UI_RENDER_SCREEN_TITLES,
  OPERATOR_UI_RENDER_STATIC_CHROME_TEXT,
} from '../src/ops/operator-ui-render-allowlist.js';
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

console.log('Running Phase 64 operator UI render allowlist suite:\n');

test('current Phase 63 static HTML passes render allowlist inspection', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  const report = inspectOperatorUiRenderedHtml(html);
  assert(report.ok, 'render accepted');
  assert(report.code === 'OPERATOR_UI_RENDER_ACCEPTED', 'accepted code');
  assert(report.message === 'Operator UI render is static and allowlist-compliant.', 'fixed accepted message');
  assert(report.visibleTextCount > 0, 'counts visible text');
  assert(report.cssTokenCount >= 10, 'counts fixed CSS tokens');
});

test('every rendered text segment comes from Phase 61/62 allowlists or fixed safe chrome', () => {
  const allowed = new Set<string>([
    ...OPERATOR_UI_SCREEN_IDS,
    ...OPERATOR_UI_DISPLAY_FIELD_LABELS,
    ...OPERATOR_UI_STATUS_LABELS,
    ...OPERATOR_UI_CATEGORY_LABELS,
    ...OPERATOR_UI_RENDER_SCREEN_TITLES,
    ...OPERATOR_UI_RENDER_STATIC_CHROME_TEXT,
  ]);
  assert(JSON.stringify([...allowed].sort()) === JSON.stringify([...new Set(OPERATOR_UI_RENDER_ALLOWED_TEXT)].sort()), 'exported allowlist matches expected sources');

  for (const segment of extractOperatorUiRenderedTextSegments(renderOperatorUiStaticPrototypeHtml())) {
    assert(allowed.has(segment), `rendered segment is allowlisted: ${segment}`);
  }
});

test('unsafe identity, provider, secret, path, asset, raw, and control text fails closed', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  for (const sentinel of [
    'Private Movie Title',
    'Episode S01E01',
    'externalId tmdb-603',
    'providerRef abc123',
    'Real-Debrid',
    'TorBox logo',
    'infohash ABCDEF012345',
    'magnet:?xt=urn:btih:ABCDEF',
    'credential value',
    'token SECRET_TOKEN_SENTINEL',
    'secret bearer',
    'C:\\private\\media',
    '/mnt/user/media/private-title',
    'https://provider.example.invalid/private',
    'poster artwork',
    'rawLog payload',
    'rawPayload body',
    'user library item',
    'media identity',
    'playback control',
    'download action',
    'stream provider control',
  ]) {
    const report = inspectOperatorUiRenderedHtml(html.replace('</main>', `<p>${sentinel}</p></main>`));
    const json = JSON.stringify(report);
    assert(!report.ok, `rejected ${sentinel}`);
    assert(json.includes('OPERATOR_UI_RENDER_FORBIDDEN_TEXT'), `fixed forbidden text code for ${sentinel}`);
    assert(!json.includes(sentinel), `report omits unsafe value ${sentinel}`);
  }
});

test('forbidden interactive or external markup is rejected inside inspection scope', () => {
  const html = renderOperatorUiStaticPrototypeHtml();
  for (const mutation of [
    '<script>window.alert("x")</script>',
    '<link rel="stylesheet" href="https://cdn.example.invalid/app.css">',
    '<img src="poster.jpg" alt="Poster">',
    '<iframe src="about:blank"></iframe>',
    '<form><input name="token" value="secret"></form>',
    '<button>Download</button>',
    '<a href="https://provider.example.invalid/private">Provider</a>',
    '<a href=https://evil.example>Overview</a>',
    '<img src=//cdn.example.invalid/logo.png alt="Provider">',
    '<img src="//cdn.example.invalid/logo.png" alt="Provider">',
    '<img src="data:image/png;base64,AAAA" alt="Provider">',
    '<style>@import url("https://evil.example/app.css");</style>',
    '<style>.x{background:url(//evil.example/p.png)}</style>',
    '<style>.x{background:url(data:image/png;base64,AAAA)}</style>',
    '<main onclick="fetch(`https://evil.example`)">',
    '<main style="background:url(https://evil.example/p.png)">',
  ]) {
    const report = inspectOperatorUiRenderedHtml(html.replace('</body>', `${mutation}</body>`));
    const json = JSON.stringify(report);
    assert(!report.ok, `rejected mutation ${mutation.slice(0, 20)}`);
    assert(
      json.includes('OPERATOR_UI_RENDER_FORBIDDEN_MARKUP')
      || json.includes('OPERATOR_UI_RENDER_FORBIDDEN_EXTERNAL_REFERENCE')
      || json.includes('OPERATOR_UI_RENDER_FORBIDDEN_TEXT'),
      'fixed rejection code present',
    );
    for (const raw of ['provider.example.invalid', 'cdn.example.invalid', 'evil.example', 'secret', 'base64,AAAA']) {
      assert(!json.includes(raw), `report omits raw mutation detail ${raw}`);
    }
  }
});

test('inspection report is deterministic and redaction-safe', () => {
  const hostile = renderOperatorUiStaticPrototypeHtml().replace(
    '</main>',
    '<p>Private Movie Title SECRET_TOKEN_SENTINEL magnet:?xt=urn:btih:ABCDEF</p><script src="https://example.invalid/app.js"></script></main>',
  );
  const first = inspectOperatorUiRenderedHtml(hostile);
  const second = inspectOperatorUiRenderedHtml(`${hostile}`);
  const json = JSON.stringify(first);
  assert(JSON.stringify(first) === JSON.stringify(second), 'deterministic report');
  assert(!first.ok, 'hostile render rejected');
  for (const sentinel of [
    'Private Movie',
    'SECRET_TOKEN_SENTINEL',
    'magnet:',
    'ABCDEF',
    'example.invalid',
    'app.js',
  ]) assert(!json.includes(sentinel), `report omits ${sentinel}`);
});

test('helper and static renderer sources have no frontend/API/runtime/DB/provider/network/env/file-read scope creep', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
    assert(!allDeps.includes(dep), `no render/API dependency ${dep}`);
  }
  assert(pkg.scripts['test:operator-ui-render-allowlist'] === 'tsx test/operator-ui-render-allowlist.ts', 'test script');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-static-prototype.ts && tsx test/operator-ui-render-allowlist.ts'), 'suite follows Phase 63');

  const source = [
    read('src/ops/operator-ui-render-allowlist.ts'),
    read('src/ops/operator-ui-static-prototype.ts'),
    read('src/ops/operator-ui-static-prototype-cli.ts'),
  ].join('\n');
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
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
});

test('docs and deploy guard mention Phase 64 render hardening boundaries', () => {
  const combined = `${read('docs/PHASE_64_RENDER_ALLOWLIST_HARDENING.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 64',
    'static render allowlist',
    'Phase 61/62 allowlists',
    'fixed safe chrome',
    'OPERATOR_UI_RENDER_FORBIDDEN_TEXT',
    'OPERATOR_UI_RENDER_FORBIDDEN_MARKUP',
    'OPERATOR_UI_RENDER_FORBIDDEN_EXTERNAL_REFERENCE',
    'no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database read, provider adapter, network call, env read, file read, browser JavaScript, browser storage, external asset, remote font, provider control, playback, download, or streaming behavior',
    'Provider availability remains advisory/count-only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Phase 65',
  ]) assert(combined.includes(kw), `Phase 64 docs/deploy include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
