import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const exists = (rel: string): boolean => existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));
const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');

function walkTs(relDir: string): Array<[string, string]> {
  const abs = fileURLToPath(new URL(`../${relDir}`, import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  return walk(abs).map((path) => [path.replace(/\\/g, '/').replace(repoRoot, ''), readFileSync(path, 'utf8')]);
}

function assertIncludes(blob: string, terms: string[], label: string): void {
  for (const term of terms) assert(blob.includes(term), `${label} includes ${term}`);
}

console.log('Running Phase 35 TorBox smoke evidence/static UI-readiness suite:\n');

const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

test('Phase 35 evidence doc, template, and UI examples exist and are wired', () => {
  assert(exists('docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md'), 'Phase 35 smoke evidence doc exists');
  assert(exists('docs/templates/TORBOX_SMOKE_EVIDENCE.md'), 'TorBox smoke evidence template exists');
  assert(exists('docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md'), 'future UI examples doc exists');
  assertEq(pkg.scripts['test:torbox-smoke-evidence'], 'tsx test/torbox-smoke-evidence.ts', 'focused script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-smoke-evidence.ts'), 'suite is in npm test chain');
});

test('Phase 35 docs preserve no-live, no-SDK, no-transport, and no-provider-mode boundaries', () => {
  const combined = [
    read('docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md'),
    read('docs/templates/TORBOX_SMOKE_EVIDENCE.md'),
    read('docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md'),
    read('README.md'),
    read('docs/PHASE_33_TORBOX_REAL_CLIENT_GATE.md'),
    read('docs/PHASE_34_TORBOX_READONLY_FIXTURE.md'),
  ].join('\n');

  assertIncludes(combined, [
    'operator-run smoke design and evidence shape only',
    'not a live TorBox transport',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no DB writes',
    'no ADAPTER_MODE wiring',
    'no adapter-factory mode for TorBox',
  ], 'Phase 35 boundary docs');
  assert(/Real transport and live smoke remain a future separately authorized and\s+reviewed phase/.test(combined), 'live transport/smoke remains future authorized work');

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  const factory = read('src/core/adapters/adapter-factory.ts');
  assert(factory.includes("'torbox-readonly'"), 'TorBox read-only factory mode is explicit');
  assert(/requires explicit injected transport/i.test(factory), 'env-only TorBox mode fails closed');
  assert(!factory.includes('createTorBoxLiveTransport'), 'factory does not construct live transport');
});

test('Phase 35 docs forbid download, playback, UI runtime, provider writes, and sensitive retention', () => {
  const doc = read('docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md');
  const tpl = read('docs/templates/TORBOX_SMOKE_EVIDENCE.md');
  const ui = read('docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md');
  const combined = `${doc}\n${tpl}\n${ui}`;

  assertIncludes(combined, [
    'no frontend code',
    'no UI runtime',
    'no UI build tooling',
    'no HTTP service',
    'no browser automation',
    'no create-download',
    'request-download-link',
    'request-permalink',
    'user list',
    'user data',
    'control',
    'delete',
    'export',
    'CDN',
    'permalink',
    'playback',
    'downloading',
    'provider payload persistence',
  ], 'forbidden operation docs');

  for (const redacted of ['tokens', 'raw refs', 'raw response bodies', 'provider payloads', 'titles', 'item ids', 'CDN URLs', 'permalink URLs']) {
    assert(doc.includes(redacted), `redaction rule covers ${redacted}`);
  }
  assert(/fixed summary statuses[\s\S]*counts[\s\S]*operation names[\s\S]*fail-closed\s+categories/i.test(doc), 'evidence retention is summary-only');
});

test('allowed future smoke probes are read-only and scoped', () => {
  const doc = read('docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md');
  assertIncludes(doc, [
    'Service status',
    'Hoster metadata',
    'Cache availability',
    'one scoped ref at a time',
    'aggregate hit/miss/unknown counts only',
  ], 'allowed probes');
  assert(/download links[\s\S]*create\/download workflows[\s\S]*request-download-link[\s\S]*request-permalink[\s\S]*user list[\s\S]*control[\s\S]*delete[\s\S]*export[\s\S]*CDN[\s\S]*permalink[\s\S]*playback/i.test(doc), 'forbidden probes stay outside future smoke');
});

test('template is redaction-safe and does not request forbidden sensitive fields', () => {
  const tpl = read('docs/templates/TORBOX_SMOKE_EVIDENCE.md');
  assertIncludes(tpl, [
    'Catalog Authority commit or build id',
    'Smoke mode confirmed read-only',
    'Explicit Gates Checked',
    'Probe Summary',
    'Failure Categories',
    'Redaction Review Checklist',
    'Operator / Reviewer Signoff',
  ], 'template fields');

  for (const forbiddenField of [
    'Token',
    'API key',
    'Bearer',
    'Cookie',
    'Credential',
    'Secret value',
    'Secret file path',
    'Raw URL',
    'Raw ref',
    'Infohash',
    'Digest',
    'Provider payload',
    'Response body',
    'Title',
    'Year',
    'Metadata',
    'Item id',
    'CDN URL',
    'Permalink',
  ]) {
    assert(!new RegExp(`^- ${forbiddenField}:`, 'mi').test(tpl), `template does not request ${forbiddenField}`);
    assert(!new RegExp(`\\|\\s*${forbiddenField}\\s*\\|`, 'i').test(tpl), `template has no ${forbiddenField} table field`);
  }
  assert(/No tokens[\s\S]*No credential-bearing URLs[\s\S]*No raw refs[\s\S]*No raw response bodies[\s\S]*No catalog titles/i.test(tpl), 'template redaction checklist is explicit');
});

test('UI examples are present, non-runtime, non-AI-looking, and operator-dashboard oriented', () => {
  const ui = read('docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md');
  assertIncludes(ui, [
    'Phase 35 adds no frontend code',
    'no UI runtime',
    'quiet utilitarian operations UI',
    'dense tables',
    'restrained colors',
    '8px-or-less radius',
    'should not look like an AI-generated dashboard',
    'no hero section',
    'orbs',
    'Readiness Gates',
    'TorBox Smoke',
    'Catalog Privacy',
    'Provider Availability',
    'no playback, download, request-link, create, export, or library-management buttons yet',
  ], 'UI examples');
  assert(/documentation examples\s+only/.test(ui), 'UI examples are documentation only');
  assert(/decorative\s+gradients/.test(ui), 'UI examples forbid decorative gradients');
  assert(/O4\s+Open[\s\S]*O5\s+Open/i.test(ui), 'readiness screen shows O4/O5 open');
  assert(/Counts and fixed categories only[\s\S]*No raw refs, tokens, URLs, response bodies, titles, item ids, CDN URLs, or permalink URLs/i.test(ui), 'TorBox screen is redacted');
});

test('O4/O5 remain open/deferred and FileCustodian boundary is preserved', () => {
  const combined = [
    read('docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md'),
    read('docs/templates/TORBOX_SMOKE_EVIDENCE.md'),
    read('docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md'),
    read('README.md'),
  ].join('\n');
  assert(/O4[\s\S]{0,80}open\/deferred/i.test(combined), 'O4 remains open/deferred');
  assert(/O5[\s\S]{0,80}open\/deferred/i.test(combined), 'O5 remains open/deferred');
  assert(/FileCustodian[\s\S]{0,120}hardened reference harness, not production KMS/i.test(combined), 'FileCustodian boundary preserved');
});

test('Phase 35 adds no production runtime module or transport implementation', () => {
  for (const forbiddenPath of [
    'src/core/adapters/torbox-smoke-evidence.ts',
    'src/core/adapters/torbox-smoke-transport.ts',
    'src/core/adapters/torbox-live-transport.ts',
    'src/core/adapters/torbox-ui.ts',
  ]) assert(!exists(forbiddenPath), `${forbiddenPath} does not exist`);
  assert(exists('src/ops/torbox-smoke-cli.ts'), 'Phase 37 may add the refused-by-default smoke CLI shell');

  for (const [path, source] of walkTs('src')) {
    if (/src\/core\/adapters\/(torbox-boundary|fake-torbox-adapter|torbox-real-client-gate|torbox-readonly-client)\.ts$/.test(path)) continue;
    if (/src\/ops\/torbox-smoke-(shell|cli)\.ts$/.test(path)) continue;
    if (/src\/ops\/torbox-transport-acceptance\.ts$/.test(path)) continue;
    if (/src\/ops\/torbox-smoke-readiness-preflight(-cli)?\.ts$/.test(path)) continue;
    if (/src\/ops\/torbox-live-smoke-labels\.ts$/.test(path)) continue;
    if (/src\/ops\/torbox-live-(transport|smoke-runner)\.ts$/.test(path)) continue;
    if (/src\/ops\/torbox-live-smoke-evidence-preflight(-cli)?\.ts$/.test(path)) continue;
    if (/src\/ops\/torbox-live-smoke-plan(-cli)?\.ts$/.test(path)) continue;
    assert(!/phase\s*35|torbox-smoke|TorBoxSmoke|smoke evidence/i.test(source), `${path} has no Phase 35 runtime code`);
  }
});

test('repository still has no new TorBox SDK, network, browser, Docker, provider-write, or UI runtime creep', () => {
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const banned of [
    '@torbox/torbox-api',
    'node-fetch',
    'undici',
    'axios',
    'got',
    'puppeteer',
    'playwright',
    'vite',
    'react',
    'vue',
    'svelte',
    'next',
  ]) assert(!allDeps.includes(banned), `no ${banned} dependency`);

  const production = walkTs('src')
    .filter(([path]) => /src\/core\/adapters\/(torbox-boundary|fake-torbox-adapter|torbox-real-client-gate|torbox-readonly-client)\.ts$/.test(path))
    .map(([path, source]) => `${path}\n${source}`)
    .join('\n');
  for (const forbidden of [
    "from '@torbox/torbox-api'",
    'from "@torbox/torbox-api"',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'window.fetch',
    'createTorBoxTransport',
    'TorBoxLiveTransport',
    'torbox-smoke',
  ]) assert(!production.includes(forbidden), `production source excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
