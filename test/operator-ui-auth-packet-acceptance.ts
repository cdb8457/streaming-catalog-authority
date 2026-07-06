import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiAuthPacketAcceptanceReport,
  evaluateOperatorUiAuthPacketAcceptanceStatus,
  formatOperatorUiAuthPacketAcceptanceText,
  type OperatorUiAuthPacketAcceptanceReport,
} from '../src/ops/operator-ui-auth-packet-acceptance.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push([name, err]);
    console.log(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

function assertRedactionSafe(output: string): void {
  for (const forbidden of [
    'phase82-',
    'phase82-query-',
    'phase-82-auth-acceptance-',
    'X-Operator-UI-Secret',
    'SECRET_HEADER_SENTINEL',
    'SECRET_QUERY_SENTINEL',
    'SECRET_BODY_SENTINEL',
    'SECRET_PATH_SENTINEL',
    'PRIVATE_TITLE_SENTINEL',
    'EXTERNAL_ID_SENTINEL',
    'RAW_REF_SENTINEL',
    'INFOHASH_SENTINEL',
    'MAGNET_SENTINEL',
    'DATABASE_URL_SENTINEL',
    'postgres://',
    '?secret=',
    'token=',
    'password=',
    'Authorization',
    'Set-Cookie',
    'Bearer',
    'Basic',
    'OAuth',
    'localStorage',
    'sessionStorage',
    '<!doctype',
    '<html',
    'operator-secret-input',
    'OPERATOR_UI_SANITIZED_PACKET_SNAPSHOT',
    '"packets"',
    '"screenId"',
    '"descriptor"',
    '"rows"',
    'System Health',
    'Catalog Authority',
    'Privacy Gate',
    'Provider Availability',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
  ]) {
    assert(!output.includes(forbidden), `output leaks forbidden evidence ${forbidden}`);
  }
}

function assertReportShape(report: OperatorUiAuthPacketAcceptanceReport): void {
  assert(report.ok === true, 'report ok marker');
  assert(report.reportName === 'operator-ui-auth-packet-acceptance', 'report name');
  assert(report.reportVersion === 'phase-82.v1', 'report version');
  assert(report.code === 'OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_REPORTED', 'report code');
  assert(report.status === 'accepted', 'all checks accepted');
  assert(report.runtimeMode === 'local-loopback-fixture-only', 'runtime mode');
  assert(report.auth === 'local-secret-file-enabled', 'auth label');
  assert(report.packetEndpoint === '/operator-ui/packets.json', 'packet endpoint label');
  assert(report.packetSource === 'synthetic-fixture-only', 'packet source');
  assert(report.packetCount === 9, 'packet count only');
  assert(report.screenCount === 9, 'screen count only');
  assert(report.checks.length === 13, 'fixed check count');
  for (const check of report.checks) assert(check.status === 'accepted', `${check.id} accepted`);
  for (const id of [
    'static-packet-endpoint-disabled',
    'manifest-auth-packet-source-sanitized',
    'missing-header-fixed-401',
    'wrong-header-fixed-401',
    'multiple-header-fixed-401',
    'correct-header-fixture-counts-only',
    'query-secret-fixed-404-before-auth',
    'query-bearing-target-fixed-404-before-auth',
    'head-fixed-405-empty-body',
    'non-get-fixed-405',
    'raw-target-bypass-fixed-404',
    'root-html-csp-hash-pinned-same-origin-connect',
    'auth-scheme-and-storage-patterns-absent',
  ]) assert(report.checks.some((check) => check.id === id), `includes ${id}`);
  for (const statusCode of [401, 404, 405]) {
    assert(report.checks.some((check) => check.statusCode === statusCode), `includes status ${statusCode}`);
  }
  for (const field of [
    'secret values',
    'secret file paths',
    'auth headers',
    'query strings',
    'packet contents',
    'artifact contents',
    'HTML contents',
  ]) assert(report.forbiddenEvidence.includes(field), `forbids ${field}`);
  for (const boundary of [
    'local loopback fixture runtime only',
    'no DB reads',
    'no provider or debrid integrations',
    'packet evidence is counts only from synthetic fixtures',
    'O4 and O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness only, not production KMS',
  ]) assert(report.boundaries.includes(boundary), `boundary ${boundary}`);
}

async function main(): Promise<void> {
  console.log('Running Phase 82 operator UI auth packet acceptance suite:\n');

  await test('acceptance harness reports accepted with counts only', async () => {
    const report = await buildOperatorUiAuthPacketAcceptanceReport();
    assertReportShape(report);
    assertRedactionSafe(JSON.stringify(report));
  });

  await test('text report is deterministic, status-rich, and redaction-safe', async () => {
    const report = await buildOperatorUiAuthPacketAcceptanceReport();
    const first = formatOperatorUiAuthPacketAcceptanceText(report);
    const second = formatOperatorUiAuthPacketAcceptanceText(report);
    assert(first === second, 'text is deterministic for the same report');
    for (const line of [
      'Operator UI Auth Packet Acceptance',
      'code: OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_REPORTED',
      'report: operator-ui-auth-packet-acceptance',
      'version: phase-82.v1',
      'status: accepted',
      'runtimeMode: local-loopback-fixture-only',
      'auth: local-secret-file-enabled',
      'packetEndpoint: /operator-ui/packets.json',
      'packetSource: synthetic-fixture-only',
      'packetCount: 9',
      'screenCount: 9',
      '- missing-header-fixed-401: accepted statusCode=401',
      '- query-secret-fixed-404-before-auth: accepted statusCode=404',
      '- head-fixed-405-empty-body: accepted statusCode=405',
      '- secret values',
      '- packet evidence is counts only from synthetic fixtures',
    ]) assert(first.includes(line), `text includes ${line}`);
    assert(first.endsWith('\n'), 'text ends with newline');
    assertRedactionSafe(first);
  });

  await test('CLI JSON output is parseable, accepted, and redaction-safe', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/operator-ui-auth-packet-acceptance-cli.ts', '--json'], {
      cwd: root,
      env: {
        ...process.env,
        SECRET_HEADER_SENTINEL: 'SECRET_HEADER_SENTINEL',
        SECRET_QUERY_SENTINEL: 'SECRET_QUERY_SENTINEL',
        SECRET_BODY_SENTINEL: 'SECRET_BODY_SENTINEL',
        SECRET_PATH_SENTINEL: 'SECRET_PATH_SENTINEL',
        DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
        PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
        RAW_REF: 'RAW_REF_SENTINEL',
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as OperatorUiAuthPacketAcceptanceReport;
    assertReportShape(parsed);
    assertRedactionSafe(output);
  });

  await test('CLI text output is accepted and redaction-safe', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/operator-ui-auth-packet-acceptance-cli.ts'], {
      cwd: root,
      env: {
        ...process.env,
        SECRET_HEADER_SENTINEL: 'SECRET_HEADER_SENTINEL',
        SECRET_QUERY_SENTINEL: 'SECRET_QUERY_SENTINEL',
        SECRET_BODY_SENTINEL: 'SECRET_BODY_SENTINEL',
        SECRET_PATH_SENTINEL: 'SECRET_PATH_SENTINEL',
        DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
      },
      encoding: 'utf8',
    });
    assert(output.includes('status: accepted'), 'text accepted');
    assert(output.includes('packetCount: 9'), 'text count only');
    assertRedactionSafe(output);
  });

  await test('failure evaluator closes failed checks as blocked', () => {
    assert(evaluateOperatorUiAuthPacketAcceptanceStatus([]) === 'accepted', 'empty evaluator is accepted');
    assert(evaluateOperatorUiAuthPacketAcceptanceStatus([
      { id: 'static-packet-endpoint-disabled', status: 'accepted', statusCode: 404, details: 'accepted' },
      { id: 'missing-header-fixed-401', status: 'blocked', details: 'blocked without diagnostics' },
    ]) === 'blocked', 'blocked check blocks report');
  });

  await test('source guard prevents DB, provider, live, framework, storage, and auth-scheme creep', () => {
    const source = read('src/ops/operator-ui-auth-packet-acceptance.ts');
    const cli = read('src/ops/operator-ui-auth-packet-acceptance-cli.ts');
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'puppeteer', 'playwright', 'axios', 'got', 'undici']) {
      assert(!allDeps.includes(dep), `no dependency ${dep}`);
    }
    for (const forbidden of [
      "from 'pg'",
      'from "pg"',
      'INSERT ',
      'UPDATE ',
      'DELETE ',
      'TRUNCATE',
      'globalThis.fetch',
      'fetch(',
      'node:https',
      'node:tls',
      'node:dns',
      'process.env',
      'react',
      'vite',
      'next',
      'express',
      'fastify',
      'koa',
      'document.',
      'window.',
      'localStorage',
      'sessionStorage',
      'Set-Cookie',
      'Authorization',
      'Bearer',
      'Basic',
      'OAuth',
      'cookieParser',
      'parseCookie',
      '.headers.authorization',
      "headers['authorization']",
      'ProviderAdapter',
      'TorBoxReadOnlyClient',
      'Real-Debrid',
      'TorBox',
      'Plex',
      'Jellyfin',
      'Hermes',
      'writeFile(',
      'createWriteStream',
    ]) assert(!`${source}\n${cli}`.includes(forbidden), `source excludes ${forbidden}`);
    assert(source.includes('mkdtempSync'), 'harness creates a temporary secret file');
    assert(source.includes('rmSync(context.tempDir'), 'harness cleans up temporary secret file');
    assert(source.includes('startOperatorUiStaticRuntime'), 'harness probes local runtime directly');
  });

  await test('docs, deploy guard, README, and package scripts are wired for Phase 82', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert(pkg.scripts['ops:operator-ui-auth-packet-acceptance'] === 'tsx src/ops/operator-ui-auth-packet-acceptance-cli.ts', 'ops script');
    assert(pkg.scripts['test:operator-ui-auth-packet-acceptance'] === 'tsx test/operator-ui-auth-packet-acceptance.ts', 'test script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-auth-packet-runtime.ts && tsx test/operator-ui-auth-packet-acceptance.ts'),
      'Phase 82 aggregate test follows Phase 81',
    );
    const combined = `${read('docs/PHASE_82_OPERATOR_UI_AUTH_PACKET_ACCEPTANCE.md')}\n${read('README.md')}\n${read('test/deploy.ts')}\n${read('package.json')}`;
    for (const kw of [
      'Phase 82',
      'Operator UI Auth Packet Acceptance Evidence',
      'operator UI auth packet acceptance',
      'ops:operator-ui-auth-packet-acceptance',
      'test:operator-ui-auth-packet-acceptance',
      'npm run --silent ops:operator-ui-auth-packet-acceptance -- --json',
      'operator-ui-auth-packet-acceptance',
      'phase-82.v1',
      'OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_REPORTED',
      'accepted',
      'blocked',
      'local-loopback-fixture-only',
      'local-secret-file-enabled',
      'sanitized-local-packet-endpoint',
      'synthetic-fixture-only',
      'counts only',
      'fixed 404',
      'fixed 401',
      'fixed 405',
      'hash-pinned inline script',
      'same-origin connect',
      'No DB reads',
      'no provider or debrid integrations',
      'no live source, scraping, download, playback, or media-server behavior',
      'O4 and O5 remain open/deferred',
      'FileCustodian remains a hardened reference harness only, not production KMS',
    ]) assert(combined.includes(kw), `Phase 82 wiring includes ${kw}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
