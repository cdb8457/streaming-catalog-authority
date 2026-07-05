import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { inspectOperatorUiRenderedHtml } from '../src/ops/operator-ui-render-allowlist.js';
import { buildOperatorUiStaticArtifact } from '../src/ops/operator-ui-static-artifact.js';
import {
  OPERATOR_UI_STATIC_RUNTIME_CSP,
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
  OperatorUiStaticRuntimeConfigError,
  startOperatorUiStaticRuntime,
  validateOperatorUiStaticRuntimeConfig,
} from '../src/ops/operator-ui-static-runtime.js';

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

interface HttpResult {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const source = read('src/ops/operator-ui-static-runtime.ts');
const cliSource = read('src/ops/operator-ui-static-runtime-cli.ts');

function get(port: number, path: string, method = 'GET'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
      port,
      path,
      method,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function assertRejects(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch (err) {
    assert(err instanceof OperatorUiStaticRuntimeConfigError, `${message} fixed error type`);
    return;
  }
  throw new Error(message);
}

async function main(): Promise<void> {
  console.log('Running Phase 70 local static operator UI runtime shell suite:\n');

  await test('config validation allows loopback with ephemeral test port and bounded CLI ports only', () => {
    assert(JSON.stringify(validateOperatorUiStaticRuntimeConfig()) === JSON.stringify({ host: '127.0.0.1', port: 8787 }), 'default config');
    assert(validateOperatorUiStaticRuntimeConfig({ host: '127.0.0.1', port: 0 }).port === 0, 'ephemeral port allowed for runtime/tests');
    assert(validateOperatorUiStaticRuntimeConfig({ host: '127.0.0.1', port: 1024 }, { allowEphemeralPort: false }).port === 1024, 'minimum CLI port');
    assert(validateOperatorUiStaticRuntimeConfig({ host: '127.0.0.1', port: 65535 }, { allowEphemeralPort: false }).port === 65535, 'maximum CLI port');
    for (const host of ['', '0.0.0.0', '::', '::1', 'localhost', '192.168.1.10', '10.0.0.2', '8.8.8.8']) {
      assertRejects(() => validateOperatorUiStaticRuntimeConfig({ host, port: 8787 }), `reject host ${host || '<empty>'}`);
    }
    for (const port of [0, 1, 80, 1023, 65536, Number.NaN, 8787.5]) {
      assertRejects(() => validateOperatorUiStaticRuntimeConfig({ host: '127.0.0.1', port }, { allowEphemeralPort: false }), `reject CLI port ${port}`);
    }
  });

  await test('server serves allowlist-gated fixture HTML at / with fixed safe headers', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const response = await get(runtime.port, '/');
      const artifact = buildOperatorUiStaticArtifact();
      assert(response.statusCode === 200, 'root status 200');
      assert(response.body === artifact.html, 'root serves Phase 65 in-memory artifact HTML');
      assert(inspectOperatorUiRenderedHtml(response.body).ok, 'served HTML passes Phase 64 inspection');
      assert(response.headers['content-type'] === 'text/html; charset=utf-8', 'HTML content type');
      assert(response.headers['cache-control'] === 'no-store', 'no-store');
      assert(response.headers['x-content-type-options'] === 'nosniff', 'nosniff');
      assert(response.headers['content-security-policy'] === OPERATOR_UI_STATIC_RUNTIME_CSP, 'CSP');
      for (const forbidden of [
        '<script',
        'href="http',
        'src="http',
        'fetch(',
        'localStorage',
        'sessionStorage',
        'Real-Debrid',
        'TorBox logo',
        'magnet:',
        'providerRef',
        'rawPayload',
        'playback',
        'download',
      ]) assert(!response.body.includes(forbidden), `HTML omits ${forbidden}`);
    } finally {
      await runtime.close();
    }
  });

  await test('health route is fixed JSON and exposes no environment, path, or live status detail', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const response = await get(runtime.port, '/healthz');
      const parsed = JSON.parse(response.body) as { ok: boolean; code: string; status: string };
      assert(response.statusCode === 200, 'health status 200');
      assert(response.headers['content-type'] === 'application/json; charset=utf-8', 'JSON content type');
      assert(parsed.ok === true, 'health ok');
      assert(parsed.code === 'OPERATOR_UI_STATIC_RUNTIME_HEALTHY', 'fixed health code');
      assert(parsed.status === 'fixture/static/local-only', 'fixed fixture/local status');
      for (const forbidden of ['SECRET_TOKEN_SENTINEL', root, 'DATABASE_URL', 'PATH', 'packet', 'provider', 'live']) {
        assert(!response.body.includes(forbidden), `health omits ${forbidden}`);
      }
    } finally {
      await runtime.close();
    }
  });

  await test('unknown routes and wrong methods return safe 404/405 without data endpoints', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const missing = await get(runtime.port, '/api/packets');
      const wrongMethod = await get(runtime.port, '/', 'POST');
      assert(missing.statusCode === 404, 'unknown route 404');
      assert(missing.body === 'not found\n', 'safe 404 body');
      assert(wrongMethod.statusCode === 405, 'wrong method 405');
      assert(wrongMethod.headers.allow === 'GET', 'GET allow header');
      assert(wrongMethod.body === 'method not allowed\n', 'safe 405 body');
      for (const response of [missing, wrongMethod]) {
        assert(response.headers['cache-control'] === 'no-store', 'error no-store');
        assert(response.headers['x-content-type-options'] === 'nosniff', 'error nosniff');
        assert(response.headers['content-security-policy'] === OPERATOR_UI_STATIC_RUNTIME_CSP, 'error CSP');
        assert(response.headers['content-type'] === 'text/plain; charset=utf-8', 'plain error type');
      }
    } finally {
      await runtime.close();
    }
  });

  await test('CLI without --serve prints boundary usage and exits without starting a listener', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-static-runtime-cli.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert(output.includes('Operator UI Static Runtime Shell'), 'usage title');
    assert(output.includes('--serve'), 'usage requires explicit serve flag');
    assert(output.includes('local fixture-only static preview'), 'boundary text');
    assert(output.includes('no API, packet source, DB read, provider, playback, download, scraping, or media-server behavior'), 'scope text');
    assert(!output.includes('listening at'), 'does not start listener');
  });

  await test('package scripts, docs, and deploy guard include Phase 70 runtime shell', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert(pkg.scripts['ops:operator-ui-static-runtime'] === 'tsx src/ops/operator-ui-static-runtime-cli.ts', 'ops script');
    assert(pkg.scripts['test:operator-ui-static-runtime'] === 'tsx test/operator-ui-static-runtime.ts', 'test script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-packet-source-contract.ts && tsx test/operator-ui-static-runtime.ts'),
      'suite follows Phase 69',
    );
    const combined = `${read('docs/PHASE_70_LOCAL_STATIC_UI_RUNTIME_SHELL.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
    for (const kw of [
      'Phase 70',
      'Local Static Operator UI Runtime Shell',
      'operator UI static runtime shell',
      'ops:operator-ui-static-runtime',
      'test:operator-ui-static-runtime',
      'npm run ops:operator-ui-static-runtime -- -- --serve --host 127.0.0.1 --port 8787',
      '127.0.0.1',
      'GET /',
      'GET /healthz',
      'Phase 64 render allowlist',
      'Phase 65 artifact packaging',
      'Phase 68/69 boundaries remain visible',
      'no live DB/provider/packet-source/API/playback/download/scraping/media-server behavior',
      'O4 and O5 remain open/deferred',
      'FileCustodian remains a hardened reference harness, not production KMS',
    ]) assert(combined.includes(kw), `Phase 70 docs/deploy include ${kw}`);
  });

  await test('runtime source has no DB/env/fs scan/provider/playback/download/scraping/framework scope creep', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
      assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
    }

    const combined = `${source}\n${cliSource}`;
    assert(combined.includes("from 'node:http'"), 'Phase 70 uses Node built-in HTTP only');
    for (const forbidden of [
      'react',
      'vite',
      'next',
      'express',
      'fastify',
      'koa',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:fs',
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
      'writeFile',
      'createWriteStream',
      '/api/',
      'DATABASE_URL',
    ]) assert(!combined.includes(forbidden), `source excludes ${forbidden}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
