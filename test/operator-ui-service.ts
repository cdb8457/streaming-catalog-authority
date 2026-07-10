import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_UI_SERVICE_DEFAULT_PORT,
  OperatorUiServiceConfigError,
  createOperatorUiServiceServer,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import { loadOperatorUiLocalAuthRuntime, OPERATOR_UI_LOCAL_AUTH_HEADER } from '../src/ops/operator-ui-local-auth-runtime.js';

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

function httpGet(port: number, path: string, token?: string, method = 'GET'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers[OPERATOR_UI_LOCAL_AUTH_HEADER] = token;
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
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

async function chooseLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
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

function assertConfigRejects(input: Parameters<typeof validateOperatorUiServiceConfig>[0], message: string): void {
  try {
    validateOperatorUiServiceConfig(input);
  } catch (err) {
    assert(err instanceof OperatorUiServiceConfigError, `${message} fixed error type`);
    return;
  }
  throw new Error(message);
}

async function withRuntime(fn: (port: number, token: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-operator-ui-service-'));
  const token = 'phase147-token-value-ABCDEFGH-12345';
  const tokenFile = join(dir, 'operator_ui_token');
  writeFileSync(tokenFile, `${token}\n`, 'utf8');
  const port = await chooseLoopbackPort();
  const config = validateOperatorUiServiceConfig({ host: '127.0.0.1', port, operatorSecretFile: tokenFile });
  const auth = loadOperatorUiLocalAuthRuntime(tokenFile);
  const server = createOperatorUiServiceServer(config, auth);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  try {
    await fn(port, token);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log('Running Phase 147 operator UI service suite:\n');

  await test('config requires intentional port, allowed host, and token file', () => {
    const config = validateOperatorUiServiceConfig({ operatorSecretFile: '/run/secrets/operator_ui_token' });
    assert(config.host === '0.0.0.0', 'default host binds container interface');
    assert(config.port === OPERATOR_UI_SERVICE_DEFAULT_PORT, 'default port 8099');
    assert(config.operatorSecretFile === '/run/secrets/operator_ui_token', 'secret file retained');
    assert(validateOperatorUiServiceConfig({ host: '127.0.0.1', port: 8099, operatorSecretFile: 'x' }).host === '127.0.0.1', 'loopback allowed for tests');
    for (const host of ['', '::', 'localhost', '192.168.1.10', '10.0.0.2']) {
      assertConfigRejects({ host, port: 8099, operatorSecretFile: 'x' }, `reject host ${host || '<empty>'}`);
    }
    for (const port of [0, 80, 1023, 65536, Number.NaN, 8099.5]) {
      assertConfigRejects({ host: '0.0.0.0', port, operatorSecretFile: 'x' }, `reject port ${port}`);
    }
    assertConfigRejects({ host: '0.0.0.0', port: 8099 }, 'reject missing token file');
  });

  await test('root and health are safe without exposing operational data', async () => {
    await withRuntime(async (port) => {
      const rootResponse = await httpGet(port, '/');
      assert(rootResponse.statusCode === 200, 'root status');
      assert(rootResponse.headers['content-type'] === 'text/html; charset=utf-8', 'html content type');
      assert(rootResponse.headers['cache-control'] === 'no-store', 'no-store');
      assert(rootResponse.headers['x-frame-options'] === 'DENY', 'frame denied');
      assert(rootResponse.body.includes('Catalog Authority'), 'brand visible');
      assert(rootResponse.body.includes('Operator token'), 'token input visible');
      for (const forbidden of ['postgresql://', 'CUSTODIAN_KEK', 'COMPLETION_SECRET', 'providerRef', 'rawPayload', 'playback', 'download']) {
        assert(!rootResponse.body.includes(forbidden), `root omits ${forbidden}`);
      }

      const health = await httpGet(port, '/healthz');
      assert(health.statusCode === 200, 'health status');
      const parsed = JSON.parse(health.body) as { ok: boolean; code: string; mode: string };
      assert(parsed.ok === true, 'health ok');
      assert(parsed.code === 'OPERATOR_UI_SERVICE_HEALTHY', 'health code');
      assert(parsed.mode === 'read-only-first', 'health mode');
    });
  });

  await test('status and logs require token and remain redaction-safe', async () => {
    await withRuntime(async (port, token) => {
      const unauthStatus = await httpGet(port, '/api/status');
      assert(unauthStatus.statusCode === 401, 'status unauthorized');
      const badToken = await httpGet(port, '/api/logs', 'wrong-token-value-ABCDEFGH-12345');
      assert(badToken.statusCode === 401, 'logs bad token rejected');

      const status = await httpGet(port, '/api/status', token);
      assert(status.statusCode === 503, 'status reports unavailable DB as 503');
      const parsed = JSON.parse(status.body) as { report: string; mode: string; auth: string; forbidden: string[]; doctor: { ok: boolean; checks: Array<{ detail: string }> } };
      assert(parsed.report === 'phase-147-operator-ui-service', 'status report id');
      assert(parsed.mode === 'read-only-first', 'read-only first');
      assert(parsed.auth === 'local-admin-token-file', 'auth boundary');
      for (const forbidden of ['provider-contact', 'scraping', 'downloading', 'playback', 'runtime-mutations', 'secret-exposure']) {
        assert(parsed.forbidden.includes(forbidden), `forbidden ${forbidden}`);
      }
      assert(parsed.doctor.ok === false, 'doctor failed safely without test DB');
      assert(!status.body.includes(token), 'status does not echo token');
      assert(!status.body.includes('postgresql://'), 'status does not echo database URL');

      const logs = await httpGet(port, '/api/logs', token);
      assert(logs.statusCode === 200, 'logs authorized');
      const logBody = JSON.parse(logs.body) as { report: string; entries: Array<{ class: string; message: string }> };
      assert(logBody.report === 'phase-147-operator-ui-service-logs', 'logs report id');
      assert(logBody.entries.some((entry) => entry.class === 'system'), 'system log present');
      assert(logBody.entries.some((entry) => entry.class === 'operation'), 'operation log present');
      assert(!logs.body.includes(token), 'logs do not echo token');
    });
  });

  await test('unsafe paths and methods fail closed', async () => {
    await withRuntime(async (port, token) => {
      assert((await httpGet(port, '/api/status?x=1', token)).statusCode === 503, 'query stripped for known route');
      assert((await httpGet(port, '/..%2fsecret', token)).statusCode === 404, 'encoded traversal rejected');
      assert((await httpGet(port, '/api/status', token, 'POST')).statusCode === 405, 'post rejected');
      assert((await httpGet(port, '/api/logs', token, 'HEAD')).statusCode === 405, 'head rejected');
    });
  });

  await test('package, compose, docs, and source preserve Phase 147 boundary', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert(pkg.scripts['test:operator-ui-service'] === 'tsx test/operator-ui-service.ts', 'test script');
    assert(pkg.scripts['ops:operator-ui-server'] === 'tsx src/ops/operator-ui-service-cli.ts', 'ops script');
    assert((pkg.scripts.test ?? '').includes('test/long-running-service-boundary.ts && tsx test/operator-ui-service.ts'), 'aggregate order');

    const source = `${read('src/ops/operator-ui-service.ts')}\n${read('src/ops/operator-ui-service-cli.ts')}`;
    const combined = [
      source,
      read('docker-compose.unraid.yml'),
      read('docker-compose.unraid.runtime.yml'),
      read('docs/PHASE_147_OPERATOR_UI_SERVICE.md'),
      read('README.md'),
    ].join('\n');
    for (const required of [
      'phase-147-operator-ui-service',
      'ops:operator-ui-server',
      'operator_ui_token',
      '8099:8099',
      'read-only-first',
      'local-admin-token-file',
      'redacted-system-operation-connector',
      'OPERATOR_UI_TOKEN_FILE',
      '/run/secrets/operator_ui_token',
      '/mnt/user/appdata/catalog/secrets/operator_ui_token',
    ]) assert(combined.includes(required), `surface includes ${required}`);
    for (const forbidden of [
      '@torbox/torbox-api',
      'ProviderAdapter',
      'TorBoxReadOnlyClient',
      'JellyfinHttpClient',
      'execSync',
      'spawnSync',
      'request-download-link',
      'magnet:',
      'torrent',
    ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  });
}

await main();

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
