import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_UI_STATIC_RUNTIME_CSP,
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
  OperatorUiStaticRuntimeConfigError,
  buildOperatorUiStaticRuntimeManifest,
  startOperatorUiStaticRuntime,
  validateOperatorUiStaticRuntimeConfig,
  type OperatorUiStaticRuntimeManifest,
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

const expectedAccessBoundary = {
  accessBoundary: 'loopback-only-fixture-preview',
  operatorAuth: 'not-implemented',
  remoteExposure: 'blocked',
  futureDataSurfacesRequire: 'explicit-auth-access-phase',
} as const;

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

function rawHttpRequest(port: number, target: string, method = 'GET', body = ''): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST);
    let raw = '';

    socket.setEncoding('utf8');
    socket.setTimeout(5000);
    socket.on('connect', () => {
      socket.write(`${method} ${target} HTTP/1.1\r\n`);
      socket.write(`Host: ${OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST}:${port}\r\n`);
      if (body.length > 0) socket.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n`);
      socket.write('Connection: close\r\n\r\n');
      if (body.length > 0) socket.write(body);
    });
    socket.on('data', (chunk: string) => { raw += chunk; });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`timed out waiting for raw response to ${target}`));
    });
    socket.on('error', reject);
    socket.on('end', () => {
      const [head = '', responseBody = ''] = raw.split('\r\n\r\n');
      const lines = head.split('\r\n');
      const statusCode = Number(lines[0]?.split(' ')[1] ?? 0);
      const headers: Record<string, string | string[] | undefined> = {};
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(':');
        if (separator === -1) continue;
        headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
      }
      resolve({ statusCode, headers, body: responseBody });
    });
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

function assertRejectsConfig(input: { host?: string; port?: number }, message: string): void {
  try {
    validateOperatorUiStaticRuntimeConfig(input, { allowEphemeralPort: false });
  } catch (err) {
    assert(err instanceof OperatorUiStaticRuntimeConfigError, `${message} fixed error type`);
    return;
  }
  throw new Error(message);
}

function assertNoCredentialParserSource(): void {
  const source = read('src/ops/operator-ui-static-runtime.ts');
  const cli = read('src/ops/operator-ui-static-runtime-cli.ts');
  const combined = `${source}\n${cli}`;

  for (const forbidden of [
    'Set-Cookie',
    'Cookie',
    'cookie',
    'session',
    'Authorization',
    'authorization',
    'Bearer',
    'bearer',
    'Basic',
    'basic',
    'token',
    'credential',
    'password',
    'process.env',
    'DATABASE_URL',
    'CUSTODIAN_KEK',
    'readFileSync',
    'readdirSync',
    'existsSync',
    "from 'node:fs'",
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'from "pg"',
    '/api/',
    '/packets',
    '/login',
    '/session',
    '/auth',
    '/token',
  ]) assert(!combined.includes(forbidden), `runtime source excludes ${forbidden}`);
}

async function main(): Promise<void> {
  console.log('Running Phase 73 operator static runtime access-boundary suite:\n');

  await test('config remains loopback-only with bounded CLI ports', () => {
    assert(JSON.stringify(validateOperatorUiStaticRuntimeConfig()) === JSON.stringify({ host: '127.0.0.1', port: 8787 }), 'default loopback config');
    assert(validateOperatorUiStaticRuntimeConfig({ host: '127.0.0.1', port: 0 }).port === 0, 'ephemeral runtime port remains test-only helper path');
    assert(validateOperatorUiStaticRuntimeConfig({ host: '127.0.0.1', port: 1024 }, { allowEphemeralPort: false }).port === 1024, 'minimum CLI port');
    assert(validateOperatorUiStaticRuntimeConfig({ host: '127.0.0.1', port: 65535 }, { allowEphemeralPort: false }).port === 65535, 'maximum CLI port');

    for (const host of ['', '0.0.0.0', '::', '::1', 'localhost', '192.168.1.10', '10.0.0.2', '8.8.8.8']) {
      assertRejectsConfig({ host, port: 8787 }, `reject host ${host || '<empty>'}`);
    }
    for (const port of [0, 1, 80, 1023, 65536, Number.NaN, 8787.5]) {
      assertRejectsConfig({ host: '127.0.0.1', port }, `reject CLI port ${port}`);
    }
  });

  await test('manifest exposes fixed access-boundary metadata and no runtime input', async () => {
    process.env.SECRET_TOKEN_SENTINEL = 'must-not-leak';
    const built = buildOperatorUiStaticRuntimeManifest();
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const response = await httpRequest(runtime.port, '/manifest.json');
      const parsed = JSON.parse(response.body) as OperatorUiStaticRuntimeManifest;
      for (const manifest of [built, parsed]) {
        assert(manifest.accessBoundary === expectedAccessBoundary.accessBoundary, 'fixed access boundary');
        assert(manifest.operatorAuth === expectedAccessBoundary.operatorAuth, 'fixed operator auth status');
        assert(manifest.remoteExposure === expectedAccessBoundary.remoteExposure, 'fixed remote exposure status');
        assert(manifest.futureDataSurfacesRequire === expectedAccessBoundary.futureDataSurfacesRequire, 'fixed future gate');
      }
      assert(response.statusCode === 200, 'manifest status 200');
      assertSafeHeaders(response, 'application/json; charset=utf-8');
      assert(!response.body.includes('must-not-leak'), 'manifest omits env sentinel');
      for (const forbidden of [root, '127.0.0.1', String(runtime.port), 'process.env', 'git', 'commit', 'timestamp']) {
        assert(!response.body.includes(forbidden), `manifest omits dynamic value ${forbidden}`);
      }
    } finally {
      delete process.env.SECRET_TOKEN_SENTINEL;
      await runtime.close();
    }
  });

  await test('route surface remains root, health, and manifest only', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/', '/healthz', '/manifest.json']) {
        const response = await httpRequest(runtime.port, path);
        assert(response.statusCode === 200, `${path} remains served`);
      }

      for (const path of ['/api/packets', '/api/status', '/packets', '/login', '/session', '/auth', '/token', '/manifest.json/api']) {
        const get = await httpRequest(runtime.port, path);
        const post = await httpRequest(runtime.port, path, 'POST', 'SECRET_TOKEN_SENTINEL=must-not-leak');
        const head = await httpRequest(runtime.port, path, 'HEAD');
        assert(get.statusCode === 404, `${path} GET fixed 404`);
        assert(get.body === 'not found\n', `${path} GET fixed body`);
        assert(post.statusCode === 404, `${path} POST fixed 404`);
        assert(post.body === 'not found\n', `${path} POST fixed body`);
        assert(head.statusCode === 404, `${path} HEAD fixed 404`);
        assert(head.body === '', `${path} HEAD empty body`);
        for (const response of [get, post, head]) {
          assertSafeHeaders(response, 'text/plain; charset=utf-8');
          assert(!response.body.includes('SECRET_TOKEN_SENTINEL'), `${path} no body echo`);
        }
      }
    } finally {
      await runtime.close();
    }
  });

  await test('known routes reject HEAD and unsafe methods without accepting bodies', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/', '/healthz', '/manifest.json']) {
        const head = await httpRequest(runtime.port, path, 'HEAD');
        assert(head.statusCode === 405, `${path} HEAD fixed 405`);
        assert(head.headers.allow === 'GET', `${path} Allow GET`);
        assert(head.body === '', `${path} HEAD empty body`);
        assertSafeHeaders(head, 'text/plain; charset=utf-8');

        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
          const response = await httpRequest(runtime.port, path, method, 'cookie=session&token=SECRET_TOKEN_SENTINEL');
          assert(response.statusCode === 405, `${path} ${method} fixed 405`);
          assert(response.headers.allow === 'GET', `${path} ${method} Allow GET`);
          assert(response.body === 'method not allowed\n', `${path} ${method} fixed body`);
          assert(!response.body.includes('SECRET_TOKEN_SENTINEL'), `${path} ${method} no body echo`);
          assertSafeHeaders(response, 'text/plain; charset=utf-8');
        }
      }
    } finally {
      await runtime.close();
    }
  });

  await test('raw request-target bypass forms around blocked surfaces stay fixed 404', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const target of [
        'http://evil/api/packets',
        'https://evil/login',
        '//evil/session',
        '///auth',
        '/%2e/api/packets',
        '/api%2fpackets',
        '/manifest.json%2f..%2fauth',
        '/token%5c..',
        '/packets\\..',
      ]) {
        const response = await rawHttpRequest(runtime.port, target, 'POST', 'SECRET_TOKEN_SENTINEL=must-not-leak');
        assert(response.statusCode === 404, `${target} status 404`);
        assert(response.body === 'not found\n', `${target} fixed body`);
        assert(!response.body.includes('SECRET_TOKEN_SENTINEL'), `${target} no body echo`);
        assertSafeHeaders(response, 'text/plain; charset=utf-8');
      }
    } finally {
      await runtime.close();
    }
  });

  await test('source includes no auth/session/cookie/token parser or secret-read path', () => {
    assertNoCredentialParserSource();
  });

  await test('docs, README, deploy guard, and package wiring state the access boundary', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert(pkg.scripts['test:operator-ui-static-runtime-access-boundary'] === 'tsx test/operator-ui-static-runtime-access-boundary.ts', 'Phase 73 test script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-static-runtime-manifest.ts && tsx test/operator-ui-static-runtime-access-boundary.ts'),
      'Phase 73 suite follows Phase 72 manifest suite',
    );

    const combined = `${read('docs/PHASE_73_OPERATOR_UI_ACCESS_BOUNDARY.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
    for (const kw of [
      'Phase 73',
      'Operator Static Runtime Access Boundary',
      'test:operator-ui-static-runtime-access-boundary',
      'accessBoundary: loopback-only-fixture-preview',
      'operatorAuth: not-implemented',
      'remoteExposure: blocked',
      'futureDataSurfacesRequire: explicit-auth-access-phase',
      'not production auth',
      'does not authorize reverse proxy or public exposure',
      'loopback-only fixture preview',
      'no auth/session/cookie/token mechanism',
      'no API route, packet endpoint, DB read, provider integration, playback, download, scraping, media-server logic, TLS, or public bind',
      'O4 and O5 remain open/deferred',
      'FileCustodian remains a hardened reference harness, not production KMS',
      'Provider availability remains packet/count/advisory only',
    ]) assert(combined.includes(kw), `Phase 73 docs/deploy include ${kw}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
