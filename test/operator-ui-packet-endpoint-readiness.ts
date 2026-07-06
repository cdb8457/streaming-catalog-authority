import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
  startOperatorUiStaticRuntime,
} from '../src/ops/operator-ui-static-runtime.js';
import {
  buildOperatorUiPacketEndpointReadinessReport,
  formatOperatorUiPacketEndpointReadinessText,
  type OperatorUiPacketEndpointReadinessReport,
} from '../src/ops/operator-ui-packet-endpoint-readiness.js';

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
const source = read('src/ops/operator-ui-packet-endpoint-readiness.ts');
const cliSource = read('src/ops/operator-ui-packet-endpoint-readiness-cli.ts');
const documentedNpmJsonCommand = 'npm run --silent ops:operator-ui-packet-endpoint-readiness -- -- --json';

const expectedReport: OperatorUiPacketEndpointReadinessReport = {
  ok: true,
  code: 'OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED',
  message: 'Operator UI packet endpoint readiness preflight is fixed, static, no-input, and not-ready.',
  reportName: 'operator-ui-packet-endpoint-readiness',
  reportVersion: 'phase-75.v1',
  status: {
    overall: 'not-ready',
    phase: 'preflight-only',
  },
  blockedEndpoint: {
    id: 'sanitized-local-packet-endpoint',
    status: 'blocked/not-implemented',
    reason: 'endpoint and runtime auth are not implemented',
  },
  dependencyChecks: [
    {
      id: 'phase-69-packet-source-contract',
      status: 'contract-present/endpoint-not-implemented',
      evidence: 'Phase 69 packet source contract exists (OPERATOR_UI_PACKET_SOURCE_CONTRACT_REPORTED); sanitized local packet endpoint remains allowed-future-source/not-implemented.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'phase-74-auth-access-contract',
      status: 'contract-present/auth-not-implemented',
      evidence: 'Phase 74 auth/access contract exists (OPERATOR_UI_AUTH_ACCESS_CONTRACT_REPORTED); auth implementation remains not-implemented.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'static-runtime-route-surface',
      status: 'fixed-route-surface-only',
      evidence: 'Static runtime route surface remains only GET /, GET /healthz, GET /manifest.json.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'sanitized-local-packet-endpoint',
      status: 'blocked/not-implemented',
      evidence: 'Sanitized local packet endpoint remains blocked.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'direct-ui-db-reads',
      status: 'forbidden',
      evidence: 'Direct UI DB reads remain forbidden.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'provider-availability',
      status: 'packet-count-advisory-only',
      evidence: 'Provider availability remains packet/count/advisory only.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'o4-o5-production-boundaries',
      status: 'open-deferred-unless-separately-proven',
      evidence: 'O4/O5 remain open/deferred unless separately proven.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'file-custodian-boundary',
      status: 'reference-harness-only',
      evidence: 'FileCustodian remains reference harness only.',
      requiredBeforeEndpoint: true,
    },
  ],
  staticRuntimeRouteSurface: [
    'GET /',
    'GET /healthz',
    'GET /manifest.json',
  ],
  futureImplementationPrerequisites: [
    'explicit Clint authorization and reviewer GO',
    'auth/access implementation phase completed and reviewed',
    'endpoint source must consume only sanitized redaction-safe operator packets',
    'no real titles, external IDs, provider names/logos, raw refs, infohashes, magnets, credentials, paths, artwork, user library data, or raw event payloads',
    'no provider calls, playback/download/scraping/media-server logic, direct DB access, or live packet ingestion',
    'route/method/body/raw-target hardening retained',
    'size/rate bounds defined before endpoint exists',
    'evidence/redaction tests added before any endpoint route is exposed',
  ],
  forbiddenRoutesNow: [
    '/api/*',
    '/packets',
    '/packet',
    '/operator-packets',
    '/data',
    '/events',
    '/catalog',
    '/items',
    '/auth',
    '/login',
    '/session',
    '/token',
    '/callback',
    '/logout',
    '/oauth',
    '/sso',
    '/admin',
  ],
  forbiddenRuntimeAdditionsNow: [
    'route handlers',
    'API framework',
    'DB/env/fs reads',
    'fetch/network calls',
    'provider integration',
    'browser JS/framework',
    'cookies/sessions/tokens',
    'provider calls, playback/download/scraping/media-server logic',
  ],
  forbiddenDataCategories: [
    'real titles',
    'external IDs',
    'provider names/logos',
    'raw refs',
    'infohashes',
    'magnets',
    'credentials',
    'paths',
    'artwork',
    'user library data',
    'raw event payloads',
  ],
  retainedHardeningRequirements: [
    'static runtime route surface remains only GET /, GET /healthz, GET /manifest.json',
    'blocked packet/data/auth paths return fixed 404 responses',
    'known routes reject unsupported methods with fixed 405 responses',
    'request bodies are ignored and never echoed',
    'raw request-target bypass forms remain fixed 404',
  ],
  openBoundaries: [
    'O4 remains open/deferred unless separately proven',
    'O5 remains open/deferred unless separately proven',
    'FileCustodian remains a hardened reference harness only',
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

function assertNoEndpointRuntimeExpansionSource(combined: string): void {
  for (const forbidden of [
    'process.env',
    "from 'node:fs'",
    'from "node:fs"',
    'readFileSync',
    'readdirSync',
    'existsSync',
    "from 'node:http'",
    'from "node:http"',
    "from 'node:https'",
    "from 'node:net'",
    "from 'node:tls'",
    "from 'node:dns'",
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'from "pg"',
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'createServer',
    'server.listen',
    'app.get',
    'router.',
    'handleRequest',
    'req.headers',
    'res.end',
    'express',
    'fastify',
    'koa',
    'react',
    'vite',
    'next',
    'document.',
    'window.',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    '.headers.authorization',
    "headers['authorization']",
    'getHeader',
    'setHeader',
    'parseCookie',
    'cookieParser',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'createAdapter',
    'writeFile',
    'createWriteStream',
  ]) assert(!combined.includes(forbidden), `source excludes ${forbidden}`);
}

async function main(): Promise<void> {
  console.log('Running Phase 75 operator UI packet endpoint readiness suite:\n');

  await test('readiness preflight report is deterministic, fixed, and no-input', () => {
    const first = buildOperatorUiPacketEndpointReadinessReport();
    const second = buildOperatorUiPacketEndpointReadinessReport();
    assert(JSON.stringify(first) === JSON.stringify(expectedReport), 'first report matches expected object');
    assert(JSON.stringify(second) === JSON.stringify(expectedReport), 'second report matches expected object');
    assert(JSON.stringify(first) === JSON.stringify(second), 'reports serialize deterministically');
    assert(JSON.stringify(Object.keys(first)) === JSON.stringify([
      'ok',
      'code',
      'message',
      'reportName',
      'reportVersion',
      'status',
      'blockedEndpoint',
      'dependencyChecks',
      'staticRuntimeRouteSurface',
      'futureImplementationPrerequisites',
      'forbiddenRoutesNow',
      'forbiddenRuntimeAdditionsNow',
      'forbiddenDataCategories',
      'retainedHardeningRequirements',
      'openBoundaries',
    ]), 'key ordering is fixed');
  });

  await test('builder returns defensive copies for arrays and nested report objects', () => {
    const report = buildOperatorUiPacketEndpointReadinessReport();
    (report.status as unknown as { overall: string }).overall = 'ready';
    (report.blockedEndpoint as unknown as { status: string }).status = 'implemented';
    (report.dependencyChecks as unknown as Array<{ id: string }>)[0] = { id: 'mutated' };
    (report.staticRuntimeRouteSurface as unknown as string[]).push('GET /packets');
    (report.futureImplementationPrerequisites as unknown as string[]).push('mutated');
    (report.forbiddenRoutesNow as unknown as string[]).push('/mutated');
    (report.forbiddenRuntimeAdditionsNow as unknown as string[]).push('mutated');
    (report.forbiddenDataCategories as unknown as string[]).push('mutated');
    (report.retainedHardeningRequirements as unknown as string[]).push('mutated');
    (report.openBoundaries as unknown as string[]).push('mutated');
    assert(JSON.stringify(buildOperatorUiPacketEndpointReadinessReport()) === JSON.stringify(expectedReport), 'fresh report is not affected by mutation');
  });

  await test('overall status remains not-ready and preflight-only', () => {
    const report = buildOperatorUiPacketEndpointReadinessReport();
    assert(report.reportName === 'operator-ui-packet-endpoint-readiness', 'fixed report name');
    assert(report.reportVersion === 'phase-75.v1', 'fixed report version');
    assert(report.code === 'OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED', 'fixed report code');
    assert(report.status.overall === 'not-ready', 'overall not-ready');
    assert(report.status.phase === 'preflight-only', 'phase preflight-only');
    assert(report.blockedEndpoint.status === 'blocked/not-implemented', 'endpoint blocked');
    assert(report.blockedEndpoint.reason === 'endpoint and runtime auth are not implemented', 'endpoint/auth not implemented');
  });

  await test('Phase 69 and Phase 74 contracts are prerequisites but not implementations', () => {
    const byId = new Map(buildOperatorUiPacketEndpointReadinessReport().dependencyChecks.map((check) => [check.id, check]));
    assert(byId.get('phase-69-packet-source-contract')?.status === 'contract-present/endpoint-not-implemented', 'Phase 69 endpoint not implemented');
    assert(byId.get('phase-69-packet-source-contract')?.evidence.includes('OPERATOR_UI_PACKET_SOURCE_CONTRACT_REPORTED'), 'Phase 69 evidence code');
    assert(byId.get('phase-74-auth-access-contract')?.status === 'contract-present/auth-not-implemented', 'Phase 74 auth not implemented');
    assert(byId.get('phase-74-auth-access-contract')?.evidence.includes('OPERATOR_UI_AUTH_ACCESS_CONTRACT_REPORTED'), 'Phase 74 evidence code');
  });

  await test('required future implementation gates are explicit before any endpoint', () => {
    const json = JSON.stringify(buildOperatorUiPacketEndpointReadinessReport());
    for (const required of [
      'explicit Clint authorization and reviewer GO',
      'auth/access implementation phase completed and reviewed',
      'endpoint source must consume only sanitized redaction-safe operator packets',
      'no real titles, external IDs, provider names/logos, raw refs, infohashes, magnets, credentials, paths, artwork, user library data, or raw event payloads',
      'no provider calls, playback/download/scraping/media-server logic, direct DB access, or live packet ingestion',
      'route/method/body/raw-target hardening retained',
      'size/rate bounds defined before endpoint exists',
      'evidence/redaction tests added before any endpoint route is exposed',
    ]) assert(json.includes(required), `future gate includes ${required}`);
  });

  await test('forbidden routes and runtime additions are fixed data', () => {
    const report = buildOperatorUiPacketEndpointReadinessReport();
    for (const route of ['/api/*', '/packets', '/packet', '/operator-packets', '/data', '/events', '/catalog', '/items', '/auth', '/login', '/session', '/token']) {
      assert(report.forbiddenRoutesNow.includes(route), `forbids ${route}`);
    }
    for (const addition of ['route handlers', 'API framework', 'DB/env/fs reads', 'fetch/network calls', 'provider integration', 'browser JS/framework', 'cookies/sessions/tokens']) {
      assert(report.forbiddenRuntimeAdditionsNow.includes(addition), `forbids ${addition}`);
    }
  });

  await test('text output is deterministic and parseable', () => {
    const first = formatOperatorUiPacketEndpointReadinessText();
    const second = formatOperatorUiPacketEndpointReadinessText();
    assert(first === second, 'text is deterministic');
    for (const line of [
      'Operator UI Packet Endpoint Readiness Preflight',
      'report: operator-ui-packet-endpoint-readiness',
      'version: phase-75.v1',
      'status: not-ready / preflight-only',
      'blocked endpoint: sanitized-local-packet-endpoint - blocked/not-implemented',
      '- phase-69-packet-source-contract: contract-present/endpoint-not-implemented',
      '- phase-74-auth-access-contract: contract-present/auth-not-implemented',
      '- static-runtime-route-surface: fixed-route-surface-only',
      '- /api/*',
      '- /operator-packets',
      '- GET /manifest.json',
    ]) assert(first.includes(line), `text includes ${line}`);
    assert(first.endsWith('\n'), 'text ends with newline');
  });

  await test('--json CLI output is parseable, fixed, and ignores hostile env values', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-packet-endpoint-readiness-cli.ts', '--json'], {
      cwd: root,
      env: {
        ...process.env,
        TOKEN: 'SECRET_TOKEN_SENTINEL',
        PRIVATE_TITLE: 'Private Movie Sentinel',
        DATABASE_URL: 'postgres://user:pass@example.invalid/db',
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as OperatorUiPacketEndpointReadinessReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedReport), 'json output matches fixed preflight');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
      assert(!output.includes(sentinel), `json omits hostile input ${sentinel}`);
    }
  });

  await test('documented npm JSON command output is parseable and redaction-safe', () => {
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
    const parsed = JSON.parse(output) as OperatorUiPacketEndpointReadinessReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedReport), 'documented npm json matches fixed preflight');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
      assert(!output.includes(sentinel), `documented json omits hostile input ${sentinel}`);
    }
  });

  await test('text CLI output is formatter output', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-packet-endpoint-readiness-cli.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert(output === formatOperatorUiPacketEndpointReadinessText(), 'CLI prints formatter output');
    assert(output.includes('status: not-ready / preflight-only'), 'CLI text includes status');
  });

  await test('source and CLI have no env/file/network/DB/server/route-handler execution scope', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
      assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
    }
    assert(pkg.scripts['test:operator-ui-packet-endpoint-readiness'] === 'tsx test/operator-ui-packet-endpoint-readiness.ts', 'test script');
    assert(pkg.scripts['ops:operator-ui-packet-endpoint-readiness'] === 'tsx src/ops/operator-ui-packet-endpoint-readiness-cli.ts', 'ops script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-auth-access-contract.ts && tsx test/operator-ui-packet-endpoint-readiness.ts'),
      'Phase 75 suite follows Phase 74 auth/access contract',
    );
    assertNoEndpointRuntimeExpansionSource(`${source}\n${cliSource}`);
  });

  await test('static runtime route surface remains root, health, and manifest only', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/', '/healthz', '/manifest.json']) {
        const response = await httpRequest(runtime.port, path);
        assert(response.statusCode === 200, `${path} remains served`);
      }

      for (const path of ['/api/packets', '/packets', '/packet', '/operator-packets', '/data', '/events', '/catalog', '/items', '/auth', '/login', '/session', '/token']) {
        const get = await httpRequest(runtime.port, path);
        const post = await httpRequest(runtime.port, path, 'POST', 'SECRET_TOKEN_SENTINEL=must-not-leak');
        const head = await httpRequest(runtime.port, path, 'HEAD');
        assert(get.statusCode === 404, `${path} GET fixed 404`);
        assert(get.body === 'not found\n', `${path} GET fixed body`);
        assert(post.statusCode === 404, `${path} POST fixed 404`);
        assert(post.body === 'not found\n', `${path} POST fixed body`);
        assert(head.statusCode === 404, `${path} HEAD fixed 404`);
        assert(head.body === '', `${path} HEAD empty body`);
        assert(!post.body.includes('SECRET_TOKEN_SENTINEL'), `${path} no body echo`);
      }
    } finally {
      await runtime.close();
    }
  });

  await test('known routes keep method/body hardening before any endpoint exists', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/', '/healthz', '/manifest.json']) {
        const head = await httpRequest(runtime.port, path, 'HEAD');
        assert(head.statusCode === 405, `${path} HEAD fixed 405`);
        assert(head.headers.allow === 'GET', `${path} HEAD Allow GET`);
        assert(head.body === '', `${path} HEAD empty body`);
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
          const response = await httpRequest(runtime.port, path, method, 'token=SECRET_TOKEN_SENTINEL');
          assert(response.statusCode === 405, `${path} ${method} fixed 405`);
          assert(response.headers.allow === 'GET', `${path} ${method} Allow GET`);
          assert(response.body === 'method not allowed\n', `${path} ${method} fixed body`);
          assert(!response.body.includes('SECRET_TOKEN_SENTINEL'), `${path} ${method} no body echo`);
        }
      }
    } finally {
      await runtime.close();
    }
  });

  await test('raw request-target bypass forms around packet/data/auth paths stay fixed 404', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const target of [
        'http://evil/api/packets',
        'https://evil/packet',
        '//evil/operator-packets',
        '///data',
        '/api%2fpackets',
        '/catalog%5c..',
        '/items/%2e%2e',
        '/auth\\..',
        '/login/%2e',
      ]) {
        const response = await rawHttpRequest(runtime.port, target, 'POST', 'SECRET_TOKEN_SENTINEL=must-not-leak');
        assert(response.statusCode === 404, `${target} status 404`);
        assert(response.body === 'not found\n', `${target} fixed body`);
        assert(!response.body.includes('SECRET_TOKEN_SENTINEL'), `${target} no body echo`);
      }
    } finally {
      await runtime.close();
    }
  });

  await test('docs, README, and deploy guard mention Phase 75 readiness preflight', () => {
    const combined = `${read('docs/PHASE_75_OPERATOR_UI_PACKET_ENDPOINT_READINESS.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
    for (const kw of [
      'Phase 75',
      'Sanitized Packet Endpoint Readiness Preflight',
      'operator UI packet endpoint readiness',
      'ops:operator-ui-packet-endpoint-readiness',
      'test:operator-ui-packet-endpoint-readiness',
      documentedNpmJsonCommand,
      'operator-ui-packet-endpoint-readiness',
      'phase-75.v1',
      'OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED',
      'not-ready',
      'preflight-only',
      'Phase 69 packet source contract exists but endpoint is not implemented',
      'Phase 74 auth/access contract exists but auth is not implemented',
      'GET /manifest.json',
      'sanitized local packet endpoint remains blocked',
      'direct UI DB reads remain forbidden',
      'Provider availability remains packet/count/advisory only',
      'O4/O5 remain open/deferred unless separately proven',
      'FileCustodian remains reference harness only',
      'explicit Clint authorization and reviewer GO',
      'auth/access implementation phase completed and reviewed',
      'endpoint source must consume only sanitized redaction-safe operator packets',
      'no real titles, external IDs, provider names/logos, raw refs, infohashes, magnets, credentials, paths, artwork, user library data, or raw event payloads',
      'no provider calls, playback/download/scraping/media-server logic, direct DB access, or live packet ingestion',
      'route/method/body/raw-target hardening retained',
      'size/rate bounds defined before endpoint exists',
      'evidence/redaction tests added before any endpoint route is exposed',
      '/api/*',
      '/operator-packets',
      'route handlers',
      'API framework',
      'DB/env/fs reads',
      'fetch/network calls',
      'browser JS/framework',
      'cookies/sessions/tokens',
    ]) assert(combined.includes(kw), `Phase 75 docs/deploy include ${kw}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
