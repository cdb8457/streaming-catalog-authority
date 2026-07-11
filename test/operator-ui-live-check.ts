import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOperatorUiLiveCheck } from '../src/ops/operator-ui-live-check.js';

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
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const execFileAsync = promisify(execFile);

async function cliOk(args: readonly string[]): Promise<string> {
  const result = await execFileAsync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/operator-ui-live-check-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.stdout;
}

async function withFakeUi(fn: (baseUrl: string, tokenFile: string, token: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-operator-ui-live-check-'));
  const token = 'phase150-live-check-token-ABCDEFGH-12345';
  const tokenFile = join(dir, 'operator_ui_token');
  writeFileSync(tokenFile, `${token}\n`, 'utf8');

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url?.split('?')[0] ?? '/';
    const auth = req.headers['x-operator-ui-secret'];
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === '/api/status' && auth !== token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'AUTH_REQUIRED' }));
      return;
    }
    if (path === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        doctorSummary: { pass: 12, warn: 2, fail: 0, total: 14 },
        needsAttention: ['WARN o4', 'WARN o5'],
      }));
      return;
    }
    if (path === '/api/logs' && auth === token) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries: [{ level: 'info', message: 'redacted' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('unexpected listener address');
    await fn(`http://127.0.0.1:${address.port}`, tokenFile, token);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('Running Phase 150 operator UI live check suite:\n');

await test('live check probes health, auth rejection, status, and logs without token output', async () => {
  await withFakeUi(async (baseUrl, tokenFile, token) => {
    const report = await runOperatorUiLiveCheck({ baseUrl, tokenFile });
    const serialized = JSON.stringify(report);
    assert(report.report === 'phase-150-operator-ui-live-check', 'report id');
    assert(report.ok === true, 'ok');
    assert(report.checks.length === 4, 'four checks');
    assert(report.statusSummary?.warn === 2, 'warn count');
    assert(report.statusSummary?.needsAttentionCount === 2, 'attention count');
    assert(report.logSummary?.entries === 1, 'log count');
    assert(!serialized.includes(token), 'report omits token');
    assert(!serialized.includes('postgresql://'), 'report omits db url');
  });
});

await test('CLI emits redaction-safe JSON and text summaries', async () => {
  await withFakeUi(async (baseUrl, tokenFile, token) => {
    const json = await cliOk(['--url', baseUrl, '--token-file', tokenFile, '--json']);
    assert(json.includes('phase-150-operator-ui-live-check'), 'json report');
    assert(json.includes('"ok":true'), 'json ok');
    assert(!json.includes(token), 'json omits token');
    const text = await cliOk(['--url', baseUrl, '--token-file', tokenFile]);
    assert(text.includes('PASS healthz status=200'), 'text health');
    assert(text.includes('PASS unauth-status status=401'), 'text unauth');
    assert(text.includes('doctor pass=12 warn=2 fail=0 total=14'), 'text summary');
    assert(!text.includes(token), 'text omits token');
  });
});

await test('source, docs, package, and launcher preserve live-check boundary', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['test:operator-ui-live-check'] === 'tsx test/operator-ui-live-check.ts', 'test script');
  assert(pkg.scripts['ops:operator-ui-live-check'] === 'tsx src/ops/operator-ui-live-check-cli.ts', 'ops script');
  assert((pkg.scripts.test ?? '').includes('test/operator-ui-token.ts && tsx test/operator-ui-live-check.ts'), 'aggregate order');
  const source = `${read('src/ops/operator-ui-live-check.ts')}\n${read('src/ops/operator-ui-live-check-cli.ts')}`;
  const combined = [
    source,
    read('deploy/unraid-ops-launcher.sh'),
    read('docs/PHASE_150_OPERATOR_UI_LIVE_CHECK.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'phase-150-operator-ui-live-check',
    'ops:operator-ui-live-check',
    'ui-live-check',
    '/healthz',
    '/api/status',
    '/api/logs',
    'redaction-safe',
  ]) assert(combined.includes(required), `surface includes ${required}`);
  assert(!source.includes('--print --confirm-print'), 'live check has no token print path');
  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'request-download-link',
    'magnet:',
    'docker compose',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
