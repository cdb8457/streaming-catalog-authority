import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiLocalAuthBoundaryReport,
  formatOperatorUiLocalAuthBoundaryText,
  type OperatorUiLocalAuthBoundaryReport,
} from '../src/ops/operator-ui-local-auth-boundary.js';
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
const source = read('src/ops/operator-ui-local-auth-boundary.ts');
const cliSource = read('src/ops/operator-ui-local-auth-boundary-cli.ts');
const documentedNpmJsonCommand = 'npm run --silent ops:operator-ui-local-auth-boundary -- -- --json';

const expectedReport: OperatorUiLocalAuthBoundaryReport = {
  ok: true,
  code: 'OPERATOR_UI_LOCAL_AUTH_BOUNDARY_REPORTED',
  message: 'Operator UI local auth boundary selection is blocked, contract-only, and not implemented.',
  reportName: 'operator-ui-local-auth-boundary',
  reportVersion: 'phase-79.v1',
  status: {
    overall: 'blocked',
    phase: 'auth-boundary-selection-only',
    authImplementation: 'not-implemented',
  },
  selectedFutureBoundary: 'local-operator-secret-file-with-explicit-path-and-redacted-evidence',
  selectedBoundaryStatus: 'selected-for-future-review/not-implemented',
  rejectedBoundaryOptions: {
    'reverse-proxy-forward-auth-attestation': 'rejected-for-first-implementation',
    'mTLS-or-local-network-attestation': 'rejected-for-first-implementation',
    'browser-cookie-session': 'rejected-for-first-implementation',
    'bearer-token-api': 'rejected-for-first-implementation',
  },
  currentRuntimeExposure: '127.0.0.1 fixture preview only',
  remoteExposure: 'blocked',
  phase74AuthContract: {
    reportName: 'operator-ui-auth-access-contract',
    reportVersion: 'phase-74.v1',
    code: 'OPERATOR_UI_AUTH_ACCESS_CONTRACT_REPORTED',
    phase: 'contract-only',
    implementation: 'not-implemented',
  },
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
  phase78RouteDryRun: {
    reportName: 'operator-ui-packet-endpoint-route-dry-run',
    reportVersion: 'phase-78.v1',
    code: 'OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN_REPORTED',
    status: 'blocked',
    phase: 'dry-run-plan-only',
  },
  selectedBoundary: {
    id: 'local-operator-secret-file-with-explicit-path-and-redacted-evidence',
    status: 'selected-for-future-review/not-implemented',
    reason: 'Selected as the first future boundary because it keeps operator auth local, explicit, redaction-safe, and reviewable without browser session state or remote trust.',
    futureRequirements: [
      'explicit operator-provided file path only in a later reviewed phase',
      'no default secret path',
      'no environment variable secret value',
      'no CLI argument secret value',
      'bounded file size in future implementation, e.g. <= 4096 bytes',
      'trim one trailing newline only',
      'reject empty or whitespace-only values',
      'reject values below minimum entropy or length in future implementation',
      'compare using constant-time comparison in future implementation',
      'never log, echo, persist, hash-output, or include the secret value in evidence',
      'redaction-safe errors only',
      'loopback-only use unless a later reviewed remote access model exists',
      'no browser storage, cookie/session token, bearer/basic auth, or OAuth/Sso in first implementation',
    ],
    forbiddenNow: [
      'auth implementation',
      'secret file path',
      'secret file read',
      'secret parsing',
      'credential validation',
      'environment or config secret read',
      'CLI argument secret value',
      'cookie/session/token/bearer/basic parsing',
      'reverse-proxy header trust',
      'TLS or mTLS implementation',
      'public bind',
      'route handler',
    ],
  },
  rejectedBoundaries: [
    {
      id: 'reverse-proxy-forward-auth-attestation',
      status: 'rejected-for-first-implementation',
      reason: 'Rejected as the first implementation because proxy header trust and deployment attestation need a separate reviewed remote access model.',
    },
    {
      id: 'mTLS-or-local-network-attestation',
      status: 'rejected-for-first-implementation',
      reason: 'Rejected as the first implementation because certificate, TLS, and local-network trust introduce deployment scope beyond the current loopback boundary.',
    },
    {
      id: 'browser-cookie-session',
      status: 'rejected-for-first-implementation',
      reason: 'Rejected as the first implementation because browser storage, cookies, and session state expand runtime auth surface.',
    },
    {
      id: 'bearer-token-api',
      status: 'rejected-for-first-implementation',
      reason: 'Rejected as the first implementation because bearer/basic style API credentials would widen header parsing and evidence redaction risk.',
    },
  ],
  futureImplementationGates: [
    {
      id: 'explicit-operator-file-path-review',
      status: 'required-before-auth-implementation',
      requirement: 'Future auth implementation must require an explicit operator-provided file path with no default path.',
    },
    {
      id: 'redaction-safe-evidence-review',
      status: 'required-before-auth-implementation',
      requirement: 'Evidence must prove no secret value, path, credential, token, header, body, or artifact content is logged or emitted.',
    },
    {
      id: 'secret-file-size-bound-review',
      status: 'required-before-auth-implementation',
      requirement: 'Future file read must enforce a bounded file size, e.g. <= 4096 bytes, before reading a secret value.',
    },
    {
      id: 'secret-value-validation-review',
      status: 'required-before-auth-implementation',
      requirement: 'Future validation must trim one trailing newline only and reject empty, whitespace-only, low-entropy, or short values.',
    },
    {
      id: 'constant-time-comparison-review',
      status: 'required-before-auth-implementation',
      requirement: 'Future comparison must use constant-time comparison and redaction-safe failures.',
    },
    {
      id: 'loopback-only-runtime-review',
      status: 'blocked',
      requirement: 'Auth may be used only on loopback unless a later reviewed remote access model exists.',
    },
    {
      id: 'static-route-regression-review',
      status: 'blocked',
      requirement: 'Static runtime route regression must still prove only GET /, GET /healthz, and GET /manifest.json exist now.',
    },
    {
      id: 'independent-reviewer-go',
      status: 'blocked',
      requirement: 'Independent reviewer GO is required before auth implementation.',
    },
    {
      id: 'operator-acceptance-record',
      status: 'blocked',
      requirement: 'Redaction-safe operator acceptance is required before auth implementation.',
    },
  ],
  forbiddenCurrentRoutes: ['/login', '/auth', '/session', '/token', '/callback', '/logout', '/oauth', '/sso', '/admin', '/api/packets', '/packets', '/packet', '/operator-packets'],
  currentStaticRuntimeRoutes: ['GET /', 'GET /healthz', 'GET /manifest.json'],
  retainedFailClosedRuntimeBehavior: [
    'static runtime route surface remains only GET /, GET /healthz, GET /manifest.json',
    'blocked auth, packet, and data paths return fixed 404 responses',
    'known routes reject unsupported methods with fixed 405 responses',
    'request bodies are ignored and never echoed',
    'raw request-target bypass forms remain fixed 404',
    'remote exposure remains blocked',
  ],
  forbiddenImplementationThisPhase: [
    'auth implementation',
    'cookies',
    'sessions',
    'tokens',
    'bearer/basic parsing',
    'password parsing',
    'credential validation',
    'secret-file reads',
    'environment/config reads',
    'reverse-proxy headers',
    'TLS/mTLS',
    'public bind',
    'route handlers',
    'API framework',
    'frontend/browser JavaScript',
    'UI framework',
    'DB reads',
    'fs reads in the pure implementation',
    'network/fetch',
    'provider integration',
    'packet ingestion',
    'playback/download/scraping/media-server behavior',
    'live data access',
  ],
  forbiddenEvidenceFields: [
    'secret value',
    'secret path',
    'environment variable secret value',
    'CLI argument secret value',
    'credentials',
    'tokens',
    'cookies',
    'authorization headers',
    'request paths',
    'query strings',
    'headers',
    'bodies',
    'DB URLs',
    'provider names',
    'real titles',
    'external IDs',
    'infohashes',
    'magnets',
    'raw refs',
    'packet contents',
    'artifact contents',
    'user library data',
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

function assertNoAuthImplementationScope(combined: string): void {
  for (const forbidden of [
    'process.env',
    "from 'node:fs'",
    'from "node:fs"',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'openSync',
    'readSync',
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
    'crypto.timingSafeEqual',
    'timingSafeEqual',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'createAdapter',
    'writeFile',
    'createWriteStream',
  ]) assert(!combined.includes(forbidden), `source excludes ${forbidden}`);
}

async function main(): Promise<void> {
  console.log('Running Phase 79 operator UI local auth boundary suite:\n');

  await test('local auth boundary report is deterministic, exact, and defensively copied', () => {
    const first = buildOperatorUiLocalAuthBoundaryReport();
    const second = buildOperatorUiLocalAuthBoundaryReport();
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
      'selectedFutureBoundary',
      'selectedBoundaryStatus',
      'rejectedBoundaryOptions',
      'currentRuntimeExposure',
      'remoteExposure',
      'phase74AuthContract',
      'phase75Readiness',
      'phase76Limits',
      'phase77EvidenceGate',
      'phase78RouteDryRun',
      'selectedBoundary',
      'rejectedBoundaries',
      'futureImplementationGates',
      'forbiddenCurrentRoutes',
      'currentStaticRuntimeRoutes',
      'retainedFailClosedRuntimeBehavior',
      'forbiddenImplementationThisPhase',
      'forbiddenEvidenceFields',
    ]), 'key ordering is fixed');

    (first.status as unknown as { overall: string }).overall = 'ready';
    (first.phase74AuthContract as unknown as { implementation: string }).implementation = 'implemented';
    (first.phase75Readiness as unknown as { status: string }).status = 'ready';
    (first.phase76Limits as unknown as { implementation: string }).implementation = 'implemented';
    (first.phase77EvidenceGate as unknown as { status: string }).status = 'ready';
    (first.phase78RouteDryRun as unknown as { status: string }).status = 'ready';
    (first.selectedBoundary.futureRequirements as unknown as string[]).push('mutated');
    (first.selectedBoundary.forbiddenNow as unknown as string[]).push('mutated');
    (first.rejectedBoundaries as unknown as Array<{ id: string }>)[0] = { id: 'mutated' };
    (first.futureImplementationGates as unknown as Array<{ id: string }>)[0] = { id: 'mutated' };
    (first.forbiddenCurrentRoutes as unknown as string[]).push('/mutated');
    (first.currentStaticRuntimeRoutes as unknown as string[]).push('MUTATED');
    (first.retainedFailClosedRuntimeBehavior as unknown as string[]).push('mutated');
    (first.forbiddenImplementationThisPhase as unknown as string[]).push('mutated');
    (first.forbiddenEvidenceFields as unknown as string[]).push('mutated');
    assert(JSON.stringify(buildOperatorUiLocalAuthBoundaryReport()) === JSON.stringify(expectedReport), 'fresh report is not affected by mutation');
  });

  await test('fixed statuses preserve Phase 74 through Phase 78 gates', () => {
    const report = buildOperatorUiLocalAuthBoundaryReport();
    assert(report.reportName === 'operator-ui-local-auth-boundary', 'fixed report name');
    assert(report.reportVersion === 'phase-79.v1', 'fixed report version');
    assert(report.code === 'OPERATOR_UI_LOCAL_AUTH_BOUNDARY_REPORTED', 'fixed report code');
    assert(report.status.overall === 'blocked', 'overall blocked');
    assert(report.status.phase === 'auth-boundary-selection-only', 'phase auth-boundary-selection-only');
    assert(report.status.authImplementation === 'not-implemented', 'auth implementation not implemented');
    assert(report.phase74AuthContract.phase === 'contract-only', 'Phase 74 remains contract-only');
    assert(report.phase74AuthContract.implementation === 'not-implemented', 'Phase 74 remains not-implemented');
    assert(report.phase75Readiness.status === 'not-ready', 'Phase 75 remains not-ready');
    assert(report.phase76Limits.phase === 'contract-only', 'Phase 76 remains contract-only');
    assert(report.phase76Limits.implementation === 'not-implemented', 'Phase 76 remains not-implemented');
    assert(report.phase77EvidenceGate.status === 'blocked', 'Phase 77 remains blocked');
    assert(report.phase77EvidenceGate.phase === 'evidence-required', 'Phase 77 remains evidence-required');
    assert(report.phase78RouteDryRun.status === 'blocked', 'Phase 78 remains blocked');
    assert(report.phase78RouteDryRun.phase === 'dry-run-plan-only', 'Phase 78 remains dry-run-plan-only');
  });

  await test('selected and rejected auth boundary decisions are fixed', () => {
    const report = buildOperatorUiLocalAuthBoundaryReport();
    assert(report.selectedFutureBoundary === 'local-operator-secret-file-with-explicit-path-and-redacted-evidence', 'selected local operator file boundary');
    assert(report.selectedBoundaryStatus === 'selected-for-future-review/not-implemented', 'selected status');
    assert(report.selectedBoundary.id === report.selectedFutureBoundary, 'selected boundary object matches top-level selection');
    assert(report.selectedBoundary.status === report.selectedBoundaryStatus, 'selected boundary object status matches');
    for (const requirement of [
      'explicit operator-provided file path only in a later reviewed phase',
      'no default secret path',
      'no environment variable secret value',
      'no CLI argument secret value',
      'bounded file size in future implementation, e.g. <= 4096 bytes',
      'trim one trailing newline only',
      'reject empty or whitespace-only values',
      'reject values below minimum entropy or length in future implementation',
      'compare using constant-time comparison in future implementation',
      'never log, echo, persist, hash-output, or include the secret value in evidence',
      'redaction-safe errors only',
      'loopback-only use unless a later reviewed remote access model exists',
      'no browser storage, cookie/session token, bearer/basic auth, or OAuth/Sso in first implementation',
    ]) assert(report.selectedBoundary.futureRequirements.includes(requirement), `future requirement ${requirement}`);
    for (const [id, status] of Object.entries(report.rejectedBoundaryOptions)) {
      assert(status === 'rejected-for-first-implementation', `${id} rejected`);
      assert(report.rejectedBoundaries.some((boundary) => boundary.id === id && boundary.status === status), `${id} rejected row`);
    }
  });

  await test('CLI JSON output is parseable, fixed, and ignores hostile env values', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-local-auth-boundary-cli.ts', '--json'], {
      cwd: root,
      env: {
        ...process.env,
        TOKEN: 'SECRET_TOKEN_SENTINEL',
        PASSWORD: 'PASSWORD_SENTINEL',
        PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
        DATABASE_URL: 'postgres://user:pass@example.invalid/db',
        RAW_REF: 'RAW_REF_SENTINEL',
        PACKET_CONTENTS: 'PACKET_CONTENT_SENTINEL',
        OPERATOR_SECRET_FILE: 'SECRET_PATH_SENTINEL',
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as OperatorUiLocalAuthBoundaryReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedReport), 'json output matches fixed local auth boundary');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'PASSWORD_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'example.invalid', 'RAW_REF_SENTINEL', 'PACKET_CONTENT_SENTINEL', 'SECRET_PATH_SENTINEL']) {
      assert(!output.includes(sentinel), `json omits hostile input ${sentinel}`);
    }
  });

  await test('documented npm JSON command output is parseable and fixed', () => {
    const output = execSync(documentedNpmJsonCommand, {
      cwd: root,
      env: {
        ...process.env,
        TOKEN: 'SECRET_TOKEN_SENTINEL',
        PASSWORD: 'PASSWORD_SENTINEL',
        DATABASE_URL: 'postgres://user:pass@example.invalid/db',
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as OperatorUiLocalAuthBoundaryReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedReport), 'documented npm json matches fixed local auth boundary');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'PASSWORD_SENTINEL', 'postgres://', 'example.invalid']) {
      assert(!output.includes(sentinel), `documented json omits hostile input ${sentinel}`);
    }
  });

  await test('text output is deterministic and parseable', () => {
    const first = formatOperatorUiLocalAuthBoundaryText();
    const second = formatOperatorUiLocalAuthBoundaryText();
    assert(first === second, 'text is deterministic');
    for (const line of [
      'Operator UI Local Auth Boundary Selection',
      'report: operator-ui-local-auth-boundary',
      'version: phase-79.v1',
      'status: blocked / auth-boundary-selection-only',
      'auth implementation: not-implemented',
      'selected future boundary: local-operator-secret-file-with-explicit-path-and-redacted-evidence',
      'phase 74 auth contract: contract-only / not-implemented',
      'phase 75 readiness: not-ready',
      'phase 76 limits: contract-only / not-implemented',
      'phase 77 evidence gate: blocked / evidence-required',
      'phase 78 route dry-run: blocked / dry-run-plan-only',
      '- reverse-proxy-forward-auth-attestation: rejected-for-first-implementation',
      '- explicit-operator-file-path-review: required-before-auth-implementation;',
      '- GET /manifest.json',
      '- /operator-packets',
      '- request bodies are ignored and never echoed',
      '- auth implementation',
      '- secret value',
    ]) assert(first.includes(line), `text includes ${line}`);
    assert(first.endsWith('\n'), 'text ends with newline');

    const cliOutput = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-local-auth-boundary-cli.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert(cliOutput === first, 'CLI text matches formatter');
  });

  await test('source and CLI have no env, file, network, DB, server, route, frontend, provider, auth parser, or secret-read implementation scope', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
      assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
    }
    assert(pkg.scripts['test:operator-ui-local-auth-boundary'] === 'tsx test/operator-ui-local-auth-boundary.ts', 'test script');
    assert(pkg.scripts['ops:operator-ui-local-auth-boundary'] === 'tsx src/ops/operator-ui-local-auth-boundary-cli.ts', 'ops script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-packet-endpoint-route-dry-run.ts && tsx test/operator-ui-local-auth-boundary.ts'),
      'Phase 79 suite follows Phase 78 packet endpoint route dry-run',
    );
    assertNoAuthImplementationScope(`${source}\n${cliSource}`);
  });

  await test('static runtime route surface remains only root, health, and manifest while auth and packet paths stay blocked', async () => {
    const report = buildOperatorUiLocalAuthBoundaryReport();
    assert(JSON.stringify(report.currentStaticRuntimeRoutes) === JSON.stringify(['GET /', 'GET /healthz', 'GET /manifest.json']), 'current route list fixed');
    assert(JSON.stringify(report.forbiddenCurrentRoutes) === JSON.stringify(['/login', '/auth', '/session', '/token', '/callback', '/logout', '/oauth', '/sso', '/admin', '/api/packets', '/packets', '/packet', '/operator-packets']), 'forbidden route list fixed');

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

  await test('known routes keep fixed 405 and raw auth or packet bypass forms stay fixed 404', async () => {
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
        'http://evil/login',
        'https://evil/auth',
        '//evil/session',
        '///token',
        '/api%2fpackets',
        '/operator-packets/%2e',
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

  await test('docs, README, deploy guard, and package wiring mention Phase 79 and required auth boundary decision', () => {
    const combined = `${read('docs/PHASE_79_OPERATOR_UI_LOCAL_AUTH_BOUNDARY.md')}\n${read('README.md')}\n${read('test/deploy.ts')}\n${read('package.json')}`;
    for (const kw of [
      'Phase 79',
      'Local Auth Boundary Selection',
      'operator UI local auth boundary',
      'ops:operator-ui-local-auth-boundary',
      'test:operator-ui-local-auth-boundary',
      documentedNpmJsonCommand,
      'operator-ui-local-auth-boundary',
      'phase-79.v1',
      'OPERATOR_UI_LOCAL_AUTH_BOUNDARY_REPORTED',
      'blocked',
      'auth-boundary-selection-only',
      'not-implemented',
      'local-operator-secret-file-with-explicit-path-and-redacted-evidence',
      'selected-for-future-review/not-implemented',
      'reverse-proxy-forward-auth-attestation',
      'mTLS-or-local-network-attestation',
      'browser-cookie-session',
      'bearer-token-api',
      'rejected-for-first-implementation',
      '127.0.0.1 fixture preview only',
      'remoteExposure',
      'blocked',
      'explicit operator-provided file path only in a later reviewed phase',
      'no default secret path',
      'no environment variable secret value',
      'no CLI argument secret value',
      '<= 4096 bytes',
      'trim one trailing newline only',
      'reject empty or whitespace-only values',
      'reject values below minimum entropy or length',
      'constant-time comparison',
      'never log, echo, persist, hash-output, or include the secret value in evidence',
      'redaction-safe errors only',
      'loopback-only use unless a later reviewed remote access model exists',
      'no browser storage, cookie/session token, bearer/basic auth, or OAuth/Sso',
      '/login',
      '/auth',
      '/session',
      '/token',
      '/callback',
      '/logout',
      '/oauth',
      '/sso',
      '/admin',
      '/api/packets',
      '/operator-packets',
      'GET /, GET /healthz, GET /manifest.json',
      'Phase 74 auth contract remains contract-only and not-implemented',
      'Phase 75 readiness remains not-ready',
      'Phase 76 limits remain contract-only and not-implemented',
      'Phase 77 evidence gate remains blocked and evidence-required',
      'Phase 78 route dry-run remains blocked and dry-run-plan-only',
      'no auth/runtime/route/provider/UI/data expansion is added',
    ]) assert(combined.includes(kw), `Phase 79 docs/deploy include ${kw}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
