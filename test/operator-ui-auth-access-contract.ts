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
  buildOperatorUiAuthAccessContractReport,
  formatOperatorUiAuthAccessContractText,
  type OperatorUiAuthAccessContractReport,
} from '../src/ops/operator-ui-auth-access-contract.js';

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
  readonly body: string;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const documentedNpmJsonCommand = 'npm run --silent ops:operator-ui-auth-access-contract -- -- --json';

const expectedContract: OperatorUiAuthAccessContractReport = {
  ok: true,
  code: 'OPERATOR_UI_AUTH_ACCESS_CONTRACT_REPORTED',
  message: 'Operator UI auth/access contract is fixed, contract-only, and no-input.',
  contractName: 'operator-ui-auth-access-contract',
  contractVersion: 'phase-74.v1',
  status: {
    implementation: 'not-implemented',
    phase: 'contract-only',
  },
  runtimeExposureAllowedNow: '127.0.0.1 fixture preview only',
  remoteExposure: 'blocked until explicit future phase',
  futureAuthMechanisms: [
    {
      id: 'operator-local-secret-file',
      status: 'future-review-only/not-implemented',
      boundary: 'Candidate category only; no secret file path, read, parsing, or validation is implemented.',
    },
    {
      id: 'reverse-proxy-forward-auth-attestation',
      status: 'future-review-only/not-implemented',
      boundary: 'Candidate category only; no reverse-proxy header, TLS, public bind, or proxy support is implemented.',
    },
    {
      id: 'mTLS-or-local-network-attestation',
      status: 'future-review-only/not-implemented',
      boundary: 'Candidate category only; no certificate, socket, TLS, or network attestation code is implemented.',
    },
  ],
  hardRequirementsBeforePacketOrDataRoute: [
    'Explicit Clint authorization and independent reviewer GO are required',
    'No public bind without a reviewed deployment/auth model',
    'No direct DB reads from UI runtime',
    'Sanitized packet source only after Phase 69 contract and auth/access review',
    'All operator-facing outputs must be redaction-safe',
    'No credentials/tokens/cookies/session values in logs, docs, or evidence',
    'Rate, size, method, and raw-target fail-closed behavior must be retained',
    'O4 and O5 remain open unless separately proven',
    'FileCustodian remains a hardened reference harness only',
  ],
  forbiddenRoutesUntilLaterPhase: [
    '/api/*',
    '/packets',
    '/login',
    '/session',
    '/auth',
    '/token',
    '/callback',
    '/logout',
    '/oauth',
    '/sso',
    '/admin',
  ],
  forbiddenRuntimeBehaviorUntilLaterPhase: [
    'runtime cookie/session/token/bearer/basic parsing',
    'environment/config/file secret reads',
    'TLS, reverse-proxy, or public-bind implementation',
    'frontend framework or browser JavaScript',
    'direct DB reads, provider calls, packet source, playback, download, scraping, or media-server logic',
  ],
  retainedFailClosedRuntimeBehavior: [
    'Runtime route surface remains only GET /, GET /healthz, and GET /manifest.json',
    'Blocked auth/data paths return fixed 404 responses',
    'Known routes reject unsupported methods with fixed 405 responses',
    'Request bodies are ignored and never echoed',
    'Raw request-target bypass forms remain fixed 404',
  ],
  openBoundaries: [
    'Remote exposure remains blocked until explicit future phase',
    'Provider availability remains packet/count/advisory only',
    'O4 production custodian is open/deferred',
    'O5 managed KEK custody/scheduling is open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
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
      const statusCode = Number(head.split('\r\n')[0]?.split(' ')[1] ?? 0);
      resolve({ statusCode, body: responseBody });
    });
  });
}

function assertNoRuntimeAuthOrDataParserSource(source: string): void {
  for (const forbidden of [
    'process.env',
    "from 'node:fs'",
    'from "node:fs"',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'from "pg"',
    'createServer',
    'server.listen',
    'req.headers',
    '.headers.authorization',
    "headers['authorization']",
    'getHeader',
    'setHeader',
    'parseCookie',
    'cookieParser',
    'sessionStorage',
    'localStorage',
    'Set-Cookie',
    'Basic ',
    'Bearer ',
    'password=',
    'token=',
  ]) assert(!source.includes(forbidden), `contract source excludes runtime/parser scope ${forbidden}`);
}

async function main(): Promise<void> {
  console.log('Running Phase 74 operator UI auth/access contract suite:\n');

  await test('auth/access contract report is deterministic, fixed, and no-input', () => {
    const first = buildOperatorUiAuthAccessContractReport();
    const second = buildOperatorUiAuthAccessContractReport();
    assert(JSON.stringify(first) === JSON.stringify(expectedContract), 'first report matches expected object');
    assert(JSON.stringify(second) === JSON.stringify(expectedContract), 'second report matches expected object');
    assert(JSON.stringify(first) === JSON.stringify(second), 'reports serialize deterministically');
    assert(JSON.stringify(Object.keys(first)) === JSON.stringify([
      'ok',
      'code',
      'message',
      'contractName',
      'contractVersion',
      'status',
      'runtimeExposureAllowedNow',
      'remoteExposure',
      'futureAuthMechanisms',
      'hardRequirementsBeforePacketOrDataRoute',
      'forbiddenRoutesUntilLaterPhase',
      'forbiddenRuntimeBehaviorUntilLaterPhase',
      'retainedFailClosedRuntimeBehavior',
      'openBoundaries',
    ]), 'key ordering is fixed');
  });

  await test('builder returns defensive copies for arrays and nested array items', () => {
    const report = buildOperatorUiAuthAccessContractReport();
    (report.futureAuthMechanisms as unknown as Array<{ id: string }>)[0] = {
      id: 'mutated',
    };
    (report.hardRequirementsBeforePacketOrDataRoute as unknown as string[]).push('mutated');
    (report.forbiddenRoutesUntilLaterPhase as unknown as string[]).push('/mutated');
    (report.forbiddenRuntimeBehaviorUntilLaterPhase as unknown as string[]).push('mutated');
    (report.retainedFailClosedRuntimeBehavior as unknown as string[]).push('mutated');
    (report.openBoundaries as unknown as string[]).push('mutated');
    assert(JSON.stringify(buildOperatorUiAuthAccessContractReport()) === JSON.stringify(expectedContract), 'fresh report is not affected by mutation');
  });

  await test('contract status, current exposure, and remote block are explicit', () => {
    const report = buildOperatorUiAuthAccessContractReport();
    assert(report.contractName === 'operator-ui-auth-access-contract', 'fixed name');
    assert(report.contractVersion === 'phase-74.v1', 'fixed version');
    assert(report.status.implementation === 'not-implemented', 'auth implementation not implemented');
    assert(report.status.phase === 'contract-only', 'contract-only status');
    assert(report.runtimeExposureAllowedNow === '127.0.0.1 fixture preview only', 'loopback fixture preview only');
    assert(report.remoteExposure === 'blocked until explicit future phase', 'remote exposure blocked');
  });

  await test('future auth mechanisms are abstract labels only', () => {
    const json = JSON.stringify(buildOperatorUiAuthAccessContractReport());
    for (const required of [
      'operator-local-secret-file',
      'reverse-proxy-forward-auth-attestation',
      'mTLS-or-local-network-attestation',
      'future-review-only/not-implemented',
      'Candidate category only',
      'no secret file path, read, parsing, or validation is implemented',
      'no reverse-proxy header, TLS, public bind, or proxy support is implemented',
      'no certificate, socket, TLS, or network attestation code is implemented',
    ]) assert(json.includes(required), `contract includes ${required}`);
  });

  await test('hard gates before packet or data routes are complete', () => {
    const json = JSON.stringify(buildOperatorUiAuthAccessContractReport());
    for (const required of [
      'Explicit Clint authorization and independent reviewer GO are required',
      'No public bind without a reviewed deployment/auth model',
      'No direct DB reads from UI runtime',
      'Sanitized packet source only after Phase 69 contract and auth/access review',
      'All operator-facing outputs must be redaction-safe',
      'No credentials/tokens/cookies/session values in logs, docs, or evidence',
      'Rate, size, method, and raw-target fail-closed behavior must be retained',
      'O4 and O5 remain open unless separately proven',
      'FileCustodian remains a hardened reference harness only',
    ]) assert(json.includes(required), `hard gate includes ${required}`);
  });

  await test('forbidden auth and data surfaces stay future-gated', () => {
    const report = buildOperatorUiAuthAccessContractReport();
    for (const route of ['/api/*', '/packets', '/login', '/session', '/auth', '/token', '/callback', '/logout', '/oauth', '/sso', '/admin']) {
      assert(report.forbiddenRoutesUntilLaterPhase.includes(route), `forbids ${route}`);
    }
    const json = JSON.stringify(report);
    for (const forbidden of [
      'runtime cookie/session/token/bearer/basic parsing',
      'environment/config/file secret reads',
      'TLS, reverse-proxy, or public-bind implementation',
      'frontend framework or browser JavaScript',
      'direct DB reads, provider calls, packet source, playback, download, scraping, or media-server logic',
    ]) assert(json.includes(forbidden), `forbids ${forbidden}`);
  });

  await test('text output is deterministic and contains the contract gate', () => {
    const first = formatOperatorUiAuthAccessContractText();
    const second = formatOperatorUiAuthAccessContractText();
    assert(first === second, 'text is deterministic');
    for (const line of [
      'Operator UI Auth/Access Contract Gate',
      'contract: operator-ui-auth-access-contract',
      'version: phase-74.v1',
      'implementation: not-implemented',
      'phase: contract-only',
      'runtime exposure allowed now: 127.0.0.1 fixture preview only',
      'remote exposure: blocked until explicit future phase',
      '- /api/*',
      '- /token',
      '- Runtime route surface remains only GET /, GET /healthz, and GET /manifest.json',
    ]) assert(first.includes(line), `text includes ${line}`);
    assert(first.endsWith('\n'), 'text ends with newline');
  });

  await test('--json CLI output is parseable and ignores hostile process inputs', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-auth-access-contract-cli.ts', '--json'], {
      cwd: root,
      env: {
        ...process.env,
        TOKEN: 'SECRET_TOKEN_SENTINEL',
        PRIVATE_TITLE: 'Private Movie Sentinel',
        DATABASE_URL: 'postgres://user:pass@example.invalid/db',
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as OperatorUiAuthAccessContractReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedContract), 'json output matches fixed contract');
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
    const parsed = JSON.parse(output) as OperatorUiAuthAccessContractReport;
    assert(JSON.stringify(parsed) === JSON.stringify(expectedContract), 'documented npm json matches fixed contract');
    for (const sentinel of ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://', 'example.invalid']) {
      assert(!output.includes(sentinel), `documented json omits hostile input ${sentinel}`);
    }
  });

  await test('text CLI output is formatter output', () => {
    const output = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-auth-access-contract-cli.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert(output === formatOperatorUiAuthAccessContractText(), 'CLI prints formatter output');
    assert(output.includes('- reverse-proxy-forward-auth-attestation: future-review-only/not-implemented'), 'CLI text includes abstract future category');
  });

  await test('contract and CLI source have no runtime auth/data parser, env, file, network, or DB execution scope', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of ['react', 'vite', 'next', 'express', 'fastify', 'koa', '@vitejs/plugin-react', 'cheerio', 'jsdom']) {
      assert(!allDeps.includes(dep), `no UI/API dependency ${dep}`);
    }
    assert(pkg.scripts['test:operator-ui-auth-access-contract'] === 'tsx test/operator-ui-auth-access-contract.ts', 'test script');
    assert(pkg.scripts['ops:operator-ui-auth-access-contract'] === 'tsx src/ops/operator-ui-auth-access-contract-cli.ts', 'ops script');
    assert(
      (pkg.scripts.test ?? '').includes('test/operator-ui-static-runtime-access-boundary.ts && tsx test/operator-ui-auth-access-contract.ts'),
      'Phase 74 suite follows Phase 73 access-boundary suite',
    );

    const source = read('src/ops/operator-ui-auth-access-contract.ts');
    const cliSource = read('src/ops/operator-ui-auth-access-contract-cli.ts');
    assertNoRuntimeAuthOrDataParserSource(`${source}\n${cliSource}`);
    for (const forbidden of [
      '@torbox/torbox-api',
      'react',
      'vite',
      'next',
      'express',
      'fastify',
      'koa',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'document.',
      'window.',
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
    ]) assert(!`${source}\n${cliSource}`.includes(forbidden), `source excludes ${forbidden}`);
  });

  await test('runtime route surface remains root, health, and manifest only', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/', '/healthz', '/manifest.json']) {
        const response = await httpRequest(runtime.port, path);
        assert(response.statusCode === 200, `${path} remains served`);
      }

      for (const path of ['/api/packets', '/api/status', '/packets', '/login', '/session', '/auth', '/token', '/callback', '/logout', '/oauth', '/sso', '/admin']) {
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

  await test('known routes keep method/body fail-closed behavior', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/', '/healthz', '/manifest.json']) {
        const head = await httpRequest(runtime.port, path, 'HEAD');
        assert(head.statusCode === 405, `${path} HEAD fixed 405`);
        assert(head.body === '', `${path} HEAD empty body`);
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
          const response = await httpRequest(runtime.port, path, method, 'cookie=session&token=SECRET_TOKEN_SENTINEL');
          assert(response.statusCode === 405, `${path} ${method} fixed 405`);
          assert(response.body === 'method not allowed\n', `${path} ${method} fixed body`);
          assert(!response.body.includes('SECRET_TOKEN_SENTINEL'), `${path} ${method} no body echo`);
        }
      }
    } finally {
      await runtime.close();
    }
  });

  await test('raw request-target bypass forms around blocked auth/data paths stay fixed 404', async () => {
    const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
    try {
      for (const target of [
        'http://evil/api/packets',
        'https://evil/login',
        '//evil/session',
        '///auth',
        '/api%2fpackets',
        '/token%5c..',
        '/callback/%2e%2e',
        '/logout\\..',
        '/oauth/%2e',
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

  await test('docs, README, and deploy guard mention Phase 74 auth/access contract', () => {
    const combined = `${read('docs/PHASE_74_OPERATOR_UI_AUTH_ACCESS_CONTRACT.md')}\n${read('README.md')}\n${read('test/deploy.ts')}`;
    for (const kw of [
      'Phase 74',
      'Operator UI Auth/Access Contract Gate',
      'operator UI auth/access contract',
      'ops:operator-ui-auth-access-contract',
      'test:operator-ui-auth-access-contract',
      documentedNpmJsonCommand,
      'operator-ui-auth-access-contract',
      'phase-74.v1',
      'not-implemented',
      'contract-only',
      '127.0.0.1 fixture preview only',
      'blocked until explicit future phase',
      'operator-local-secret-file',
      'reverse-proxy-forward-auth-attestation',
      'mTLS-or-local-network-attestation',
      'explicit Clint authorization and independent reviewer GO',
      'no public bind without a reviewed deployment/auth model',
      'no direct DB reads from UI runtime',
      'Sanitized packet source only after Phase 69 contract and auth/access review',
      'redaction-safe',
      'No credentials/tokens/cookies/session values in logs, docs, or evidence',
      'rate, size, method, and raw-target fail-closed behavior',
      '/api/*',
      '/packets',
      '/login',
      '/session',
      '/auth',
      '/token',
      '/callback',
      '/logout',
      '/oauth',
      '/sso',
      '/admin',
      'cookie/session/token/bearer/basic parsing',
      'env/config/file secret reads',
      'TLS/reverse-proxy/public-bind implementation',
      'frontend framework/browser JavaScript',
      'GET /manifest.json',
      'O4 and O5 remain open/deferred',
      'FileCustodian remains a hardened reference harness, not production KMS',
      'Provider availability remains packet/count/advisory only',
    ]) assert(combined.includes(kw), `Phase 74 docs/deploy include ${kw}`);
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

void main();
