import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiLaunchReadinessReport,
  formatOperatorUiLaunchReadinessText,
  type OperatorUiLaunchReadinessReport,
} from '../src/ops/operator-ui-launch-readiness.js';

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
const source = read('src/ops/operator-ui-launch-readiness.ts');
const cliSource = read('src/ops/operator-ui-launch-readiness-cli.ts');

console.log('Running Phase 67 operator UI launch readiness suite:\n');

test('readiness report is fixed, synthetic, and deterministic', () => {
  const first = buildOperatorUiLaunchReadinessReport();
  const second = buildOperatorUiLaunchReadinessReport();
  assert(JSON.stringify(first) === JSON.stringify(second), 'report is deterministic');
  assert(first.ok, 'report generated');
  assert(first.code === 'OPERATOR_UI_LAUNCH_READINESS_REPORTED', 'fixed code');
  assert(first.source === 'fixed-synthetic-readiness', 'fixed synthetic source');
  assert(first.message === 'Operator UI launch readiness is fixed, synthetic, and redaction-safe.', 'fixed message');
});

test('static preview is ready while local read-only and live product are blocked', () => {
  const byId = new Map(buildOperatorUiLaunchReadinessReport().surfaces.map((surface) => [surface.id, surface]));
  assert(byId.get('static-preview')?.readiness === 'ready', 'static preview ready');
  assert(byId.get('local-readonly-ui')?.readiness === 'blocked/deferred', 'local read-only blocked/deferred');
  assert(byId.get('live-product')?.readiness === 'not-ready', 'live product not ready');
  assert(byId.get('static-preview')?.summary.includes('fixture-only static artifact'), 'static preview summary is scoped');
  assert(byId.get('local-readonly-ui')?.summary.includes('explicitly authorizes'), 'local read-only requires future authorization');
  assert(byId.get('live-product')?.summary.includes('security/runtime/production gates'), 'live product requires gates');
});

test('O4/O5 and FileCustodian reference boundary remain visible', () => {
  const report = buildOperatorUiLaunchReadinessReport();
  const json = JSON.stringify(report);
  for (const required of [
    'O4 production custodian is open/deferred',
    'O5 managed KEK custody/scheduling is open/deferred',
    'FileCustodian is reference harness only',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(json.includes(required), `report includes ${required}`);
});

test('required static and launch blockers remain visible', () => {
  const json = JSON.stringify(buildOperatorUiLaunchReadinessReport());
  for (const required of [
    'Live UI/API/runtime is not implemented or authorized',
    'Sanitized local packet source is not implemented',
    'Auth/access boundary is not implemented',
    'Phase 64 render allowlist and Phase 65 artifact packaging are required for static artifact preview',
    'Provider availability remains packet/count/advisory only',
    'No real titles, external IDs, provider names/logos, infohashes, magnets, credentials, user library data, poster art, or streaming artwork are displayed',
    'Local/live product launch is blocked',
  ]) assert(json.includes(required), `report includes ${required}`);
});

test('text output is deterministic, parseable, and states launch decision', () => {
  const first = formatOperatorUiLaunchReadinessText();
  const second = formatOperatorUiLaunchReadinessText();
  assert(first === second, 'text is deterministic');
  for (const line of [
    'Operator UI Launch Readiness',
    '- static-preview: ready',
    '- local-readonly-ui: blocked/deferred',
    '- live-product: not-ready',
    '- static-preview: fixture-only static preview can be generated/shared after Phase 64 and Phase 65 gates pass',
    '- local-readonly-ui: blocked/deferred pending explicit future authorization and design',
    '- live-product: not-ready pending security, runtime, access, custody, and production gates',
  ]) assert(first.includes(line), `text includes ${line}`);
  assert(first.endsWith('\n'), 'text ends with newline');
});

test('--json CLI output is parseable and redaction-safe', () => {
  const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-launch-readiness-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: 'SECRET_TOKEN_SENTINEL',
      PRIVATE_TITLE: 'Private Movie Sentinel',
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output) as OperatorUiLaunchReadinessReport;
  assert(parsed.code === 'OPERATOR_UI_LAUNCH_READINESS_REPORTED', 'json code');
  assert(parsed.surfaces.some((surface) => surface.id === 'static-preview' && surface.readiness === 'ready'), 'json static ready');
  assert(parsed.surfaces.some((surface) => surface.id === 'live-product' && surface.readiness === 'not-ready'), 'json live not ready');
  for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
    assert(!output.includes(sentinel), `json omits hostile env ${sentinel}`);
  }
});

test('text CLI output is parseable and deterministic', () => {
  const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-launch-readiness-cli.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert(output === formatOperatorUiLaunchReadinessText(), 'CLI prints formatter output');
  assert(output.includes('- static-preview: ready'), 'CLI text includes static ready');
  assert(output.includes('- local-readonly-ui: blocked/deferred'), 'CLI text includes local blocked');
  assert(output.includes('- live-product: not-ready'), 'CLI text includes live not ready');
});

test('helper and CLI source has no runtime UI/API/network/DB/env/file/provider execution scope', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
    assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
  }
  assert(pkg.scripts['test:operator-ui-launch-readiness'] === 'tsx test/operator-ui-launch-readiness.ts', 'test script');
  assert(pkg.scripts['ops:operator-ui-launch-readiness'] === 'tsx src/ops/operator-ui-launch-readiness-cli.ts', 'ops script');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-static-layout.ts && tsx test/operator-ui-launch-readiness.ts'),
    'suite follows Phase 66',
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

test('docs, README, and deploy guard mention Phase 67 launch readiness', () => {
  const combined = `${read('docs/PHASE_67_OPERATOR_UI_LAUNCH_READINESS.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
  for (const kw of [
    'Phase 67',
    'Operator UI Launch Readiness Gate',
    'operator UI launch readiness',
    'ops:operator-ui-launch-readiness',
    'test:operator-ui-launch-readiness',
    'static-preview',
    'local-readonly-ui',
    'live-product',
    'ready',
    'blocked/deferred',
    'not-ready',
    'fixture-only static preview can be generated/shared',
    'local read-only UI is blocked/deferred',
    'live product launch is not ready',
    'Live UI/API/runtime is not implemented or authorized',
    'Sanitized local packet source is not implemented',
    'Auth/access boundary is not implemented',
    'Phase 64 render allowlist and Phase 65 artifact packaging',
    'Provider availability remains packet/count/advisory only',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
  ]) assert(combined.includes(kw), `Phase 67 docs/deploy include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
