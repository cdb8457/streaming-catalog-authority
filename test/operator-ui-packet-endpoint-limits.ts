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
  buildOperatorUiPacketEndpointLimitsReport,
  formatOperatorUiPacketEndpointLimitsText,
  type OperatorUiPacketEndpointLimitsReport,
} from '../src/ops/operator-ui-packet-endpoint-limits.js';

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
const source = read('src/ops/operator-ui-packet-endpoint-limits.ts');
const cliSource = read('src/ops/operator-ui-packet-endpoint-limits-cli.ts');
const documentedNpmJsonCommand = 'npm run --silent ops:operator-ui-packet-endpoint-limits -- -- --json';

const expectedReport: OperatorUiPacketEndpointLimitsReport = {
  ok: true,
  code: 'OPERATOR_UI_PACKET_ENDPOINT_LIMITS_REPORTED',
  message: 'Operator UI packet endpoint limits are fixed contract data only; the endpoint remains not implemented.',
  reportName: 'operator-ui-packet-endpoint-limits',
  reportVersion: 'phase-76.v1',
  status: {
    overall: 'not-implemented',
    phase: 'contract-only',
  },
  blockedEndpoint: {
    id: 'sanitized-local-packet-endpoint',
    status: 'not-implemented',
    reason: 'endpoint, auth, runtime enforcement, counters, and evidence tests are not implemented',
  },
  phase75Readiness: {
    reportName: 'operator-ui-packet-endpoint-readiness',
    reportVersion: 'phase-75.v1',
    code: 'OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED',
    status: 'not-ready',
    requirement: 'Phase 75 readiness remains not-ready until endpoint/auth implementation and evidence tests exist',
  },
  methodRules: [
    {
      method: 'GET',
      disposition: 'future-only-allowed',
      response: 'only GET may ever serve packet snapshots in the first implementation',
    },
    {
      method: 'HEAD',
      disposition: 'rejected-unless-reviewed',
      response: 'HEAD remains rejected unless explicitly reviewed',
    },
    {
      method: 'POST',
      disposition: 'rejected',
      response: 'fixed sanitized rejection',
    },
    {
      method: 'PUT',
      disposition: 'rejected',
      response: 'fixed sanitized rejection',
    },
    {
      method: 'PATCH',
      disposition: 'rejected',
      response: 'fixed sanitized rejection',
    },
    {
      method: 'DELETE',
      disposition: 'rejected',
      response: 'fixed sanitized rejection',
    },
    {
      method: 'OPTIONS',
      disposition: 'rejected',
      response: 'fixed sanitized rejection',
    },
    {
      method: 'OTHER',
      disposition: 'rejected',
      response: 'fixed sanitized rejection',
    },
  ],
  requestBodyRule: 'request bodies are ignored/rejected and never echoed',
  sizeLimits: {
    maxRequestTargetBytes: 2048,
    maxHeaderCount: 64,
    maxRequestBodyBytes: 0,
    maxResponseBytes: 262144,
    maxPacketCount: 64,
    maxStringFieldBytes: 256,
    maxArrayLengthPerField: 64,
  },
  rateLimits: {
    scope: 'loopback-preview-only',
    maxRequestsPerMinutePerOperatorRuntimeProcess: 60,
    burstSize: 10,
    remoteOrIpTrust: 'none',
    persistenceOrCountersImplemented: false,
  },
  failureBehavior: [
    {
      statusCode: 404,
      appliesTo: 'unknown or blocked routes before and after endpoint review',
      response: 'fixed not-found response',
    },
    {
      statusCode: 405,
      appliesTo: 'unsupported known-route methods only after endpoint exists',
      response: 'fixed method-not-allowed response with Allow: GET',
    },
    {
      statusCode: 413,
      appliesTo: 'oversized request or response cases when endpoint is later implemented',
      response: 'fixed payload-too-large response',
    },
    {
      statusCode: 429,
      appliesTo: 'future rate-limit trips',
      response: 'fixed rate-limit response',
    },
  ],
  neverEcho: [
    'paths',
    'query strings',
    'headers',
    'body snippets',
    'credentials',
    'raw refs',
    'packet contents',
    'provider details',
    'DB errors',
  ],
  retainedHardeningRequirements: [
    'raw target bypass closed',
    'query strings cannot create behavior',
    'safe headers retained',
    'no browser JS/framework requirement',
    'no direct DB read',
    'no provider calls',
    'no playback/download/scraping/media-server behavior',
    'no live packet ingestion',
  ],
  forbiddenImplementationThisPhase: [
    'endpoint route',
    'runtime enforcement',
    'auth',
    'rate counters',
    'DB reads',
    'provider behavior',
    'UI/framework code',
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

function assertNoEndpointImplementationScope(combined: string): void {
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
  console.log('Running Phase 76 operator UI packet endpoint limits suite:\n');

  await test('limits report is deterministic, fixed, no-input, and defensively copied', () => {
    const first = buildOperatorUiPacketEndpointLimitsReport();
    const second = buildOperatorUiPacketEndpointLimitsReport();
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
      'phase75Readiness',
      'methodRules',
      'requestBodyRule',
      'sizeLimits',
      'rateLimits',
      'failureBehavior',
      'neverEcho',
      'retainedHardeningRequirements',
      'forbiddenImplementationThisPhase',
    ]), 'key ordering is fixed');

    (first.status as unknown as { overall: string }).overall = 'ready';
    (first.blockedEndpoint as unknown as { status: string }).status = 'implemented';
    (first.phase75Readiness as unknown as { status: string }).status = 'ready';
    (first.methodRules as unknown as Array<{ method: string }>)[0] = { method: 'MUTATED' };
    (first.sizeLimits as unknown as { maxPacketCount: number }).maxPacketCount = 999;
    (first.rateLimits as unknown as { burstSize: number }).burstSize = 999;
    (first.failureBehavior as unknown as Array<{ statusCode: number }>)[0] = { statusCode: 200 };
    (first.neverEcho as unknown as string[]).push('mutated');
    (first.retainedHardeningRequirements as unknown as string[]).push('mutated');
    (first.forbiddenImplementationThisPhase as unknown as string[]).push('mutated');
    assert(JSON.stringify(buildOperatorUiPacketEndpointLimitsReport()) === JSON.stringify(expectedReport), 'fresh report is not affected by mutation');
  });

  await test('status remains contract-only and endpoint remains blocked', () => {
    const report = buildOperatorUiPacketEndpointLimitsReport();
    assert(report.reportName === 'operator-ui-packet-endpoint-limits', 'fixed report name');
    assert(report.reportVersion === 'phase-76.v1', 'fixed report version');
    assert(report.code === 'OPERATOR_UI_PACKET_ENDPOINT_LIMITS_REPORTED', 'fixed report code');
    assert(report.status.overall === 'not-implemented', 'overall not-implemented');
    assert(report.status.phase === 'contract-only', 'phase contract-only');
    assert(report.blockedEndpoint.id === 'sanitized-local-packet-endpoint', 'sanitized endpoint id');
    assert(report.blockedEndpoint.status === 'not-implemented', 'endpoint not implemented');
    assert(report.phase75Readiness.status === 'not-ready', 'Phase 75 remains not-ready');
    assert(report.phase75Readiness.requirement.includes('endpoint/auth implementation and evidence tests'), 'Phase 75 readiness caveat');
  });

  await test('method rules reject everything except future reviewed GET snapshots', () => {
    const byMethod = new Map(buildOperatorUiPacketEndpointLimitsReport().methodRules.map((rule) => [rule.method, rule]));
    assert(byMethod.get('GET')?.disposition === 'future-only-allowed', 'GET is future-only allowed');
    assert(byMethod.get('GET')?.response.includes('first implementation'), 'GET packet snapshot caveat');
    assert(byMethod.get('HEAD')?.disposition === 'rejected-unless-reviewed', 'HEAD stays rejected until review');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] as const) {
      assert(byMethod.get(method)?.disposition === 'rejected', `${method} rejected`);
      assert(byMethod.get(method)?.response === 'fixed sanitized rejection', `${method} fixed sanitized response`);
    }
    assert(buildOperatorUiPacketEndpointLimitsReport().requestBodyRule === 'request bodies are ignored/rejected and never echoed', 'request bodies never echoed');
  });

  await test('numeric size and rate limits are exact and conservative', () => {
    const report = buildOperatorUiPacketEndpointLimitsReport();
    assert(report.sizeLimits.maxRequestTargetBytes === 2048, 'max request target bytes');
    assert(report.sizeLimits.maxHeaderCount === 64, 'max header count aligns runtime cap');
    assert(report.sizeLimits.maxRequestBodyBytes === 0, 'GET-only body bytes');
    assert(report.sizeLimits.maxResponseBytes === 262144, 'max response bytes 256 KiB');
    assert(report.sizeLimits.maxPacketCount === 64, 'max packet count');
    assert(report.sizeLimits.maxStringFieldBytes === 256, 'max string field bytes');
    assert(report.sizeLimits.maxArrayLengthPerField === 64, 'max array length per field');
    assert(report.rateLimits.scope === 'loopback-preview-only', 'loopback preview only');
    assert(report.rateLimits.maxRequestsPerMinutePerOperatorRuntimeProcess === 60, 'requests per minute');
    assert(report.rateLimits.burstSize === 10, 'burst size');
    assert(report.rateLimits.remoteOrIpTrust === 'none', 'no remote/IP trust');
    assert(report.rateLimits.persistenceOrCountersImplemented === false, 'no persistence/counters implemented');
  });

  await test('future failure behavior is fixed and redaction-safe', () => {
    const report = buildOperatorUiPacketEndpointLimitsReport();
    const byStatus = new Map(report.failureBehavior.map((rule) => [rule.statusCode, rule]));
    assert(byStatus.get(404)?.appliesTo === 'unknown or blocked routes before and after endpoint review', '404 fixed for unknown/blocked');
    assert(byStatus.get(405)?.response === 'fixed method-not-allowed response with Allow: GET', '405 Allow GET after endpoint exists');
    assert(byStatus.get(413)?.appliesTo === 'oversized request or response cases when endpoint is later implemented', '413 oversized');
    assert(byStatus.get(429)?.appliesTo === 'future rate-limit trips', '429 rate trips');
    for (const category of ['paths', 'query strings', 'headers', 'body snippets', 'credentials', 'raw refs', 'packet contents', 'provider details', 'DB errors']) {
      assert(report.neverEcho.includes(category), `never echoes ${category}`);
    }
  });

  await test('retained hardening and forbidden implementation scope are explicit', () => {
    const report = buildOperatorUiPacketEndpointLimitsReport();
    for (const requirement of [
      'raw target bypass closed',
      'query strings cannot create behavior',
      'safe headers retained',
      'no browser JS/framework requirement',
      'no direct DB read',
      'no provider calls',
      'no playback/download/scraping/media-server behavior',
      'no live packet ingestion',
    ]) assert(report.retainedHardeningRequirements.includes(requirement), `retains ${requirement}`);
    for (const forbidden of ['endpoint route', 'runtime enforcement', 'auth', 'rate counters', 'DB reads', 'provider behavior', 'UI/framework code']) {
      assert(report.forbiddenImplementationThisPhase.includes(forbidden), `forbids ${forbidden}`);
    }
  });

  await test('text output is deterministic and parseable', () => {
    const first = formatOperatorUiPacketEndpointLimitsText();
    const second = formatOperatorUiPacketEndpointLimitsText();
    assert(first === second, 'text is deterministic');
    for (const line of [
      'Operator UI Packet Endpoint Limits Contract',
      'report: operator-ui-packet-endpoint-limits',
      'version: phase-76.v1',
      'status: not-implemented / contract-only',
      'blocked endpoint: sanitized-local-packet-endpoint - not-implemented',
      'phase 75 readiness: not-ready - Phase 75 readiness remains not-ready until endpoint/auth implementation and evidence tests exist',
      '- GET: future-only-allowed; only GET may ever serve packet snapshots in the first implementation',
      '- HEAD: rejected-unless-reviewed; HEAD remains rejected unless explicitly reviewed',
      '- maxRequestTargetBytes: 2048',
      '- maxResponseBytes: 262144',
      '- maxRequestsPerMinutePerOperatorRuntimeProcess: 60',
      '- 405: unsupported known-route methods only after endpoint exists; fixed method-not-allowed response with Allow: GET',
      '- packet contents',
      '- no live packet ingestion',
    ]) assert(first.includes(line), `text includes ${line}`);
    assert(first.endsWith('\n'), 'text ends with newline');
  });

  await test('--json CLI output is parseable, fixed, and ignores hostile env values', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-packet-endpoint-limits-cli.ts', '--json'], {
      cwd: root,
      env: {
        ...process.env,
        TOKEN: 'SECRET_TOKEN_SENTINEL',
        PRIVATE_TITLE: 'Private Movie Sentinel',
        DATABASE_URL: 'postgres://user:pass@example.invalid/db',
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as OperatorUiPacketEndpointLimitsReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedReport), 'json output matches fixed limits contract');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
      assert(!output.includes(sentinel), `json omits hostile input ${sentinel}`);
    }
  });

  await test('documented npm JSON command output is parseable and fixed', () => {
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
    const parsed = JSON.parse(output) as OperatorUiPacketEndpointLimitsReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedReport), 'documented npm json matches fixed limits contract');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
      assert(!output.includes(sentinel), `documented json omits hostile input ${sentinel}`);
    }
  });

  await test('text CLI output is formatter output', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-packet-endpoint-limits-cli.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert(output === formatOperatorUiPacketEndpointLimitsText(), 'CLI prints formatter output');
    assert(output.includes('status: not-implemented / contract-only'), 'CLI text includes status');
  });

  await test('source and CLI have no runtime, endpoint, DB, provider, or UI implementation scope', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
      assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
    }
    assert(pkg.scripts['test:operator-ui-packet-endpoint-limits'] === 'tsx test/operator-ui-packet-endpoint-limits.ts', 'test script');
    assert(pkg.scripts['ops:operator-ui-packet-endpoint-limits'] === 'tsx src/ops/operator-ui-packet-endpoint-limits-cli.ts', 'ops script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-packet-endpoint-readiness.ts && tsx test/operator-ui-packet-endpoint-limits.ts'),
      'Phase 76 suite follows Phase 75 packet endpoint readiness',
    );
    assertNoEndpointImplementationScope(`${source}\n${cliSource}`);
  });

  await test('static runtime route surface remains only root, health, and manifest', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/', '/healthz', '/manifest.json']) {
        const response = await httpRequest(runtime.port, path);
        assert(response.statusCode === 200, `${path} remains served`);
      }

      for (const path of ['/api/packets', '/packets', '/packet', '/operator-packets', '/data', '/events', '/catalog', '/items', '/auth', '/login', '/session', '/token']) {
        const get = await httpRequest(runtime.port, path);
        const post = await httpRequest(runtime.port, path, 'POST', 'SECRET_TOKEN_SENTINEL=must-not-leak');
        const options = await httpRequest(runtime.port, path, 'OPTIONS');
        assert(get.statusCode === 404, `${path} GET fixed 404`);
        assert(get.body === 'not found\n', `${path} GET fixed body`);
        assert(post.statusCode === 404, `${path} POST fixed 404`);
        assert(post.body === 'not found\n', `${path} POST fixed body`);
        assert(options.statusCode === 404, `${path} OPTIONS fixed 404`);
        assert(options.body === 'not found\n', `${path} OPTIONS fixed body`);
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
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
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

  await test('docs, README, and deploy guard mention Phase 76 limits contract', () => {
    const combined = `${read('docs/PHASE_76_OPERATOR_UI_PACKET_ENDPOINT_LIMITS.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
    for (const kw of [
      'Phase 76',
      'Packet Endpoint Limits Contract',
      'operator UI packet endpoint limits',
      'ops:operator-ui-packet-endpoint-limits',
      'test:operator-ui-packet-endpoint-limits',
      documentedNpmJsonCommand,
      'operator-ui-packet-endpoint-limits',
      'phase-76.v1',
      'OPERATOR_UI_PACKET_ENDPOINT_LIMITS_REPORTED',
      'not-implemented',
      'contract-only',
      'sanitized-local-packet-endpoint',
      'only GET may ever serve packet snapshots in the first implementation',
      'HEAD remains rejected unless explicitly reviewed',
      'POST, PUT, PATCH, DELETE, OPTIONS, and other methods rejected with fixed sanitized responses',
      'request bodies ignored/rejected and never echoed',
      'max request target bytes: 2048',
      'max header count: 64',
      'max request body bytes: 0',
      'max response bytes: 262144',
      'max packet count: 64',
      'max string field bytes: 256',
      'max array length per field: 64',
      'loopback preview only',
      'max requests per minute per operator/runtime process: 60',
      'burst size: 10',
      'no remote/IP-based trust yet',
      'no persistence/counters implemented in this phase',
      'fixed 404',
      'fixed 405',
      'Allow: GET',
      'fixed 413',
      'fixed 429',
      'no echoing paths, query strings, headers, body snippets, credentials, raw refs, packet contents, provider details, or DB errors',
      'raw target bypass closed',
      'query strings cannot create behavior',
      'safe headers retained',
      'no browser JS/framework requirement',
      'no direct DB read',
      'no live packet ingestion',
      'Phase 75 readiness remains not-ready until endpoint/auth implementation and evidence tests exist',
    ]) assert(combined.includes(kw), `Phase 76 docs/deploy include ${kw}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
