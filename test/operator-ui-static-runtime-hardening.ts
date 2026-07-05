import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { inspectOperatorUiRenderedHtml } from '../src/ops/operator-ui-render-allowlist.js';
import {
  OPERATOR_UI_STATIC_RUNTIME_CSP,
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
  OPERATOR_UI_STATIC_RUNTIME_HEADERS_TIMEOUT_MS,
  OPERATOR_UI_STATIC_RUNTIME_KEEP_ALIVE_TIMEOUT_MS,
  OPERATOR_UI_STATIC_RUNTIME_MAX_HEADERS_COUNT,
  OPERATOR_UI_STATIC_RUNTIME_REQUEST_TIMEOUT_MS,
  buildPrecheckedOperatorUiStaticRuntimeArtifact,
  createOperatorUiStaticRuntimeServer,
  startOperatorUiStaticRuntime,
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

function httpRequest(port: number, path: string, method = 'GET', body = ''): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
      port,
      path,
      method,
      headers: body.length > 0 ? { 'Content-Length': Buffer.byteLength(body, 'utf8') } : undefined,
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
    if (body.length > 0) req.write(body);
    req.end();
  });
}

async function chooseLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('unexpected test listener address')));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port: number, child: ChildProcessWithoutNullStreams): Promise<HttpResult> {
  const deadline = Date.now() + 10000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`runtime process exited before health probe succeeded: ${child.exitCode}`);
    }

    try {
      const response = await httpRequest(port, '/healthz');
      if (response.statusCode === 200) return response;
    } catch (err) {
      lastError = err;
    }

    await wait(100);
  }

  throw new Error(`timed out waiting for runtime health: ${(lastError as Error | undefined)?.message ?? 'no response'}`);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function assertSafeHeaders(response: HttpResult, contentType: string): void {
  assert(response.headers['cache-control'] === 'no-store', 'no-store');
  assert(response.headers['x-content-type-options'] === 'nosniff', 'nosniff');
  assert(response.headers['referrer-policy'] === 'no-referrer', 'referrer policy');
  assert(response.headers['x-frame-options'] === 'DENY', 'frame deny');
  assert(response.headers['content-security-policy'] === OPERATOR_UI_STATIC_RUNTIME_CSP, 'CSP');
  assert(response.headers['content-type'] === contentType, `content type ${contentType}`);
}

async function main(): Promise<void> {
  console.log('Running Phase 71 local static runtime hardening suite:\n');

  await test('pre-listen self-check retains the allowlist-gated Phase 65 artifact', async () => {
    const artifact = buildPrecheckedOperatorUiStaticRuntimeArtifact();
    assert(inspectOperatorUiRenderedHtml(artifact.html).ok, 'prechecked artifact passes Phase 64 allowlist');
    const server = createOperatorUiStaticRuntimeServer(artifact);
    const runtime = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST, () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('unexpected runtime listener address'));
          return;
        }
        resolve({
          port: address.port,
          close: () => new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => {
              if (err) closeReject(err);
              else closeResolve();
            });
          }),
        });
      });
    });

    try {
      const first = await httpRequest(runtime.port, '/');
      const second = await httpRequest(runtime.port, '/?ignored=1');
      assert(first.statusCode === 200, 'first root status');
      assert(second.statusCode === 200, 'query root status');
      assert(first.body === artifact.html, 'first response uses retained artifact');
      assert(second.body === artifact.html, 'query root response uses retained artifact');
      assertSafeHeaders(first, artifact.contentType);
      assertSafeHeaders(second, artifact.contentType);
    } finally {
      await runtime.close();
    }
  });

  await test('server uses conservative timeout and header-count limits', () => {
    const server = createOperatorUiStaticRuntimeServer();
    assert(server.requestTimeout === OPERATOR_UI_STATIC_RUNTIME_REQUEST_TIMEOUT_MS, 'request timeout');
    assert(server.headersTimeout === OPERATOR_UI_STATIC_RUNTIME_HEADERS_TIMEOUT_MS, 'headers timeout');
    assert(server.keepAliveTimeout === OPERATOR_UI_STATIC_RUNTIME_KEEP_ALIVE_TIMEOUT_MS, 'keep-alive timeout');
    assert(server.maxHeadersCount === OPERATOR_UI_STATIC_RUNTIME_MAX_HEADERS_COUNT, 'max headers');
  });

  await test('query strings do not create route behavior and traversal-ish paths stay closed', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const health = await httpRequest(runtime.port, '/healthz?x=1');
      assert(health.statusCode === 200, 'health query status');
      assertSafeHeaders(health, 'application/json; charset=utf-8');

      for (const path of ['/api/packets?x=1', '/..', '/%2e%2e', '/.%2e/healthz', '/%2fhealthz', '/healthz/%2e%2e']) {
        const response = await httpRequest(runtime.port, path);
        assert(response.statusCode === 404, `${path} status 404`);
        assert(response.body === 'not found\n', `${path} fixed 404 body`);
        assertSafeHeaders(response, 'text/plain; charset=utf-8');
      }
    } finally {
      await runtime.close();
    }
  });

  await test('HEAD is rejected consistently with Allow GET and empty body', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/', '/healthz', '/?x=1', '/healthz?x=1']) {
        const response = await httpRequest(runtime.port, path, 'HEAD');
        assert(response.statusCode === 405, `${path} HEAD status`);
        assert(response.headers.allow === 'GET', `${path} allow GET`);
        assert(response.body === '', `${path} empty body`);
        assertSafeHeaders(response, 'text/plain; charset=utf-8');
      }

      const missing = await httpRequest(runtime.port, '/missing', 'HEAD');
      assert(missing.statusCode === 404, 'missing HEAD remains 404');
      assert(missing.body === '', 'missing HEAD empty body');
      assertSafeHeaders(missing, 'text/plain; charset=utf-8');
    } finally {
      await runtime.close();
    }
  });

  await test('disallowed methods ignore bodies and return fixed sanitized responses', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const response = await httpRequest(runtime.port, '/', 'POST', 'rawPayload=SECRET_TOKEN_SENTINEL');
      assert(response.statusCode === 405, 'POST root status');
      assert(response.headers.allow === 'GET', 'POST allow GET');
      assert(response.body === 'method not allowed\n', 'fixed POST body');
      assert(!response.body.includes('SECRET_TOKEN_SENTINEL'), 'body not echoed');
      assertSafeHeaders(response, 'text/plain; charset=utf-8');
    } finally {
      await runtime.close();
    }
  });

  await test('CLI exits after a termination signal once the server is listening', async () => {
    const port = await chooseLoopbackPort();
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      'src/ops/operator-ui-static-runtime-cli.ts',
      '--serve',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ], {
      cwd: root,
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    try {
      const health = await waitForHealth(port, child);
      assert(health.statusCode === 200, 'health before shutdown');
      const exitPromise = waitForExit(child);
      child.kill(process.platform === 'win32' ? 'SIGINT' : 'SIGTERM');
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('runtime process did not exit after termination signal')), 5000);
      });
      const exit = await Promise.race([exitPromise, timeout]);
      if (process.platform !== 'win32') assert(exit.code === 0, `graceful exit code ${exit.code}`);
      assert(exit.signal === null || process.platform === 'win32', `unexpected signal exit ${String(exit.signal)}`);
      assert(!stderr.includes('failed safely'), `no shutdown failure output: ${stderr}`);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  await test('package scripts, docs, and source guards preserve Phase 71 hardening boundary', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert(pkg.scripts['test:operator-ui-static-runtime-hardening'] === 'tsx test/operator-ui-static-runtime-hardening.ts', 'Phase 71 test script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-static-runtime.ts && tsx test/operator-ui-static-runtime-hardening.ts'),
      'Phase 71 suite follows Phase 70 in main chain',
    );

    const source = read('src/ops/operator-ui-static-runtime.ts');
    const cli = read('src/ops/operator-ui-static-runtime-cli.ts');
    const combinedDocs = `${read('docs/PHASE_71_STATIC_RUNTIME_HARDENING.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
    for (const kw of [
      'Phase 71',
      'Local Static Runtime Hardening',
      'pre-listen self-check',
      'Phase 64 allowlist inspection',
      'HEAD',
      'query strings',
      'graceful shutdown',
      'npm run ops:operator-ui-static-runtime -- --serve --host 127.0.0.1 --port 8787',
      'Still serves only the in-process Phase 65 static artifact behind the Phase 64 allowlist',
      'no API/data route, packet source, DB/provider/playback/download/scraping/media-server behavior',
      'O4 and O5 remain open/deferred',
      'FileCustodian remains a hardened reference harness, not production KMS',
    ]) assert(combinedDocs.includes(kw), `Phase 71 docs/deploy include ${kw}`);

    assert(source.includes("from 'node:http'"), 'runtime still uses Node built-in HTTP');
    for (const forbidden of [
      '@torbox/torbox-api',
      'react',
      'vite',
      'next',
      'express',
      'fastify',
      'koa',
      'node:fs',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'globalThis.fetch',
      'fetch(',
      'process.env',
      "from 'pg'",
      "from \"pg\"",
      'INSERT ',
      'UPDATE ',
      'DELETE ',
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
    ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 71 source excludes ${forbidden}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
