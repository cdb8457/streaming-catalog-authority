import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_UI_STATIC_RUNTIME_CSP,
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
  buildOperatorUiStaticRuntimeManifest,
  startOperatorUiStaticRuntime,
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

const expectedManifest: OperatorUiStaticRuntimeManifest = {
  ok: true,
  code: 'OPERATOR_UI_STATIC_RUNTIME_MANIFEST',
  surface: 'local-static-fixture-preview',
  routes: ['GET /', 'GET /healthz', 'GET /manifest.json'],
  dataMode: 'fixture-only',
  packetSource: 'not-implemented',
  localRuntime: 'static-preview-only',
  liveProduct: 'not-ready',
  accessBoundary: 'loopback-only-fixture-preview',
  operatorAuth: 'not-implemented',
  remoteExposure: 'blocked',
  futureDataSurfacesRequire: 'explicit-auth-access-phase',
  boundaries: [
    'no-db-read',
    'no-provider-call-or-integration',
    'no-api-data-route',
    'no-playback-control',
    'no-download-control',
    'no-scraping',
    'no-media-server-logic',
    'no-packet-source',
    'no-live-packet-ingestion',
    'no-secret-material',
    'no-host-machine-data',
    'no-filesystem-artifact-read',
    'no-env-or-config-read',
    'no-outbound-network',
  ],
  gates: [
    'Phase 64 render allowlist remains enforced',
    'Phase 65 in-process static artifact remains the root body',
    'Phase 68 local runtime boundary remains blocked/deferred',
    'Phase 69 packet source contract remains not implemented',
    'Phase 71 raw target hardening remains enforced',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Provider availability remains packet/count/advisory only',
  ],
};

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

function assertManifestOmitsForbiddenText(body: string): void {
  for (const forbidden of [
    'SECRET_TOKEN_SENTINEL',
    'must-not-leak',
    root,
    '127.0.0.1',
    '8787',
    'DATABASE_URL',
    'PATH',
    'process.env',
    'package-lock',
    'version',
    'git',
    'commit',
    'timestamp',
    'createdAt',
    'updatedAt',
    'title',
    'externalId',
    'providerRef',
    'rawRef',
    'rawPayload',
    'infohash',
    'magnet:',
    'credential',
    'poster',
    'artwork',
    'library',
    'Real-Debrid',
    'TorBox',
    'Plex',
    'Jellyfin',
    'Hermes',
  ]) assert(!body.includes(forbidden), `manifest omits ${forbidden}`);
}

async function main(): Promise<void> {
  console.log('Running Phase 72 local static runtime manifest suite:\n');

  await test('manifest builder is deterministic, fixed, and no-input', () => {
    const first = buildOperatorUiStaticRuntimeManifest();
    const second = buildOperatorUiStaticRuntimeManifest();
    assert(JSON.stringify(first) === JSON.stringify(expectedManifest), 'manifest matches fixed expected object');
    assert(JSON.stringify(second) === JSON.stringify(expectedManifest), 'second manifest is identical');
    assert(JSON.stringify(first) === JSON.stringify(second), 'deterministic serialization');
    assert(JSON.stringify(Object.keys(first)) === JSON.stringify([
      'ok',
      'code',
      'surface',
      'routes',
      'dataMode',
      'packetSource',
      'localRuntime',
      'liveProduct',
      'accessBoundary',
      'operatorAuth',
      'remoteExposure',
      'futureDataSurfacesRequire',
      'boundaries',
      'gates',
    ]), 'deterministic key ordering');

    (first.routes as unknown as string[]).push('GET /api/packets');
    (first.boundaries as unknown as string[]).push('mutated');
    assert(JSON.stringify(buildOperatorUiStaticRuntimeManifest()) === JSON.stringify(expectedManifest), 'fresh build is not affected by caller mutation');
  });

  await test('/manifest.json returns fixed JSON and safe headers', async () => {
    process.env.SECRET_TOKEN_SENTINEL = 'must-not-leak';
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const response = await httpRequest(runtime.port, '/manifest.json');
      const parsed = JSON.parse(response.body) as OperatorUiStaticRuntimeManifest;
      assert(response.statusCode === 200, 'manifest status 200');
      assertSafeHeaders(response, 'application/json; charset=utf-8');
      assert(response.body === `${JSON.stringify(expectedManifest)}\n`, 'manifest body is fixed serialization');
      assert(JSON.stringify(parsed) === JSON.stringify(expectedManifest), 'parsed manifest matches expected');
      assertManifestOmitsForbiddenText(response.body);
    } finally {
      delete process.env.SECRET_TOKEN_SENTINEL;
      await runtime.close();
    }
  });

  await test('HEAD /manifest.json returns 405, Allow GET, and empty body', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const response = await httpRequest(runtime.port, '/manifest.json', 'HEAD');
      assert(response.statusCode === 405, 'HEAD status');
      assert(response.headers.allow === 'GET', 'Allow GET');
      assert(response.body === '', 'empty body');
      assertSafeHeaders(response, 'text/plain; charset=utf-8');
    } finally {
      await runtime.close();
    }
  });

  await test('bad methods and bodies to manifest do not echo data', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const response = await httpRequest(runtime.port, '/manifest.json', method, 'rawPayload=SECRET_TOKEN_SENTINEL&path=C:\\secret');
        assert(response.statusCode === 405, `${method} status`);
        assert(response.headers.allow === 'GET', `${method} Allow GET`);
        assert(response.body === 'method not allowed\n', `${method} fixed body`);
        assert(!response.body.includes('SECRET_TOKEN_SENTINEL'), `${method} no echo`);
        assert(!response.body.includes('C:\\secret'), `${method} no path echo`);
        assertSafeHeaders(response, 'text/plain; charset=utf-8');
      }
    } finally {
      await runtime.close();
    }
  });

  await test('raw request-target bypass forms around manifest return fixed 404', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const target of [
        '//evil/manifest.json',
        'http://evil/manifest.json',
        'https://evil/manifest.json',
        '///manifest.json',
        '/%2e/manifest.json',
        '/manifest.json/%2e%2e',
        '/manifest.json%2f..',
        '/manifest.json%5c..',
        '/manifest.json\\..',
      ]) {
        const response = await rawHttpRequest(runtime.port, target);
        assert(response.statusCode === 404, `${target} status 404`);
        assert(response.body === 'not found\n', `${target} fixed body`);
        assertSafeHeaders(response, 'text/plain; charset=utf-8');
      }

      const manifest = await rawHttpRequest(runtime.port, '/manifest.json');
      assert(manifest.statusCode === 200, 'normal manifest remains matched');
      assert(manifest.body === `${JSON.stringify(expectedManifest)}\n`, 'normal manifest body');
      assertSafeHeaders(manifest, 'application/json; charset=utf-8');
    } finally {
      await runtime.close();
    }
  });

  await test('existing root, health, and unknown route behavior remain intact', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const rootResponse = await httpRequest(runtime.port, '/');
      const health = await httpRequest(runtime.port, '/healthz');
      const healthWithQuery = await httpRequest(runtime.port, '/healthz?x=1');
      const missing = await httpRequest(runtime.port, '/api/packets');
      assert(rootResponse.statusCode === 200, 'root still served');
      assert(rootResponse.headers['content-type'] === 'text/html; charset=utf-8', 'root content type');
      assert(health.statusCode === 200, 'health still served');
      assert(health.body === '{"ok":true,"code":"OPERATOR_UI_STATIC_RUNTIME_HEALTHY","status":"fixture/static/local-only"}\n', 'fixed health body');
      assertSafeHeaders(health, 'application/json; charset=utf-8');
      assert(healthWithQuery.statusCode === 200, 'health query still served');
      assert(missing.statusCode === 404, 'unknown route still 404');
      assert(missing.body === 'not found\n', 'unknown route fixed body');
      assertSafeHeaders(missing, 'text/plain; charset=utf-8');
    } finally {
      await runtime.close();
    }
  });

  await test('source, docs, deploy guard, and package wiring preserve Phase 72 scope', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert(pkg.scripts['test:operator-ui-static-runtime-manifest'] === 'tsx test/operator-ui-static-runtime-manifest.ts', 'Phase 72 test script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-static-runtime-hardening.ts && tsx test/operator-ui-static-runtime-manifest.ts'),
      'Phase 72 suite follows Phase 71 hardening in main chain',
    );

    const source = read('src/ops/operator-ui-static-runtime.ts');
    const cli = read('src/ops/operator-ui-static-runtime-cli.ts');
    const combinedDocs = `${read('docs/PHASE_72_STATIC_RUNTIME_MANIFEST.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
    for (const kw of [
      'Phase 72',
      'Local Static Runtime Manifest Endpoint',
      'test:operator-ui-static-runtime-manifest',
      'GET /manifest.json',
      'OPERATOR_UI_STATIC_RUNTIME_MANIFEST',
      'local-static-fixture-preview',
      'fixture-only',
      'not-implemented',
      'static-preview-only',
      'not-ready',
      'Phase 64',
      'Phase 65',
      'Phase 68',
      'Phase 69',
      'Phase 71',
      'O4 and O5 remain open/deferred',
      'FileCustodian remains a hardened reference harness, not production KMS',
      'Provider availability remains packet/count/advisory only',
      'no DB/provider/API data/playback/download/scraping/media-server/packet source behavior',
    ]) assert(combinedDocs.includes(kw), `Phase 72 docs/deploy include ${kw}`);

    assert(source.includes("from 'node:http'"), 'runtime still uses Node built-in HTTP');
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
      assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
    }
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
      'TorBox',
      'Plex',
      'Jellyfin',
      'Hermes',
      'writeFile',
      'createWriteStream',
      '/api/',
      'DATABASE_URL',
    ]) assert(!`${source}\n${cli}`.includes(forbidden), `Phase 72 source excludes ${forbidden}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
