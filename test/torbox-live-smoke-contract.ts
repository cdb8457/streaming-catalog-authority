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

console.log('Running Phase 36 TorBox live smoke acceptance contract suite:\n');

const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

test('Phase 36 contract exists and is wired into deterministic tests', () => {
  assert(exists('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md'), 'Phase 36 contract doc exists');
  assertEq(pkg.scripts['test:torbox-live-smoke-contract'], 'tsx test/torbox-live-smoke-contract.ts', 'focused script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-contract.ts'), 'suite is in npm test chain');
});

test('Phase 36 preserves non-live scope and forbids runtime implementation', () => {
  const combined = [
    read('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md'),
    read('docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md'),
    read('README.md'),
  ].join('\n');

  assertIncludes(combined, [
    'not a live transport',
    'not an operator command',
    'not an SDK integration',
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no operator smoke CLI',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'no environment-variable reads',
    'no ADAPTER_MODE wiring',
    'no adapter-factory mode for TorBox',
  ], 'Phase 36 non-live boundary');

  for (const forbiddenPath of [
    'src/ops/torbox-smoke-cli.ts',
    'src/ops/torbox-readonly-smoke-cli.ts',
    'src/core/adapters/torbox-live-transport.ts',
    'src/core/adapters/torbox-smoke-transport.ts',
    'src/core/adapters/torbox-sdk-transport.ts',
  ]) assert(!exists(forbiddenPath), `${forbiddenPath} does not exist`);
});

test('required future execution order is explicit and fail-closed before network contact', () => {
  const doc = read('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md');
  const expectedOrder = [
    'Confirm explicit operator authorization for live TorBox smoke.',
    'Confirm the command is opt-in and out of CI.',
    'Confirm read-only mode.',
    'Confirm secret indirection is configured without printing the secret value or secret file path.',
    'Confirm the probe set is limited to service status, hoster metadata, and one scoped cache',
    'Confirm bounded per-probe timeout and total run timeout.',
    'Confirm redaction mode is active.',
    'Execute read-only probes through an injected reviewed transport only.',
    'Emit only the Phase 35 evidence shape',
    'Require operator/reviewer redaction signoff before the artifact is shared.',
  ];
  let last = -1;
  for (const step of expectedOrder) {
    const index = doc.indexOf(step);
    assert(index > last, `execution order includes ${step}`);
    last = index;
  }
  assert(/fail closed before contacting TorBox/i.test(doc), 'preflight failure is before TorBox contact');
  assert(/No future command may reorder these checks/i.test(doc), 'order cannot be bypassed');
});

test('future CLI contract is opt-in, out of CI, read-only, and detached from adapter mode', () => {
  const doc = read('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md');
  assertIncludes(doc, [
    'smoke:torbox-readonly',
    'absent from `npm run test` and `npm run ci`',
    'operator-run only',
    'disabled unless a live-smoke flag and a read-only flag are both present',
    'unable to infer enablement from `ADAPTER_MODE`',
    'unable to run from default config',
    'unable to write to the database or event log',
  ], 'future CLI contract');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'future smoke command is not in deterministic test chain');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'future smoke command is not in ci');
});

test('allowed future probes remain read-only and evidence remains aggregate', () => {
  const doc = read('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md');
  assertIncludes(doc, [
    'service status',
    'hoster metadata',
    'cache availability',
    'one scoped ref at a time',
    'aggregate hit/miss/unknown counts',
    'must not retain or display the raw scoped ref',
  ], 'allowed future probes');
});

test('forbidden provider operations and sensitive outputs stay blocked', () => {
  const doc = read('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md');
  assertIncludes(doc, [
    'create-download',
    'request-download-link',
    'request-permalink',
    'user list',
    'user data',
    'control',
    'delete',
    'export',
    'CDN',
    'permalink URL',
    'playback',
    'downloading',
    'tokens',
    'credential-bearing URLs',
    'raw refs',
    'raw response bodies',
    'provider payloads',
    'titles',
    'item ids',
  ], 'forbidden operations and outputs');
});

test('mandatory failure categories are fixed and provider strings are not passed through', () => {
  const doc = read('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md');
  for (const category of [
    'auth',
    'quota',
    'timeout',
    'transport',
    'parse',
    'unsupported-ref',
    'empty-ref',
    'ambiguous-response',
    'policy-block',
    'redaction-block',
    'not-authorized',
    'not-read-only',
  ]) assert(doc.includes(`\`${category}\``), `failure category ${category} is required`);
  assert(/must not pass through provider messages/i.test(doc), 'provider messages are not passed through');
  assert(/Provider strings[\s\S]*response\s+snippets[\s\S]*endpoint URLs[\s\S]*account labels[\s\S]*SDK diagnostics must not appear/i.test(doc), 'provider diagnostics are redacted');
});

test('reviewer checklist requires security review before any later live smoke merge', () => {
  const doc = read('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md');
  assertIncludes(doc, [
    'Reviewer must confirm',
    'cannot run from CI or the default test chain',
    'cannot run without explicit live-smoke and read-only acknowledgement',
    'no `ADAPTER_MODE` wiring enables TorBox',
    'no create/download/request-link/permalink/CDN/user/control/delete/export operations exist',
    'redaction tests cover provider errors, parse errors, timeout errors, and hostile input values',
    'evidence maps to `docs/templates/TORBOX_SMOKE_EVIDENCE.md`',
    'no DB writes or event-log writes',
  ], 'reviewer checklist');
});

test('O4/O5 and FileCustodian boundaries remain visible', () => {
  const combined = [
    read('docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md'),
    read('README.md'),
  ].join('\n');
  assert(/O4 remains open\/deferred/i.test(combined), 'O4 remains open/deferred');
  assert(/O5 remains open\/deferred/i.test(combined), 'O5 remains open/deferred');
  assert(/FileCustodian`? remains a hardened reference harness, not production KMS/i.test(combined), 'FileCustodian boundary remains visible');
});

test('repository still has no TorBox SDK, live network, browser, Docker, provider-write, or UI runtime creep', () => {
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

  const factory = read('src/core/adapters/adapter-factory.ts');
  assert(!/torbox/i.test(factory), 'TorBox remains absent from adapter factory');

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
    'smoke:torbox-readonly',
  ]) assert(!production.includes(forbidden), `production source excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
