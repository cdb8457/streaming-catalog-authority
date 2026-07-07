import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiRuntimeBoundaryReport,
  formatOperatorUiRuntimeBoundaryText,
  type OperatorUiRuntimeBoundaryReport,
} from '../src/ops/operator-ui-runtime-boundary.js';

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
const source = read('src/ops/operator-ui-runtime-boundary.ts');
const cliSource = read('src/ops/operator-ui-runtime-boundary-cli.ts');
const documentedNpmJsonCommand = 'npm run --silent ops:operator-ui-runtime-boundary -- -- --json';

console.log('Running Phase 68 operator UI runtime boundary suite:\n');

test('runtime boundary report is fixed, synthetic, no-input, and deterministic', () => {
  const first = buildOperatorUiRuntimeBoundaryReport();
  const second = buildOperatorUiRuntimeBoundaryReport();
  assert(JSON.stringify(first) === JSON.stringify(second), 'report is deterministic');
  assert(first.ok, 'report ok');
  assert(first.code === 'OPERATOR_UI_RUNTIME_BOUNDARY_REPORTED', 'fixed code');
  assert(first.source === 'fixed-synthetic-runtime-boundary', 'fixed synthetic source');
  assert(first.message === 'Operator UI runtime boundary is fixed, synthetic, and no-input.', 'fixed message');
});

test('static preview is the only ready surface while local runtime and live product stay blocked', () => {
  const byId = new Map(buildOperatorUiRuntimeBoundaryReport().surfaces.map((surface) => [surface.id, surface]));
  assert(byId.get('static-preview')?.status === 'ready', 'static preview ready');
  assert(byId.get('local-readonly-runtime')?.status === 'blocked/deferred', 'local runtime blocked/deferred');
  assert(byId.get('live-product')?.status === 'not-ready', 'live product not ready');
  assert(byId.get('static-preview')?.summary.includes('only ready operator surface'), 'static-only summary');
  assert(byId.get('local-readonly-runtime')?.summary.includes('packet source, access, auth, and runtime designs'), 'local runtime blockers');
});

test('future runtime controls are explicit but not implemented', () => {
  const json = JSON.stringify(buildOperatorUiRuntimeBoundaryReport());
  for (const required of [
    'Future local-only bind/access posture is required; no bind/listener is implemented now.',
    'Operator access/auth boundary is required before any local runtime exists.',
    'Future UI may consume only a read-only packet endpoint/source; direct UI DB access is forbidden.',
    'Provider execution and media-control/retrieval controls are forbidden for this boundary.',
    'Static preview remains the only ready surface.',
    'Phase 69 packet source contract is satisfied',
  ]) assert(json.includes(required), `report includes ${required}`);
});

test('Phase 64/65/67, O4/O5, FileCustodian, and provider boundaries remain visible', () => {
  const json = JSON.stringify(buildOperatorUiRuntimeBoundaryReport());
  for (const required of [
    'Phase 64 render allowlist remains intact',
    'Phase 65 static artifact packaging remains intact',
    'Phase 67 launch readiness gate remains intact',
    'Provider availability remains packet/count/advisory only',
    'O4 production custodian is open/deferred',
    'O5 managed KEK custody/scheduling is open/deferred',
    'FileCustodian is reference harness only',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(json.includes(required), `report includes ${required}`);
});

test('text output is deterministic and parseable', () => {
  const first = formatOperatorUiRuntimeBoundaryText();
  const second = formatOperatorUiRuntimeBoundaryText();
  assert(first === second, 'text is deterministic');
  for (const line of [
    'Operator UI Runtime Boundary Plan',
    '- static-preview: ready',
    '- local-readonly-runtime: blocked/deferred',
    '- live-product: not-ready',
    '- local-bind-access-posture: required/not-implemented',
    '- operator-access-auth-boundary: required/not-implemented',
    '- packet-source-only: required/not-implemented',
  ]) assert(first.includes(line), `text includes ${line}`);
  assert(first.endsWith('\n'), 'text ends with newline');
});

test('--json CLI output is parseable and redaction-safe', () => {
  const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-runtime-boundary-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: 'SECRET_TOKEN_SENTINEL',
      PRIVATE_TITLE: 'Private Movie Sentinel',
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output) as OperatorUiRuntimeBoundaryReport;
  assert(parsed.code === 'OPERATOR_UI_RUNTIME_BOUNDARY_REPORTED', 'json code');
  assert(parsed.surfaces.some((surface) => surface.id === 'static-preview' && surface.status === 'ready'), 'json static ready');
  assert(parsed.surfaces.some((surface) => surface.id === 'live-product' && surface.status === 'not-ready'), 'json live not ready');
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
  const parsed = JSON.parse(output) as OperatorUiRuntimeBoundaryReport;
  assert(parsed.code === 'OPERATOR_UI_RUNTIME_BOUNDARY_REPORTED', 'documented npm json code');
  assert(parsed.requiredFutureControls.some((control) => control.id === 'packet-source-only'), 'documented npm json controls');
  for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
    assert(!output.includes(sentinel), `documented npm json omits hostile env ${sentinel}`);
  }
});

test('text CLI output is formatter output', () => {
  const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-runtime-boundary-cli.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert(output === formatOperatorUiRuntimeBoundaryText(), 'CLI prints formatter output');
  assert(output.includes('- local-readonly-runtime: blocked/deferred'), 'CLI text includes local blocked');
});

test('helper and CLI source has no runtime UI/API/network/DB/env/file/provider execution scope', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
    assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
  }
  assert(pkg.scripts['test:operator-ui-runtime-boundary'] === 'tsx test/operator-ui-runtime-boundary.ts', 'test script');
  assert(pkg.scripts['ops:operator-ui-runtime-boundary'] === 'tsx src/ops/operator-ui-runtime-boundary-cli.ts', 'ops script');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-preview-launch-packet.ts && tsx test/operator-ui-runtime-boundary.ts'),
    'suite follows Phase 97 preview launch packet',
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

test('docs, README, and deploy guard mention Phase 68 runtime boundary', () => {
  const combined = `${read('docs/PHASE_68_OPERATOR_UI_RUNTIME_BOUNDARY.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 68',
    'Local Operator UI Runtime Boundary Plan',
    'operator UI runtime boundary',
    'ops:operator-ui-runtime-boundary',
    'test:operator-ui-runtime-boundary',
    documentedNpmJsonCommand,
    'local-only bind/access posture',
    'operator access/auth boundary',
    'read-only packet endpoint/source',
    'no direct DB access from UI',
    'static preview remains the only ready surface',
    'local read-only runtime remains blocked',
    'Phase 69',
    'Provider availability remains packet/count/advisory only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 68 docs/deploy include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
