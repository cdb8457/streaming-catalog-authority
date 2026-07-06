import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiPacketEndpointRouteDryRunReport,
  formatOperatorUiPacketEndpointRouteDryRunText,
  type OperatorUiPacketEndpointRouteDryRunReport,
} from '../src/ops/operator-ui-packet-endpoint-route-dry-run.js';
import {
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
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
const source = read('src/ops/operator-ui-packet-endpoint-route-dry-run.ts');
const cliSource = read('src/ops/operator-ui-packet-endpoint-route-dry-run-cli.ts');
const documentedNpmJsonCommand = 'npm run --silent ops:operator-ui-packet-endpoint-route-dry-run -- -- --json';

const expectedReport: OperatorUiPacketEndpointRouteDryRunReport = {
  ok: true,
  code: 'OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN_REPORTED',
  message: 'Operator UI packet endpoint route dry-run plan is blocked and contract-only; no route is exposed or implemented.',
  reportName: 'operator-ui-packet-endpoint-route-dry-run',
  reportVersion: 'phase-78.v1',
  status: {
    overall: 'blocked',
    phase: 'dry-run-plan-only',
  },
  routeExposure: {
    status: 'blocked',
    implementation: 'not-implemented',
  },
  candidateEndpointId: 'sanitized-local-packet-endpoint',
  candidateRoute: 'future-local-packet-snapshot-route',
  phase75Readiness: {
    reportName: 'operator-ui-packet-endpoint-readiness',
    reportVersion: 'phase-75.v1',
    code: 'OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED',
    status: 'not-ready',
  },
  phase76Limits: {
    reportName: 'operator-ui-packet-endpoint-limits',
    reportVersion: 'phase-76.v1',
    code: 'OPERATOR_UI_PACKET_ENDPOINT_LIMITS_REPORTED',
    phase: 'contract-only',
    implementation: 'not-implemented',
  },
  phase77EvidenceGate: {
    reportName: 'operator-ui-packet-endpoint-evidence-gate',
    reportVersion: 'phase-77.v1',
    code: 'OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE_REPORTED',
    status: 'blocked',
    phase: 'evidence-required',
  },
  dryRunPlan: {
    endpointId: 'sanitized-local-packet-endpoint',
    candidateRoute: 'future-local-packet-snapshot-route',
    plannedExposure: 'future local loopback only',
    currentExposure: 'blocked',
    currentImplementation: 'not-implemented',
    firstImplementationMethod: 'GET',
    headBehavior: 'rejected-unless-explicitly-reviewed',
    rejectedMethods: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'],
    rejectedMethodResponse: 'fixed sanitized response',
    requestBodyByteLimit: 0,
    requestTargetMaxBytes: 2048,
    maxHeaderCount: 64,
    maxResponseBytes: 262144,
    maxPacketCount: 64,
    maxStringFieldBytes: 256,
    maxArrayLength: 64,
    futureRatePreview: {
      maxRequestsPerMinutePerOperatorRuntimeProcess: 60,
      burst: 10,
      scope: 'loopback preview only',
      remoteOrIpTrust: 'none',
      countersImplementedNow: false,
    },
    futureFailureBehavior: ['fixed 404', 'fixed 405 with Allow GET only after endpoint exists', 'fixed 413', 'fixed 429'],
    noEchoCategories: [
      'paths',
      'query strings',
      'headers',
      'bodies',
      'credentials',
      'raw refs',
      'packet contents',
      'provider details',
      'DB errors',
    ],
    routeExposurePrerequisite: 'Phase 77 evidence gate must be satisfied and independently reviewed before implementation',
  },
  dryRunSteps: [
    {
      id: 'route-exposure-prerequisite',
      status: 'blocked',
      action: 'Require Phase 77 evidence gate satisfaction and independent review before any route implementation.',
      expectedResult: 'route exposure remains blocked now',
    },
    {
      id: 'future-loopback-route-shape',
      status: 'planned-only',
      action: 'Plan a future local loopback-only sanitized packet snapshot route using the synthetic route label only.',
      expectedResult: 'no concrete route path or static runtime route is added',
    },
    {
      id: 'method-matrix',
      status: 'planned-only',
      action: 'Plan GET as the first implementation method, keep HEAD rejected unless reviewed, and reject POST, PUT, PATCH, DELETE, OPTIONS, and OTHER.',
      expectedResult: 'future methods have fixed sanitized outcomes',
    },
    {
      id: 'size-limits',
      status: 'planned-only',
      action: 'Carry forward request target, header count, body, response, packet, string, and array limits.',
      expectedResult: 'limits remain contract data and are not runtime-enforced now',
    },
    {
      id: 'rate-preview',
      status: 'planned-only',
      action: 'Preview 60 requests/min per operator runtime process with burst 10 for loopback only.',
      expectedResult: 'no remote/IP trust and no counters are implemented now',
    },
    {
      id: 'failure-behavior',
      status: 'planned-only',
      action: 'Plan fixed 404, fixed 405 with Allow GET only after endpoint exists, fixed 413, and fixed 429.',
      expectedResult: 'future failures do not echo request or private content',
    },
    {
      id: 'redaction-boundary',
      status: 'blocked',
      action: 'Keep paths, query strings, headers, bodies, credentials, raw refs, packet contents, provider details, and DB errors out of outputs.',
      expectedResult: 'synthetic labels only',
    },
    {
      id: 'source-boundary',
      status: 'blocked',
      action: 'Require only a sanitized future packet producer and forbid DB, provider, or raw-ref sources.',
      expectedResult: 'no packet source is connected now',
    },
    {
      id: 'operator-acceptance',
      status: 'blocked',
      action: 'Require a redaction-safe operator acceptance record before route exposure.',
      expectedResult: 'operator acceptance remains absent and blocking',
    },
    {
      id: 'independent-reviewer-go',
      status: 'blocked',
      action: 'Require independent reviewer GO before implementation.',
      expectedResult: 'reviewer GO remains absent and blocking',
    },
  ],
  acceptanceMatrix: [
    {
      label: 'method matrix',
      status: 'planned-only',
      requirement: 'GET only first; HEAD rejected unless explicitly reviewed; POST, PUT, PATCH, DELETE, OPTIONS, and OTHER rejected with fixed sanitized responses.',
    },
    {
      label: 'size matrix',
      status: 'planned-only',
      requirement: 'request body byte limit 0, request target max 2048 bytes, max header count 64, max response 262144 bytes, max packet count 64, max string field bytes 256, and max array length 64.',
    },
    {
      label: 'rate preview',
      status: 'planned-only',
      requirement: '60 requests/min per operator runtime process, burst 10, loopback preview only, no remote/IP trust, and no counters implemented now.',
    },
    {
      label: 'redaction sentinel',
      status: 'blocked',
      requirement: 'no echo of paths, query strings, headers, bodies, credentials, raw refs, packet contents, provider details, or DB errors.',
    },
    {
      label: 'raw target bypass',
      status: 'planned-only',
      requirement: 'raw target bypass forms must receive fixed sanitized failures when the future endpoint exists.',
    },
    {
      label: 'blocked route',
      status: 'blocked',
      requirement: 'current static runtime route surface remains unchanged and packet/data/auth paths remain fixed blocked routes.',
    },
    {
      label: 'auth boundary',
      status: 'blocked',
      requirement: 'reviewed local operator auth boundary must exist before any packet route exposure.',
    },
    {
      label: 'packet source boundary',
      status: 'blocked',
      requirement: 'only a sanitized future packet producer may feed the endpoint; direct DB, provider, raw-ref, or live packet sources are forbidden now.',
    },
    {
      label: 'operator acceptance',
      status: 'blocked',
      requirement: 'redaction-safe operator acceptance record must exist before route exposure.',
    },
    {
      label: 'independent reviewer GO',
      status: 'blocked',
      requirement: 'independent reviewer GO must be recorded before implementation.',
    },
  ],
  currentStaticRuntimeRoutes: ['GET /', 'GET /healthz', 'GET /manifest.json'],
  forbiddenCurrentRoutes: ['/api/packets', '/packets', '/packet', '/operator-packets', '/data', '/events', '/catalog', '/items', '/auth', '/login', '/session', '/token'],
  retainedBoundaries: [
    'static runtime route surface remains only GET /, GET /healthz, GET /manifest.json',
    'planned route is local loopback only in a future phase and remains blocked now',
    'Phase 75 readiness remains not-ready',
    'Phase 76 limits remain contract-only and not-implemented',
    'Phase 77 evidence gate remains blocked and evidence-required',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness only',
    'Provider availability remains packet/count/advisory only',
    'provider availability remains packet/count/advisory only',
  ],
  forbiddenImplementationThisPhase: [
    'packet endpoint',
    'new static runtime route',
    'route handlers',
    'runtime enforcement',
    'auth implementation',
    'rate limiter or counters',
    'API framework',
    'frontend/browser JavaScript',
    'UI framework',
    'DB reads',
    'env/config reads',
    'fs reads in the pure implementation',
    'network/fetch',
    'provider integration',
    'packet ingestion',
    'playback/download/scraping/media-server behavior',
    'cookies/sessions/tokens',
    'live data access',
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
    'from "node:https"',
    "from 'node:net'",
    'from "node:net"',
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
  console.log('Running Phase 78 operator UI packet endpoint route dry-run suite:\n');

  await test('route dry-run report is deterministic, exact, and defensively copied', () => {
    const first = buildOperatorUiPacketEndpointRouteDryRunReport();
    const second = buildOperatorUiPacketEndpointRouteDryRunReport();
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
      'routeExposure',
      'candidateEndpointId',
      'candidateRoute',
      'phase75Readiness',
      'phase76Limits',
      'phase77EvidenceGate',
      'dryRunPlan',
      'dryRunSteps',
      'acceptanceMatrix',
      'currentStaticRuntimeRoutes',
      'forbiddenCurrentRoutes',
      'retainedBoundaries',
      'forbiddenImplementationThisPhase',
    ]), 'key ordering is fixed');

    (first.status as unknown as { overall: string }).overall = 'ready';
    (first.routeExposure as unknown as { status: string }).status = 'open';
    (first.phase75Readiness as unknown as { status: string }).status = 'ready';
    (first.phase76Limits as unknown as { phase: string }).phase = 'implemented';
    (first.phase77EvidenceGate as unknown as { status: string }).status = 'ready';
    (first.dryRunPlan.rejectedMethods as unknown as string[]).push('MUTATED');
    (first.dryRunPlan.futureRatePreview as unknown as { burst: number }).burst = 999;
    (first.dryRunPlan.futureFailureBehavior as unknown as string[]).push('mutated');
    (first.dryRunPlan.noEchoCategories as unknown as string[]).push('mutated');
    (first.dryRunSteps as unknown as Array<{ id: string }>)[0] = { id: 'mutated' };
    (first.acceptanceMatrix as unknown as Array<{ label: string }>)[0] = { label: 'mutated' };
    (first.currentStaticRuntimeRoutes as unknown as string[]).push('MUTATED');
    (first.forbiddenCurrentRoutes as unknown as string[]).push('/mutated');
    (first.retainedBoundaries as unknown as string[]).push('mutated');
    (first.forbiddenImplementationThisPhase as unknown as string[]).push('mutated');
    assert(JSON.stringify(buildOperatorUiPacketEndpointRouteDryRunReport()) === JSON.stringify(expectedReport), 'fresh report is not affected by mutation');
  });

  await test('fixed statuses preserve Phase 75, Phase 76, and Phase 77 gates', () => {
    const report = buildOperatorUiPacketEndpointRouteDryRunReport();
    assert(report.reportName === 'operator-ui-packet-endpoint-route-dry-run', 'fixed report name');
    assert(report.reportVersion === 'phase-78.v1', 'fixed report version');
    assert(report.code === 'OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN_REPORTED', 'fixed report code');
    assert(report.status.overall === 'blocked', 'overall blocked');
    assert(report.status.phase === 'dry-run-plan-only', 'phase dry-run-plan-only');
    assert(report.routeExposure.status === 'blocked', 'route exposure blocked');
    assert(report.routeExposure.implementation === 'not-implemented', 'route not implemented');
    assert(report.candidateEndpointId === 'sanitized-local-packet-endpoint', 'candidate endpoint label');
    assert(report.candidateRoute === 'future-local-packet-snapshot-route', 'candidate route is synthetic label');
    assert(!report.candidateRoute.startsWith('/'), 'candidate route is not a runtime path');
    assert(report.phase75Readiness.status === 'not-ready', 'Phase 75 remains not-ready');
    assert(report.phase76Limits.phase === 'contract-only', 'Phase 76 remains contract-only');
    assert(report.phase76Limits.implementation === 'not-implemented', 'Phase 76 remains not-implemented');
    assert(report.phase77EvidenceGate.status === 'blocked', 'Phase 77 remains blocked');
    assert(report.phase77EvidenceGate.phase === 'evidence-required', 'Phase 77 remains evidence-required');
  });

  await test('dry-run plan includes required method, size, rate, failure, and redaction rules', () => {
    const plan = buildOperatorUiPacketEndpointRouteDryRunReport().dryRunPlan;
    assert(plan.plannedExposure === 'future local loopback only', 'future route loopback only');
    assert(plan.currentExposure === 'blocked', 'current exposure blocked');
    assert(plan.currentImplementation === 'not-implemented', 'current implementation missing');
    assert(plan.firstImplementationMethod === 'GET', 'GET first implementation');
    assert(plan.headBehavior === 'rejected-unless-explicitly-reviewed', 'HEAD remains rejected unless reviewed');
    assert(JSON.stringify(plan.rejectedMethods) === JSON.stringify(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER']), 'unsafe methods rejected');
    assert(plan.requestBodyByteLimit === 0, 'body byte limit 0');
    assert(plan.requestTargetMaxBytes === 2048, 'target limit');
    assert(plan.maxHeaderCount === 64, 'header count');
    assert(plan.maxResponseBytes === 262144, 'response max');
    assert(plan.maxPacketCount === 64, 'packet count');
    assert(plan.maxStringFieldBytes === 256, 'string field bytes');
    assert(plan.maxArrayLength === 64, 'array length');
    assert(plan.futureRatePreview.maxRequestsPerMinutePerOperatorRuntimeProcess === 60, 'rate per minute');
    assert(plan.futureRatePreview.burst === 10, 'burst size');
    assert(plan.futureRatePreview.scope === 'loopback preview only', 'loopback rate preview');
    assert(plan.futureRatePreview.remoteOrIpTrust === 'none', 'no remote/IP trust');
    assert(plan.futureRatePreview.countersImplementedNow === false, 'no counters implemented');
    for (const failure of ['fixed 404', 'fixed 405 with Allow GET only after endpoint exists', 'fixed 413', 'fixed 429'] as const) {
      assert(plan.futureFailureBehavior.includes(failure), `failure behavior ${failure}`);
    }
    for (const category of ['paths', 'query strings', 'headers', 'bodies', 'credentials', 'raw refs', 'packet contents', 'provider details', 'DB errors']) {
      assert(plan.noEchoCategories.includes(category), `no echo ${category}`);
    }
    assert(plan.routeExposurePrerequisite.includes('Phase 77 evidence gate'), 'route prerequisite includes Phase 77');
  });

  await test('dry-run steps and acceptance matrix cover required labels with planned-only or blocked statuses', () => {
    const report = buildOperatorUiPacketEndpointRouteDryRunReport();
    for (const step of report.dryRunSteps) assert(step.status === 'planned-only' || step.status === 'blocked', `${step.id} status`);
    for (const row of report.acceptanceMatrix) assert(row.status === 'planned-only' || row.status === 'blocked', `${row.label} status`);
    for (const label of ['method matrix', 'size matrix', 'rate preview', 'redaction sentinel', 'raw target bypass', 'blocked route', 'auth boundary', 'packet source boundary', 'operator acceptance', 'independent reviewer GO']) {
      assert(report.acceptanceMatrix.some((row) => row.label === label), `acceptance matrix includes ${label}`);
    }
  });

  await test('CLI JSON output is parseable, fixed, and ignores hostile env values', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-packet-endpoint-route-dry-run-cli.ts', '--json'], {
      cwd: root,
      env: {
        ...process.env,
        TOKEN: 'SECRET_TOKEN_SENTINEL',
        PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
        DATABASE_URL: 'postgres://user:pass@example.invalid/db',
        RAW_REF: 'RAW_REF_SENTINEL',
        PACKET_CONTENTS: 'PACKET_CONTENT_SENTINEL',
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as OperatorUiPacketEndpointRouteDryRunReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedReport), 'json output matches fixed route dry-run');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'example.invalid', 'RAW_REF_SENTINEL', 'PACKET_CONTENT_SENTINEL']) {
      assert(!output.includes(sentinel), `json omits hostile input ${sentinel}`);
    }
  });

  await test('documented npm JSON command output is parseable and fixed', () => {
    const output = execSync(documentedNpmJsonCommand, {
      cwd: root,
      env: {
        ...process.env,
        TOKEN: 'SECRET_TOKEN_SENTINEL',
        PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
        DATABASE_URL: 'postgres://user:pass@example.invalid/db',
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as OperatorUiPacketEndpointRouteDryRunReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedReport), 'documented npm json matches fixed route dry-run');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'example.invalid']) {
      assert(!output.includes(sentinel), `documented json omits hostile input ${sentinel}`);
    }
  });

  await test('text output is deterministic and parseable', () => {
    const first = formatOperatorUiPacketEndpointRouteDryRunText();
    const second = formatOperatorUiPacketEndpointRouteDryRunText();
    assert(first === second, 'text is deterministic');
    for (const line of [
      'Operator UI Packet Endpoint Route Dry-Run Plan',
      'report: operator-ui-packet-endpoint-route-dry-run',
      'version: phase-78.v1',
      'status: blocked / dry-run-plan-only',
      'route exposure: blocked / not-implemented',
      'candidate endpoint: sanitized-local-packet-endpoint',
      'candidate route: future-local-packet-snapshot-route',
      'phase 75 readiness: not-ready',
      'phase 76 limits: contract-only / not-implemented',
      'phase 77 evidence gate: blocked / evidence-required',
      '- planned exposure: future local loopback only',
      '- first implementation method: GET',
      '- HEAD behavior: rejected-unless-explicitly-reviewed',
      '- request body byte limit: 0',
      '- future rate preview: 60/min, burst 10, loopback preview only',
      '- route-exposure-prerequisite: blocked',
      '- method matrix: planned-only;',
      '- GET /manifest.json',
      '- /api/packets',
      '- packet contents',
      '- Phase 77 evidence gate remains blocked and evidence-required',
      '- packet endpoint',
    ]) assert(first.includes(line), `text includes ${line}`);
    assert(first.endsWith('\n'), 'text ends with newline');

    const cliOutput = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-packet-endpoint-route-dry-run-cli.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert(cliOutput === first, 'CLI text matches formatter');
  });

  await test('source and CLI have no env, file, network, DB, server, route, frontend, provider, auth, or rate-counter implementation scope', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
      assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
    }
    assert(pkg.scripts['test:operator-ui-packet-endpoint-route-dry-run'] === 'tsx test/operator-ui-packet-endpoint-route-dry-run.ts', 'test script');
    assert(pkg.scripts['ops:operator-ui-packet-endpoint-route-dry-run'] === 'tsx src/ops/operator-ui-packet-endpoint-route-dry-run-cli.ts', 'ops script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-packet-endpoint-evidence-gate.ts && tsx test/operator-ui-packet-endpoint-route-dry-run.ts'),
      'Phase 78 suite follows Phase 77 packet endpoint evidence gate',
    );
    assertNoEndpointImplementationScope(`${source}\n${cliSource}`);
  });

  await test('static runtime route surface remains only root, health, and manifest while packet/data/auth paths stay blocked', async () => {
    const report = buildOperatorUiPacketEndpointRouteDryRunReport();
    assert(JSON.stringify(report.currentStaticRuntimeRoutes) === JSON.stringify(['GET /', 'GET /healthz', 'GET /manifest.json']), 'current route list fixed');
    assert(JSON.stringify(report.forbiddenCurrentRoutes) === JSON.stringify(['/api/packets', '/packets', '/packet', '/operator-packets', '/data', '/events', '/catalog', '/items', '/auth', '/login', '/session', '/token']), 'forbidden route list fixed');

    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/', '/healthz', '/manifest.json']) {
        const response = await httpRequest(runtime.port, path);
        assert(response.statusCode === 200, `${path} remains served`);
      }

      for (const path of report.forbiddenCurrentRoutes) {
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

  await test('known routes keep fixed 405 and raw packet/data/auth bypass forms stay fixed 404', async () => {
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

  await test('docs, README, deploy guard, and package wiring mention Phase 78 and required dry-run plan', () => {
    const combined = `${read('docs/PHASE_78_OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN.md')}\n${read('README.md')}\n${read('test/deploy.ts')}\n${read('package.json')}`;
    for (const kw of [
      'Phase 78',
      'Packet Endpoint Route Dry-Run Plan',
      'operator UI packet endpoint route dry-run',
      'ops:operator-ui-packet-endpoint-route-dry-run',
      'test:operator-ui-packet-endpoint-route-dry-run',
      documentedNpmJsonCommand,
      'operator-ui-packet-endpoint-route-dry-run',
      'phase-78.v1',
      'OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN_REPORTED',
      'blocked',
      'dry-run-plan-only',
      'routeExposure',
      'not-implemented',
      'sanitized-local-packet-endpoint',
      'future-local-packet-snapshot-route',
      'planned route is local loopback only in a future phase and remains blocked now',
      'GET only',
      'HEAD remains rejected unless explicitly reviewed',
      'POST, PUT, PATCH, DELETE, OPTIONS, and OTHER rejected with fixed sanitized responses',
      'request body byte limit remains 0',
      'request target max 2048 bytes',
      'max header count 64',
      'max response 262144 bytes',
      'max packet count 64',
      'max string field bytes 256',
      'max array length 64',
      '60 requests/min per operator runtime process',
      'burst 10',
      'loopback preview only',
      'no remote/IP trust',
      'no counters implemented now',
      'fixed 404',
      'fixed 405 with Allow GET only after endpoint exists',
      'fixed 413',
      'fixed 429',
      'paths, query strings, headers, bodies, credentials, raw refs, packet contents, provider details, and DB errors',
      'Phase 77 evidence gate must be satisfied and independently reviewed before implementation',
      'method matrix',
      'size matrix',
      'rate preview',
      'redaction sentinel',
      'raw target bypass',
      'blocked route',
      'auth boundary',
      'packet source boundary',
      'operator acceptance',
      'independent reviewer GO',
      'GET /, GET /healthz, GET /manifest.json',
      '/api/packets',
      '/operator-packets',
      '/token',
      'Phase 75 readiness remains not-ready',
      'Phase 76 limits remain contract-only and not-implemented',
      'Phase 77 evidence gate remains blocked and evidence-required',
      'no endpoint/runtime/auth/provider/UI/data expansion is added',
    ]) assert(combined.includes(kw), `Phase 78 docs/deploy include ${kw}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
