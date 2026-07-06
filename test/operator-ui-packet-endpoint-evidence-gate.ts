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
  buildOperatorUiPacketEndpointEvidenceGateReport,
  formatOperatorUiPacketEndpointEvidenceGateText,
  type OperatorUiPacketEndpointEvidenceGateReport,
} from '../src/ops/operator-ui-packet-endpoint-evidence-gate.js';

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
const source = read('src/ops/operator-ui-packet-endpoint-evidence-gate.ts');
const cliSource = read('src/ops/operator-ui-packet-endpoint-evidence-gate-cli.ts');
const documentedNpmJsonCommand = 'npm run --silent ops:operator-ui-packet-endpoint-evidence-gate -- -- --json';

const expectedReport: OperatorUiPacketEndpointEvidenceGateReport = {
  ok: true,
  code: 'OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE_REPORTED',
  message: 'Operator UI packet endpoint evidence gate is blocked until all future exposure evidence is reviewed.',
  reportName: 'operator-ui-packet-endpoint-evidence-gate',
  reportVersion: 'phase-77.v1',
  status: {
    overall: 'blocked',
    phase: 'evidence-required',
  },
  endpointExposure: {
    status: 'blocked',
    implementation: 'not-implemented',
    endpointId: 'sanitized-local-packet-endpoint',
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
  immutablePrerequisites: [
    {
      id: 'static-route-surface-regression-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'static runtime route-surface regression evidence proves only GET /, GET /healthz, and GET /manifest.json exist before implementation',
      evidenceKind: 'route-surface-regression',
      sourcePhase: 'phase-72-through-phase-77',
    },
    {
      id: 'auth-access-contract-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'no packet endpoint until a reviewed local operator auth boundary exists',
      evidenceKind: 'auth-access-review',
      sourcePhase: 'phase-74',
    },
    {
      id: 'phase-76-limits-enforcement-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'request target, header, body, response, packet, string, and array limits from Phase 76 must be enforced and tested in the future implementation',
      evidenceKind: 'limits-enforcement-tests',
      sourcePhase: 'phase-76',
    },
    {
      id: 'method-rejection-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'GET-only initial endpoint; HEAD rejected unless explicitly reviewed; POST, PUT, PATCH, DELETE, OPTIONS, and OTHER receive fixed sanitized rejections',
      evidenceKind: 'method-matrix-tests',
      sourcePhase: 'phase-76',
    },
    {
      id: 'failure-redaction-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'fixed 404, 405, 413, and 429 failures with no echo of request or private content',
      evidenceKind: 'failure-redaction-tests',
      sourcePhase: 'phase-76',
    },
    {
      id: 'packet-source-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'only a sanitized future packet producer may feed the endpoint; direct DB, provider, or raw-ref sources are forbidden',
      evidenceKind: 'source-boundary-review',
      sourcePhase: 'phase-69',
    },
    {
      id: 'redaction-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'logs, evidence, and errors use synthetic labels only and exclude private identity or endpoint payload content',
      evidenceKind: 'redaction-sentinel-tests',
      sourcePhase: 'phase-77',
    },
    {
      id: 'no-live-data-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'fixtures and synthetic packets only until an explicit later phase authorizes live packet ingestion',
      evidenceKind: 'synthetic-fixture-attestation',
      sourcePhase: 'phase-77',
    },
    {
      id: 'endpoint-test-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'focused endpoint tests exist before route exposure, including oversized target, header, body, response, method rejection, blocked route, raw-target bypass, and redaction sentinel cases',
      evidenceKind: 'endpoint-test-matrix',
      sourcePhase: 'phase-77',
    },
    {
      id: 'independent-reviewer-go-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'independent reviewer GO is recorded before endpoint exposure',
      evidenceKind: 'reviewer-go-record',
      sourcePhase: 'future-reviewed-phase',
    },
    {
      id: 'operator-acceptance-evidence',
      status: 'required-before-endpoint-exposure',
      requirement: 'redaction-safe operator packet and review record are accepted before endpoint exposure',
      evidenceKind: 'operator-acceptance-record',
      sourcePhase: 'future-reviewed-phase',
    },
  ],
  blockers: [
    'endpoint exposure remains blocked because required evidence artifacts do not exist',
    'endpoint implementation remains not-implemented',
    'Phase 75 readiness remains not-ready',
    'Phase 76 limits remain contract-only and not implemented',
    'reviewed local operator auth boundary does not exist',
    'independent reviewer GO does not exist',
    'operator acceptance record does not exist',
  ],
  allowedFutureEvidenceArtifactLabels: [
    'static-route-surface-regression-report',
    'local-operator-auth-boundary-review',
    'phase-76-limits-enforcement-test-report',
    'method-rejection-matrix-report',
    'failure-redaction-sentinel-report',
    'sanitized-packet-source-boundary-review',
    'synthetic-fixture-only-attestation',
    'endpoint-redaction-sentinel-test-report',
    'independent-reviewer-go-record',
    'operator-acceptance-record',
  ],
  forbiddenEvidenceFields: [
    'titles',
    'external IDs',
    'provider names/logos',
    'raw refs',
    'infohashes',
    'magnets',
    'URLs',
    'credentials',
    'tokens',
    'cookies',
    'DB URLs',
    'DB errors',
    'request paths',
    'query strings',
    'headers',
    'bodies',
    'packet contents',
    'artifact contents',
  ],
  futureTestMatrixLabels: [
    'oversized-request-target',
    'oversized-header-count',
    'request-body-rejected',
    'oversized-response-blocked',
    'packet-count-limit-enforced',
    'string-field-limit-enforced',
    'array-field-limit-enforced',
    'get-only-success-path',
    'head-rejected-unless-reviewed',
    'method-rejection',
    'unsafe-method-fixed-rejection',
    'blocked-route-fixed-404',
    'raw-target-bypass-fixed-404',
    'redaction-sentinel-no-echo',
    'rate-limit-fixed-429',
  ],
  retainedBoundaries: [
    'static runtime route surface remains only GET /, GET /healthz, GET /manifest.json',
    'Phase 75 readiness remains not-ready',
    'Phase 76 limits remain contract-only and not-implemented',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness only',
    'Provider availability remains packet/count/advisory only',
    'no endpoint route handler',
    'no runtime auth implementation',
    'no API framework',
    'no DB/env/fs reads',
    'no network calls',
    'no provider integration',
    'no frontend or browser JavaScript',
    'no packet ingestion',
    'no playback/download/scraping/media-server behavior',
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
  console.log('Running Phase 77 operator UI packet endpoint evidence gate suite:\n');

  await test('evidence gate report is deterministic, exact, and defensively copied', () => {
    const first = buildOperatorUiPacketEndpointEvidenceGateReport();
    const second = buildOperatorUiPacketEndpointEvidenceGateReport();
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
      'endpointExposure',
      'phase75Readiness',
      'phase76Limits',
      'immutablePrerequisites',
      'blockers',
      'allowedFutureEvidenceArtifactLabels',
      'forbiddenEvidenceFields',
      'futureTestMatrixLabels',
      'retainedBoundaries',
    ]), 'key ordering is fixed');

    (first.status as unknown as { overall: string }).overall = 'ready';
    (first.endpointExposure as unknown as { status: string }).status = 'open';
    (first.phase75Readiness as unknown as { status: string }).status = 'ready';
    (first.phase76Limits as unknown as { phase: string }).phase = 'implemented';
    (first.immutablePrerequisites as unknown as Array<{ id: string }>)[0] = { id: 'mutated' };
    (first.blockers as unknown as string[]).push('mutated');
    (first.allowedFutureEvidenceArtifactLabels as unknown as string[]).push('mutated');
    (first.forbiddenEvidenceFields as unknown as string[]).push('mutated');
    (first.futureTestMatrixLabels as unknown as string[]).push('mutated');
    (first.retainedBoundaries as unknown as string[]).push('mutated');
    assert(JSON.stringify(buildOperatorUiPacketEndpointEvidenceGateReport()) === JSON.stringify(expectedReport), 'fresh report is not affected by mutation');
  });

  await test('status blocks endpoint exposure and preserves Phase 75 and Phase 76 gates', () => {
    const report = buildOperatorUiPacketEndpointEvidenceGateReport();
    assert(report.reportName === 'operator-ui-packet-endpoint-evidence-gate', 'fixed report name');
    assert(report.reportVersion === 'phase-77.v1', 'fixed report version');
    assert(report.code === 'OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE_REPORTED', 'fixed report code');
    assert(report.status.overall === 'blocked', 'overall blocked');
    assert(report.status.phase === 'evidence-required', 'phase evidence-required');
    assert(report.endpointExposure.status === 'blocked', 'endpoint exposure blocked');
    assert(report.endpointExposure.implementation === 'not-implemented', 'endpoint not implemented');
    assert(report.phase75Readiness.status === 'not-ready', 'Phase 75 remains not-ready');
    assert(report.phase76Limits.phase === 'contract-only', 'Phase 76 remains contract-only');
    assert(report.phase76Limits.implementation === 'not-implemented', 'Phase 76 remains not-implemented');
  });

  await test('required evidence gates cover route surface, auth, limits, methods, failures, source, redaction, tests, review, and acceptance', () => {
    const byId = new Map(buildOperatorUiPacketEndpointEvidenceGateReport().immutablePrerequisites.map((gate) => [gate.id, gate]));
    for (const id of [
      'static-route-surface-regression-evidence',
      'auth-access-contract-evidence',
      'phase-76-limits-enforcement-evidence',
      'method-rejection-evidence',
      'failure-redaction-evidence',
      'packet-source-evidence',
      'redaction-evidence',
      'no-live-data-evidence',
      'endpoint-test-evidence',
      'independent-reviewer-go-evidence',
      'operator-acceptance-evidence',
    ] as const) {
      assert(byId.get(id)?.status === 'required-before-endpoint-exposure', `${id} is required`);
    }
    assert(byId.get('static-route-surface-regression-evidence')?.requirement.includes('only GET /, GET /healthz, and GET /manifest.json'), 'route surface requirement');
    assert(byId.get('auth-access-contract-evidence')?.requirement.includes('reviewed local operator auth boundary'), 'auth boundary requirement');
    assert(byId.get('phase-76-limits-enforcement-evidence')?.requirement.includes('request target, header, body, response, packet, string, and array limits'), 'limits requirement');
    assert(byId.get('method-rejection-evidence')?.requirement.includes('HEAD rejected unless explicitly reviewed'), 'HEAD requirement');
    assert(byId.get('failure-redaction-evidence')?.requirement.includes('fixed 404, 405, 413, and 429'), 'failure status requirement');
    assert(byId.get('packet-source-evidence')?.requirement.includes('direct DB, provider, or raw-ref sources are forbidden'), 'packet source requirement');
    assert(byId.get('redaction-evidence')?.requirement.includes('synthetic labels only'), 'redaction requirement');
    assert(byId.get('no-live-data-evidence')?.requirement.includes('fixtures and synthetic packets only'), 'no live data requirement');
    assert(byId.get('endpoint-test-evidence')?.requirement.includes('oversized target, header, body, response'), 'endpoint tests requirement');
    assert(byId.get('independent-reviewer-go-evidence')?.requirement.includes('independent reviewer GO'), 'reviewer requirement');
    assert(byId.get('operator-acceptance-evidence')?.requirement.includes('operator packet and review record'), 'operator acceptance requirement');
  });

  await test('future evidence labels are synthetic and forbidden fields cover private data and content', () => {
    const report = buildOperatorUiPacketEndpointEvidenceGateReport();
    for (const label of report.allowedFutureEvidenceArtifactLabels) {
      assert(/^[a-z0-9-]+$/.test(label), `${label} is a synthetic label`);
      assert(!label.includes('/') && !label.includes('\\') && !label.includes('://'), `${label} is not a path or URL`);
    }
    for (const field of ['titles', 'external IDs', 'provider names/logos', 'raw refs', 'infohashes', 'magnets', 'URLs', 'credentials', 'tokens', 'cookies', 'DB URLs', 'DB errors', 'packet contents', 'artifact contents']) {
      assert(report.forbiddenEvidenceFields.includes(field), `forbids ${field}`);
    }
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'INFOHASH_SENTINEL', 'MAGNET_SENTINEL', 'RAW_REF_SENTINEL']) {
      assert(!JSON.stringify(report).includes(sentinel), `report omits ${sentinel}`);
    }
  });

  await test('future test matrix labels include endpoint exposure blockers before route implementation', () => {
    const labels = buildOperatorUiPacketEndpointEvidenceGateReport().futureTestMatrixLabels;
    for (const label of [
      'oversized-request-target',
      'oversized-header-count',
      'request-body-rejected',
      'oversized-response-blocked',
      'method-rejection',
      'blocked-route-fixed-404',
      'raw-target-bypass-fixed-404',
      'redaction-sentinel-no-echo',
      'rate-limit-fixed-429',
    ]) {
      assert(labels.some((existing) => existing.includes(label) || label.includes(existing)), `matrix covers ${label}`);
    }
  });

  await test('text output is deterministic and parseable', () => {
    const first = formatOperatorUiPacketEndpointEvidenceGateText();
    const second = formatOperatorUiPacketEndpointEvidenceGateText();
    assert(first === second, 'text is deterministic');
    for (const line of [
      'Operator UI Packet Endpoint Evidence Gate',
      'report: operator-ui-packet-endpoint-evidence-gate',
      'version: phase-77.v1',
      'status: blocked / evidence-required',
      'endpoint exposure: blocked / not-implemented',
      'phase 75 readiness: not-ready',
      'phase 76 limits: contract-only / not-implemented',
      '- static-route-surface-regression-evidence: required-before-endpoint-exposure',
      'requirement: no packet endpoint until a reviewed local operator auth boundary exists',
      '- endpoint exposure remains blocked because required evidence artifacts do not exist',
      '- static-route-surface-regression-report',
      '- packet contents',
      '- oversized-request-target',
      '- static runtime route surface remains only GET /, GET /healthz, GET /manifest.json',
    ]) assert(first.includes(line), `text includes ${line}`);
    assert(first.endsWith('\n'), 'text ends with newline');
  });

  await test('--json CLI output is parseable, fixed, and ignores hostile env values', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-packet-endpoint-evidence-gate-cli.ts', '--json'], {
      cwd: root,
      env: {
        ...process.env,
        TOKEN: 'SECRET_TOKEN_SENTINEL',
        PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
        DATABASE_URL: 'postgres://user:pass@example.invalid/db',
        RAW_REF: 'RAW_REF_SENTINEL',
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as OperatorUiPacketEndpointEvidenceGateReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedReport), 'json output matches fixed evidence gate');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'example.invalid', 'RAW_REF_SENTINEL']) {
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
    const parsed = JSON.parse(output) as OperatorUiPacketEndpointEvidenceGateReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedReport), 'documented npm json matches fixed evidence gate');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'example.invalid']) {
      assert(!output.includes(sentinel), `documented json omits hostile input ${sentinel}`);
    }
  });

  await test('text CLI output is formatter output', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-packet-endpoint-evidence-gate-cli.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert(output === formatOperatorUiPacketEndpointEvidenceGateText(), 'CLI prints formatter output');
    assert(output.includes('status: blocked / evidence-required'), 'CLI text includes status');
  });

  await test('source and CLI have no env, file, network, DB, server, route, frontend, auth, or provider implementation scope', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
      assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
    }
    assert(pkg.scripts['test:operator-ui-packet-endpoint-evidence-gate'] === 'tsx test/operator-ui-packet-endpoint-evidence-gate.ts', 'test script');
    assert(pkg.scripts['ops:operator-ui-packet-endpoint-evidence-gate'] === 'tsx src/ops/operator-ui-packet-endpoint-evidence-gate-cli.ts', 'ops script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-packet-endpoint-limits.ts && tsx test/operator-ui-packet-endpoint-evidence-gate.ts'),
      'Phase 77 suite follows Phase 76 packet endpoint limits',
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

  await test('known routes keep fixed 405 method behavior and blocked paths keep fixed 404', async () => {
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

  await test('docs, README, deploy guard, and package wiring mention Phase 77 evidence gate', () => {
    const combined = `${read('docs/PHASE_77_OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE.md')}\n${read('README.md')}\n${read('test/deploy.ts')}\n${read('package.json')}`;
    for (const kw of [
      'Phase 77',
      'Packet Endpoint Evidence Gate',
      'operator UI packet endpoint evidence gate',
      'ops:operator-ui-packet-endpoint-evidence-gate',
      'test:operator-ui-packet-endpoint-evidence-gate',
      documentedNpmJsonCommand,
      'operator-ui-packet-endpoint-evidence-gate',
      'phase-77.v1',
      'OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE_REPORTED',
      'blocked',
      'evidence-required',
      'endpointExposure',
      'not-implemented',
      'Phase 75 readiness remains not-ready',
      'Phase 76 limits remain contract-only and not-implemented',
      'static runtime route-surface regression evidence',
      'only GET /, GET /healthz, and GET /manifest.json',
      'reviewed local operator auth boundary',
      'request target, header, body, response, packet, string, and array limits',
      'GET-only initial endpoint',
      'HEAD rejected unless explicitly reviewed',
      'POST, PUT, PATCH, DELETE, OPTIONS, and OTHER receive fixed sanitized rejections',
      'fixed 404, 405, 413, and 429',
      'only a sanitized future packet producer may feed the endpoint',
      'no direct DB, provider, or raw-ref source',
      'fixtures and synthetic packets only',
      'oversized target, header, body, response',
      'method rejection',
      'blocked route',
      'raw-target bypass',
      'redaction sentinel',
      'independent reviewer GO',
      'operator packet and review record',
      'no endpoint route handler',
      'no runtime auth implementation',
      'no API framework',
      'no DB/env/fs reads',
      'no network calls',
      'no provider integration',
      'no frontend or browser JavaScript',
      'no packet ingestion',
      'no playback/download/scraping/media-server behavior',
    ]) assert(combined.includes(kw), `Phase 77 docs/deploy include ${kw}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
