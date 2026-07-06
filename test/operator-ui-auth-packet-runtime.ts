import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_UI_LOCAL_AUTH_HEADER_DISPLAY,
  OperatorUiLocalAuthRuntimeError,
  loadOperatorUiLocalAuthRuntime,
} from '../src/ops/operator-ui-local-auth-runtime.js';
import { validateOperatorUiFixturePacket } from '../src/ops/operator-ui-fixtures.js';
import {
  OPERATOR_UI_STATIC_RUNTIME_CSP,
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
  buildOperatorUiStaticRuntimeManifest,
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
const validSecret = 'abcdefghijklmnopQRST1234';

function httpRequest(
  port: number,
  path: string,
  method = 'GET',
  body = '',
  secret?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (body.length > 0) headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
    if (secret !== undefined) headers[OPERATOR_UI_LOCAL_AUTH_HEADER_DISPLAY] = secret;
    const req = request({ host: OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST, port, path, method, headers }, (res) => {
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

function assertNoLeak(output: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels.filter((value) => value.length > 0)) {
    assert(!output.includes(sentinel), `leaked ${sentinel}`);
  }
}

function assertAuthRejects(path: string, sentinels: readonly string[]): void {
  try {
    loadOperatorUiLocalAuthRuntime(path);
  } catch (err) {
    assert(err instanceof OperatorUiLocalAuthRuntimeError, 'fixed auth error type');
    const caught = err as Error;
    assertNoLeak(`${caught.message}\n${String(caught.stack ?? '')}`, sentinels);
    return;
  }
  throw new Error('auth secret should have been rejected');
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
      server.close((err) => { if (err) reject(err); else resolve(port); });
    });
  });
}

function stopSpawnedRuntime(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function main(): Promise<void> {
  console.log('Running Phase 81 operator UI auth packet runtime suite:\n');

  await test('secret-file loader is explicit, bounded, validates shape, and redaction-safe', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'phase-81-auth-'));
    try {
      const good = join(tmp, 'good.txt');
      writeFileSync(good, `${validSecret}\n`, 'utf8');
      const loaded = loadOperatorUiLocalAuthRuntime(good);
      assert(loaded.expectedSecretBytes.toString('utf8') === validSecret, 'one trailing newline trimmed');

      const spaces = join(tmp, 'spaces.txt');
      writeFileSync(spaces, ` ${validSecret} \n`, 'utf8');
      assert(loadOperatorUiLocalAuthRuntime(spaces).expectedSecretBytes.toString('utf8') === ` ${validSecret} `, 'other whitespace preserved');

      const twoNewlines = join(tmp, 'two-newlines.txt');
      writeFileSync(twoNewlines, `${validSecret}\n\n`, 'utf8');
      assert(loadOperatorUiLocalAuthRuntime(twoNewlines).expectedSecretBytes.toString('utf8') === `${validSecret}\n`, 'only one newline trimmed');

      const cases: Array<[string, string]> = [
        ['missing.txt', 'missing'],
        ['empty.txt', ''],
        ['short.txt', 'short-secret'],
        ['weak.txt', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        ['space-only.txt', '                         '],
        ['oversized.txt', 'x'.repeat(4097)],
      ];
      for (const [name, value] of cases) {
        const path = join(tmp, name);
        if (name !== 'missing.txt') writeFileSync(path, value, 'utf8');
        assertAuthRejects(path, [path, tmp, value]);
      }
      assertAuthRejects(tmp, [tmp]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('runtime without explicit secret file preserves disabled packet endpoint state', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const manifest = await httpRequest(runtime.port, '/manifest.json');
      const packets = await httpRequest(runtime.port, '/operator-ui/packets.json');
      assert(manifest.statusCode === 200, 'manifest served');
      assert(manifest.body === `${JSON.stringify(buildOperatorUiStaticRuntimeManifest())}\n`, 'default manifest unchanged');
      assert(!manifest.body.includes('operator-secret-file'), 'manifest omits file path label');
      assert(packets.statusCode === 404, 'packet endpoint disabled without secret file');
      assert(packets.body === 'not found\n', 'disabled endpoint fixed 404');
    } finally {
      await runtime.close();
    }
  });

  await test('auth-gated packet endpoint returns only sanitized fixture packet JSON', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'phase-81-runtime-'));
    const secretFile = join(tmp, 'secret.txt');
    writeFileSync(secretFile, `${validSecret}\n`, 'utf8');
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0, operatorSecretFile: secretFile });
    try {
      const manifest = await httpRequest(runtime.port, '/manifest.json');
      const unauthorized = await httpRequest(runtime.port, '/operator-ui/packets.json');
      const wrong = await httpRequest(runtime.port, '/operator-ui/packets.json', 'GET', '', 'wrong-secret-value-0000');
      const authorized = await httpRequest(runtime.port, '/operator-ui/packets.json', 'GET', '', validSecret);
      assert(manifest.body.includes('"operatorAuth":"local-secret-file-enabled"'), 'manifest auth enabled');
      assert(manifest.body.includes('"packetSource":"sanitized-local-packet-endpoint"'), 'manifest packet source enabled');
      assert(!manifest.body.includes(secretFile) && !manifest.body.includes(tmp), 'manifest omits secret path');

      for (const response of [unauthorized, wrong]) {
        assert(response.statusCode === 401, 'unauthorized fixed 401');
        assert(response.headers['www-authenticate'] === undefined, 'no auth challenge');
        assert(!response.body.includes('packets'), 'unauthorized omits packet data');
        assertNoLeak(response.body, [validSecret, secretFile, tmp, 'wrong-secret-value-0000', OPERATOR_UI_LOCAL_AUTH_HEADER_DISPLAY]);
      }

      assert(authorized.statusCode === 200, 'authorized status');
      const parsed = JSON.parse(authorized.body) as {
        code: string;
        source: string;
        dataMode: string;
        packetCount: number;
        screens: string[];
        packets: Array<{ screenId: string; screenLabel: string; rows: Array<{ cells: unknown[] }> }>;
      };
      assert(parsed.code === 'OPERATOR_UI_SANITIZED_PACKET_SNAPSHOT', 'snapshot code');
      assert(parsed.source === 'operator-ui-fixture-packets', 'fixture source');
      assert(parsed.dataMode === 'synthetic-fixture-only', 'synthetic mode');
      assert(parsed.packetCount === 9 && parsed.packets.length === 9 && parsed.screens.length === 9, 'fixed packet count');
      for (const packet of parsed.packets) assert(validateOperatorUiFixturePacket(packet).ok, `fixture packet ${packet.screenId} validates`);
      assertNoLeak(authorized.body, [
        validSecret,
        secretFile,
        tmp,
        'title',
        'externalId',
        'providerRef',
        'infohash',
        'magnet:',
        'credential',
        'databaseUrl',
        'rawPayload',
        'poster',
        'artwork',
        'library',
        'Real-Debrid',
        'TorBox logo',
        'Plex',
        'Jellyfin',
        'Hermes',
      ]);
    } finally {
      await runtime.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('packet endpoint rejects query-bearing raw targets before auth processing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'phase-81-query-'));
    const secretFile = join(tmp, 'secret.txt');
    writeFileSync(secretFile, `${validSecret}\n`, 'utf8');
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0, operatorSecretFile: secretFile });
    try {
      for (const target of ['/operator-ui/packets.json?secret=SECRET_SENTINEL', '/operator-ui/packets.json?x=1']) {
        const response = await httpRequest(runtime.port, target, 'GET', '', validSecret);
        const transcript = `${JSON.stringify(response.headers)}\n${response.body}`;
        assert(response.statusCode === 404, `${target} fixed 404`);
        assert(response.body === 'not found\n', `${target} fixed body`);
        assert(response.headers.allow === undefined, `${target} no Allow header`);
        assert(response.headers['www-authenticate'] === undefined, `${target} no auth challenge`);
        assert(!response.body.includes('OPERATOR_UI_SANITIZED_PACKET_SNAPSHOT'), `${target} omits snapshot code`);
        assert(!response.body.includes('OPERATOR_UI_PACKET_ENDPOINT_UNAUTHORIZED'), `${target} omits auth failure code`);
        assertNoLeak(transcript, [
          validSecret,
          'SECRET_SENTINEL',
          target,
          '/operator-ui/packets.json',
          'operator-ui-fixture-packets',
          'synthetic-fixture-only',
          'packets',
          secretFile,
          tmp,
        ]);
      }
    } finally {
      await runtime.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('packet endpoint method and raw-target behavior is fixed and redaction-safe', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'phase-81-method-'));
    const secretFile = join(tmp, 'secret.txt');
    writeFileSync(secretFile, validSecret, 'utf8');
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0, operatorSecretFile: secretFile });
    try {
      const head = await httpRequest(runtime.port, '/operator-ui/packets.json', 'HEAD', '', validSecret);
      assert(head.statusCode === 405, 'HEAD fixed 405');
      assert(head.headers.allow === 'GET', 'HEAD Allow GET');
      assert(head.body === '', 'HEAD empty body');

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await httpRequest(runtime.port, '/operator-ui/packets.json', method, `body=${validSecret}`, validSecret);
        assert(response.statusCode === 405, `${method} fixed 405`);
        assert(response.body === 'method not allowed\n', `${method} fixed body`);
        assertNoLeak(response.body, [validSecret, secretFile, tmp]);
      }

      for (const target of ['//evil/operator-ui/packets.json', 'http://evil/operator-ui/packets.json', '/operator-ui/%2e%2e/packets.json', '/operator-ui/packets.json%2f..']) {
        const response = await rawHttpRequest(runtime.port, target, 'GET', validSecret);
        assert(response.statusCode === 404, `${target} fixed 404`);
        assert(response.body === 'not found\n', `${target} fixed body`);
      }
    } finally {
      await runtime.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('CLI flag enables auth only explicitly and errors do not echo path or secret', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'phase-81-cli-'));
    const secretFile = join(tmp, 'secret.txt');
    const missing = join(tmp, 'missing.txt');
    writeFileSync(secretFile, validSecret, 'utf8');
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
      '--operator-secret-file',
      secretFile,
    ], { cwd: root, detached: process.platform !== 'win32', windowsHide: true });
    try {
      const deadline = Date.now() + 10000;
      let response: HttpResult | undefined;
      while (Date.now() < deadline && response === undefined) {
        try {
          const health = await httpRequest(port, '/healthz');
          if (health.statusCode === 200) response = health;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert(response?.statusCode === 200, 'CLI runtime started');
      const packet = await httpRequest(port, '/operator-ui/packets.json', 'GET', '', validSecret);
      assert(packet.statusCode === 200, 'CLI auth endpoint enabled');
    } finally {
      stopSpawnedRuntime(child);
      rmSync(tmp, { recursive: true, force: true });
    }

    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/operator-ui-static-runtime-cli.ts'], {
      cwd: root,
      env: { ...process.env, OPERATOR_SECRET_FILE: secretFile, SECRET_TOKEN_SENTINEL: validSecret },
      encoding: 'utf8',
    });
    assert(output.includes('--operator-secret-file <path>'), 'usage documents explicit flag');
    assertNoLeak(output, [secretFile, tmp, validSecret]);

    try {
      execFileSync(process.execPath, [
        '--import',
        'tsx',
        'src/ops/operator-ui-static-runtime-cli.ts',
        '--serve',
        '--operator-secret-file',
        missing,
      ], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
      throw new Error('missing secret file should fail');
    } catch (err) {
      const outputText = `${(err as { stdout?: Buffer }).stdout?.toString('utf8') ?? ''}\n${(err as { stderr?: Buffer }).stderr?.toString('utf8') ?? ''}`;
      assert(outputText.includes('refused local auth secret file'), 'fixed CLI auth failure');
      assertNoLeak(outputText, [missing, tmp, validSecret]);
    }
  });

  await test('root HTML and source stay inside Phase 81 browser/runtime boundaries', () => {
    const html = read('src/ops/operator-ui-static-prototype.ts');
    const runtime = read('src/ops/operator-ui-static-runtime.ts');
    const cli = read('src/ops/operator-ui-static-runtime-cli.ts');
    const auth = read('src/ops/operator-ui-local-auth-runtime.ts');
    const endpoint = read('src/ops/operator-ui-packet-endpoint.ts');
    const rendered = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/operator-ui-static-prototype-cli.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert(rendered.includes('operator-secret-input'), 'root has local secret input');
    assert(rendered.includes('/operator-ui/packets.json'), 'root fetches packet endpoint');
    assert(OPERATOR_UI_STATIC_RUNTIME_CSP.includes("connect-src 'self'"), 'CSP same-origin connect');
    assert(OPERATOR_UI_STATIC_RUNTIME_CSP.includes("script-src 'sha256-"), 'CSP pins inline script hash');

    for (const combined of [rendered, `${html}\n${runtime}\n${cli}\n${auth}\n${endpoint}`]) {
      for (const forbidden of [
        'localStorage',
        'sessionStorage',
        'Set-Cookie',
        'Authorization',
        'Bearer',
        'Basic',
        '?secret=',
        'password=',
        "from 'pg'",
        'from "pg"',
        'node:https',
        'node:tls',
        'node:dns',
        'express',
        'fastify',
        'koa',
        'react',
        'vite',
        'next',
        'Real-Debrid',
        'TorBoxReadOnlyClient',
        'ProviderAdapter',
        'Plex',
        'Jellyfin',
        'Hermes',
      ]) assert(!combined.includes(forbidden), `boundary excludes ${forbidden}`);
    }
  });

  await test('README, docs, deploy guard, package, and lockfile are wired for Phase 81', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert(pkg.scripts['test:operator-ui-auth-packet-runtime'] === 'tsx test/operator-ui-auth-packet-runtime.ts', 'Phase 81 test script');
    assert((pkg.scripts.test ?? '').includes('test/operator-ui-local-auth-secret-file-preflight.ts && tsx test/operator-ui-auth-packet-runtime.ts'), 'Phase 81 follows Phase 80');
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react']) {
      assert(!allDeps.includes(dep), `no new UI/API dependency ${dep}`);
    }
    const combined = `${read('docs/PHASE_81_OPERATOR_UI_AUTH_PACKET_RUNTIME.md')}\n${read('README.md')}\n${read('test/deploy.ts')}\n${read('package.json')}\n${read('package-lock.json')}`;
    for (const kw of [
      'Phase 81',
      'Local Auth + Sanitized Packet Endpoint + UI Runtime Connection',
      'operator UI auth packet runtime',
      'test:operator-ui-auth-packet-runtime',
      'ops:operator-ui-static-runtime',
      '--operator-secret-file <path>',
      'X-Operator-UI-Secret',
      'GET /operator-ui/packets.json',
      'local-secret-file-enabled',
      'sanitized-local-packet-endpoint',
      'synthetic-fixture-only',
      'no cookies, sessions, bearer/basic auth, OAuth, localStorage, sessionStorage, persistent browser secret storage, query-string secrets, or URL secrets',
      'No DB reads',
      'no provider/debrid/Plex/Jellyfin/Hermes calls',
      'O4 and O5 remain open/deferred',
      'FileCustodian remains a hardened reference harness, not production KMS',
    ]) assert(combined.includes(kw), `Phase 81 wiring includes ${kw}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
