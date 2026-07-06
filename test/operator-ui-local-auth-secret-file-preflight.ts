import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiLocalAuthSecretFilePreflightInputErrorReport,
  buildOperatorUiLocalAuthSecretFilePreflightReport,
  formatOperatorUiLocalAuthSecretFilePreflightJson,
  formatOperatorUiLocalAuthSecretFilePreflightText,
  parseOperatorUiLocalAuthSecretFilePreflightDescriptorJson,
  type OperatorUiLocalAuthSecretFilePreflightDescriptor,
  type OperatorUiLocalAuthSecretFilePreflightReport,
} from '../src/ops/operator-ui-local-auth-secret-file-preflight.js';
import {
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
  startOperatorUiStaticRuntime,
} from '../src/ops/operator-ui-static-runtime.js';
import { request } from 'node:http';
import { connect } from 'node:net';

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

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

interface HttpResult {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const documentedNpmJsonCommand =
  'npm run --silent ops:operator-ui-local-auth-secret-file-preflight -- -- <descriptor.json> --json';

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
}

function completeDescriptor(
  overrides: Partial<OperatorUiLocalAuthSecretFilePreflightDescriptor> = {},
): OperatorUiLocalAuthSecretFilePreflightDescriptor {
  return {
    boundaryId: 'local-operator-secret-file-with-explicit-path-and-redacted-evidence',
    operatorFilePathProvided: true,
    defaultPathDisabled: true,
    envSecretValueDisabled: true,
    cliSecretValueDisabled: true,
    maxSecretFileBytes: 4096,
    trimOneTrailingNewlineOnly: true,
    rejectEmptyOrWhitespace: true,
    rejectLowEntropyOrShort: true,
    constantTimeComparisonPlanned: true,
    secretNeverLoggedOrPersisted: true,
    redactionSafeErrors: true,
    loopbackOnly: true,
    browserStorageCookieSessionBearerBasicOAuthDisabled: true,
    reviewerGoRecorded: true,
    operatorAcceptanceRecorded: true,
    ...overrides,
  };
}

function codes(report: OperatorUiLocalAuthSecretFilePreflightReport): Set<string> {
  return new Set(report.findings.map((finding) => finding.code));
}

function assertNoLeak(output: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output leaked sentinel: ${sentinel}`);
}

function writeDescriptor(dir: string, name: string, descriptor: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof descriptor === 'string' ? descriptor : JSON.stringify(descriptor), 'utf8');
  return path;
}

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/operator-ui-local-auth-secret-file-preflight-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runNpm(args: string[]) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npm, ['run', '--silent', 'ops:operator-ui-local-auth-secret-file-preflight', '--', ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
  });
}

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

console.log('Running Phase 80 operator UI local auth secret file preflight suite:\n');

await test('pure evaluation is deterministic and defensively copied', () => {
  const first = buildOperatorUiLocalAuthSecretFilePreflightReport(completeDescriptor() as unknown as Record<string, unknown>);
  const second = buildOperatorUiLocalAuthSecretFilePreflightReport(completeDescriptor() as unknown as Record<string, unknown>);
  assert(JSON.stringify(first) === JSON.stringify(second), 'reports serialize deterministically');
  assert(first.reportName === 'operator-ui-local-auth-secret-file-preflight', 'fixed report name');
  assert(first.reportVersion === 'phase-80.v1', 'fixed report version');
  assert(first.code === 'OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT_REPORTED', 'fixed report code');
  assert(first.status === 'ready-for-review/preflight-only', 'complete descriptor is ready for review only');
  assert(first.authImplementation === 'not-implemented', 'auth remains not implemented');
  assert(first.runtimeAuthBlocked === true, 'runtime auth remains blocked');
  assert(JSON.stringify(first.currentStaticRuntimeRoutes) === JSON.stringify(['GET /', 'GET /healthz', 'GET /manifest.json']), 'static routes unchanged');
  assert(first.secretFileRead === false, 'pure report does not read a secret file');
  assert(first.secretPathValidatedAgainstFilesystem === false, 'pure report does not validate secret path');

  (first.findings as unknown as Array<{ code: string }>)[0] = { code: 'MUTATED' };
  (first.gates as unknown as Array<{ id: string }>)[0] = { id: 'mutated' };
  (first.currentStaticRuntimeRoutes as unknown as string[]).push('POST /auth');
  (first.blockedUntilExplicitLaterImplementationReview as unknown as string[]).push('mutated');
  (first.forbiddenDescriptorFields as unknown as string[]).push('mutated');

  const fresh = buildOperatorUiLocalAuthSecretFilePreflightReport(completeDescriptor() as unknown as Record<string, unknown>);
  assert(JSON.stringify(fresh) === JSON.stringify(second), 'fresh report is not affected by mutation');
});

await test('complete descriptor reports ready for review only while runtime auth remains blocked', () => {
  const report = buildOperatorUiLocalAuthSecretFilePreflightReport(completeDescriptor() as unknown as Record<string, unknown>);
  assert(report.ok === true, 'complete descriptor ok');
  assert(report.summary.fail === 0, 'no fail findings');
  assert(report.status === 'ready-for-review/preflight-only', 'ready for review only');
  assert(report.authImplementation === 'not-implemented', 'auth not implemented');
  assert(report.descriptorValuesEchoed === false && report.descriptorPathEchoed === false, 'no descriptor echo');
  assert(report.secretFileRead === false, 'no secret-file read');
  assert(report.gates.some((gate) => gate.id === 'runtime-auth-implementation' && gate.status === 'blocked'), 'runtime auth implementation gate blocked');
  assert(report.gates.some((gate) => gate.id === 'static-route-surface-regression' && gate.status === 'blocked'), 'static route regression gate blocked');
  assert(codes(report).has('BOUNDARY_ID_ACCEPTED'), 'boundary id accepted');
  assert(codes(report).has('SECRET_FILE_BYTE_BOUND_ACCEPTED'), 'byte bound accepted');
});

await test('incomplete descriptor fails closed with fixed codes', () => {
  const report = buildOperatorUiLocalAuthSecretFilePreflightReport(completeDescriptor({
    operatorFilePathProvided: false,
    maxSecretFileBytes: 4097,
    reviewerGoRecorded: false,
    operatorAcceptanceRecorded: false,
  }) as unknown as Record<string, unknown>);
  const got = codes(report);
  assert(report.ok === false, 'incomplete descriptor not ok');
  assert(report.status === 'blocked/preflight-only', 'incomplete descriptor blocked');
  assert(report.authImplementation === 'not-implemented', 'auth still not implemented');
  for (const code of [
    'OPERATOR_FILE_PATH_PROVIDED_REQUIRED',
    'SECRET_FILE_BYTE_BOUND_REQUIRED',
    'REVIEWER_GO_RECORDED_REQUIRED',
    'OPERATOR_ACCEPTANCE_RECORDED_REQUIRED',
  ]) assert(got.has(code), `report includes ${code}`);
});

await test('dangerous fields, unknown fields, and hostile values do not appear in JSON or text output', () => {
  const sentinels = [
    'SECRET_VALUE_SENTINEL',
    'TOKEN_VALUE_SENTINEL',
    'PASSWORD_VALUE_SENTINEL',
    'postgres://user:pass@example.invalid/db',
    'https://provider.example.invalid/path?token=abc',
    'MAGNET_VALUE_SENTINEL',
    'INFOHASH_VALUE_SENTINEL',
    'Private Movie Title 1999',
    'PACKET_CONTENT_VALUE_SENTINEL',
    'ARTIFACT_CONTENT_VALUE_SENTINEL',
    'RAW_REF_VALUE_SENTINEL',
  ];
  const descriptor = {
    ...completeDescriptor(),
    secret: sentinels[0],
    secretValue: sentinels[0],
    path: 'C:/Users/clint/secret-value.txt',
    secretPath: 'C:/Users/clint/secret-path.txt',
    filePath: 'C:/Users/clint/file-path.txt',
    token: sentinels[1],
    password: sentinels[2],
    authorization: 'Bearer TOKEN_VALUE_SENTINEL',
    cookie: 'sid=TOKEN_VALUE_SENTINEL',
    url: sentinels[4],
    databaseUrl: sentinels[3],
    rawRef: sentinels[10],
    infohash: sentinels[6],
    magnet: sentinels[5],
    title: sentinels[7],
    providerName: 'ProviderNameSentinel',
    packetContents: sentinels[8],
    artifactContents: sentinels[9],
    surpriseValue: 'UNKNOWN_FIELD_SENTINEL',
  };
  const report = buildOperatorUiLocalAuthSecretFilePreflightReport(descriptor);
  const output = `${formatOperatorUiLocalAuthSecretFilePreflightJson(report)}\n${formatOperatorUiLocalAuthSecretFilePreflightText(report)}`;
  assert(report.status === 'blocked/preflight-only', 'dangerous descriptor blocked');
  assert(codes(report).has('DANGEROUS_DESCRIPTOR_FIELD_REJECTED'), 'dangerous field rejected');
  assert(codes(report).has('UNKNOWN_DESCRIPTOR_FIELD_REJECTED'), 'unknown field rejected');
  assertNoLeak(output, [...sentinels, 'ProviderNameSentinel', 'UNKNOWN_FIELD_SENTINEL', 'example.invalid']);
});

await test('malformed, non-object, array, missing, directory, and oversized descriptor inputs fail closed without path or value leaks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-80-preflight-'));
  const missingPath = join(tmp, 'missing-descriptor.json');
  const sentinel = 'SECRET_VALUE_SHOULD_NOT_APPEAR';
  try {
    assert(parseOperatorUiLocalAuthSecretFilePreflightDescriptorJson(`{"boundaryId":"${sentinel}"`) === 'DESCRIPTOR_JSON_MALFORMED', 'malformed JSON rejected');
    assert(parseOperatorUiLocalAuthSecretFilePreflightDescriptorJson(JSON.stringify([{ boundaryId: sentinel }])) === 'DESCRIPTOR_OBJECT_REQUIRED', 'array JSON rejected');
    assert(parseOperatorUiLocalAuthSecretFilePreflightDescriptorJson(JSON.stringify(sentinel)) === 'DESCRIPTOR_OBJECT_REQUIRED', 'primitive JSON rejected');

    for (const code of [
      'DESCRIPTOR_FILE_REQUIRED',
      'DESCRIPTOR_FILE_READ_FAILED',
      'DESCRIPTOR_FILE_IS_DIRECTORY',
      'DESCRIPTOR_FILE_TOO_LARGE',
      'DESCRIPTOR_JSON_MALFORMED',
      'DESCRIPTOR_OBJECT_REQUIRED',
    ] as const) {
      const report = buildOperatorUiLocalAuthSecretFilePreflightInputErrorReport(code);
      const output = `${formatOperatorUiLocalAuthSecretFilePreflightJson(report)}\n${formatOperatorUiLocalAuthSecretFilePreflightText(report)}`;
      assert(report.status === 'blocked/preflight-only', `${code} blocks`);
      assert(report.authImplementation === 'not-implemented', `${code} auth not implemented`);
      assertNoLeak(output, [sentinel, missingPath, tmp]);
    }

    const missingRun = runCli(['--', missingPath, '--json']);
    assert(missingRun.status === 1, 'missing descriptor exits with failure');
    assert(codes(JSON.parse(missingRun.stdout) as OperatorUiLocalAuthSecretFilePreflightReport).has('DESCRIPTOR_FILE_READ_FAILED'), 'missing uses fixed code');
    assertNoLeak(`${missingRun.stdout}\n${missingRun.stderr}`, [missingPath, tmp]);

    const directoryRun = runCli(['--', tmp, '--json']);
    assert(directoryRun.status === 1, 'directory descriptor exits with failure');
    assert(codes(JSON.parse(directoryRun.stdout) as OperatorUiLocalAuthSecretFilePreflightReport).has('DESCRIPTOR_FILE_IS_DIRECTORY'), 'directory uses fixed code');
    assertNoLeak(`${directoryRun.stdout}\n${directoryRun.stderr}`, [tmp]);

    const oversized = writeDescriptor(tmp, 'oversized.json', 'x'.repeat(17 * 1024));
    const oversizedRun = runCli(['--', oversized, '--json']);
    assert(oversizedRun.status === 1, 'oversized descriptor exits with failure');
    assert(codes(JSON.parse(oversizedRun.stdout) as OperatorUiLocalAuthSecretFilePreflightReport).has('DESCRIPTOR_FILE_TOO_LARGE'), 'oversized uses fixed code');
    assertNoLeak(`${oversizedRun.stdout}\n${oversizedRun.stderr}`, [oversized, tmp]);

    const malformed = writeDescriptor(tmp, 'malformed.json', `{"secret":"${sentinel}"`);
    const malformedRun = runCli(['--', malformed, '--json']);
    assert(malformedRun.status === 1, 'malformed descriptor exits with failure');
    assert(codes(JSON.parse(malformedRun.stdout) as OperatorUiLocalAuthSecretFilePreflightReport).has('DESCRIPTOR_JSON_MALFORMED'), 'malformed uses fixed code');
    assertNoLeak(`${malformedRun.stdout}\n${malformedRun.stderr}`, [malformed, tmp, sentinel]);

    const arrayPath = writeDescriptor(tmp, 'array.json', [{ secret: sentinel }]);
    const arrayRun = runCli(['--', arrayPath, '--json']);
    assert(arrayRun.status === 1, 'array descriptor exits with failure');
    assert(codes(JSON.parse(arrayRun.stdout) as OperatorUiLocalAuthSecretFilePreflightReport).has('DESCRIPTOR_OBJECT_REQUIRED'), 'array uses fixed code');
    assertNoLeak(`${arrayRun.stdout}\n${arrayRun.stderr}`, [arrayPath, tmp, sentinel]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test('CLI reads only the descriptor file and never reads secret path values inside it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-80-secret-path-'));
  try {
    const secretPath = join(tmp, 'secret-file.txt');
    const descriptorPath = writeDescriptor(tmp, 'descriptor.json', {
      ...completeDescriptor(),
      secretPath,
      filePath: secretPath,
      secretValue: 'SECRET_FILE_CONTENT_SENTINEL',
    });
    writeFileSync(secretPath, 'SECRET_FILE_CONTENT_SENTINEL', 'utf8');
    const result = runCli(['--', descriptorPath, '--json']);
    assert(result.status === 1, 'descriptor with forbidden secret path exits with failure');
    const report = JSON.parse(result.stdout) as OperatorUiLocalAuthSecretFilePreflightReport;
    assert(report.secretFileRead === false, 'report says no secret file read');
    assert(report.secretPathValidatedAgainstFilesystem === false, 'report says no secret path filesystem validation');
    assert(codes(report).has('DANGEROUS_DESCRIPTOR_FIELD_REJECTED'), 'secret path field rejected');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [descriptorPath, secretPath, tmp, 'SECRET_FILE_CONTENT_SENTINEL']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test('documented npm JSON command emits parseable redaction-safe JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-80-npm-'));
  try {
    const descriptorPath = writeDescriptor(tmp, 'descriptor.json', completeDescriptor());
    const result = runNpm(['--', descriptorPath, '--json']);
    assert(result.status === 0, `npm script exits 0: ${result.stderr ?? result.error?.message}`);
    const parsed = JSON.parse(result.stdout) as OperatorUiLocalAuthSecretFilePreflightReport;
    assert(parsed.reportName === 'operator-ui-local-auth-secret-file-preflight', 'stdout is Phase 80 JSON report');
    assert(parsed.status === 'ready-for-review/preflight-only', 'npm JSON ready for review only');
    assert(parsed.authImplementation === 'not-implemented', 'npm JSON auth not implemented');
    assert(parsed.runtimeAuthBlocked === true, 'npm JSON runtime auth blocked');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [descriptorPath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test('CLI JSON and text output ignore hostile environment values', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-80-env-'));
  try {
    const descriptorPath = writeDescriptor(tmp, 'descriptor.json', completeDescriptor());
    const env = {
      TOKEN: 'ENV_TOKEN_SENTINEL',
      PASSWORD: 'ENV_PASSWORD_SENTINEL',
      DATABASE_URL: 'postgres://user:pass@example.invalid/db',
      PRIVATE_TITLE: 'ENV_PRIVATE_TITLE_SENTINEL',
      OPERATOR_SECRET_FILE: 'ENV_SECRET_PATH_SENTINEL',
    };
    const json = runCli(['--', descriptorPath, '--json'], env);
    const text = runCli(['--', descriptorPath], env);
    assert(json.status === 0, 'json exits 0');
    assert(text.status === 0, 'text exits 0');
    assertNoLeak(`${json.stdout}\n${json.stderr}\n${text.stdout}\n${text.stderr}`, [
      descriptorPath,
      tmp,
      'ENV_TOKEN_SENTINEL',
      'ENV_PASSWORD_SENTINEL',
      'postgres://',
      'example.invalid',
      'ENV_PRIVATE_TITLE_SENTINEL',
      'ENV_SECRET_PATH_SENTINEL',
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test('pure module has no fs, env, network, DB, runtime route, or secret-read scope', () => {
  const source = read('src/ops/operator-ui-local-auth-secret-file-preflight.ts');
  for (const forbidden of [
    'process.',
    'node:fs',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'openSync',
    'readSync',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'from "pg"',
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'createServer',
    'server.listen',
    'req.headers',
    'res.end',
  ]) assert(!source.includes(forbidden), `pure source excludes ${forbidden}`);
});

await test('CLI performs only bounded descriptor read and no secret/runtime implementation', () => {
  const source = read('src/ops/operator-ui-local-auth-secret-file-preflight.ts');
  const cli = read('src/ops/operator-ui-local-auth-secret-file-preflight-cli.ts');
  const combined = `${source}\n${cli}`;
  assert(cli.includes("from 'node:fs'"), 'CLI imports fs for descriptor read only');
  assert(cli.includes('MAX_DESCRIPTOR_BYTES = 16 * 1024'), 'CLI has descriptor read bound');
  assert(cli.includes('fstatSync') && cli.includes('stat.size > MAX_DESCRIPTOR_BYTES'), 'CLI bounds read before reading');
  for (const forbidden of [
    'process.env',
    'readFileSync',
    'readdirSync',
    'existsSync',
    'createReadStream',
    'writeFile',
    'createWriteStream',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'from "pg"',
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'crypto.timingSafeEqual',
    'timingSafeEqual',
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
    'Set-Cookie',
    '.headers.authorization',
    "headers['authorization']",
    'getHeader',
    'setHeader',
    'parseCookie',
    'cookieParser',
    'localStorage',
    'sessionStorage',
    'Real-Debrid',
    'TorBoxReadOnlyClient',
    'ProviderAdapter',
    'Plex',
    'Jellyfin',
    'Hermes',
  ]) assert(!combined.includes(forbidden), `Phase 80 source/CLI excludes ${forbidden}`);
});

await test('static runtime route behavior remains unchanged', async () => {
  const runtime = await startOperatorUiStaticRuntime({ host: '127.0.0.1', port: 0 });
  try {
    for (const path of ['/', '/healthz', '/manifest.json']) {
      const response = await httpRequest(runtime.port, path);
      assert(response.statusCode === 200, `${path} remains served`);
    }

    for (const path of ['/login', '/auth', '/session', '/token', '/callback', '/logout', '/oauth', '/sso', '/admin', '/api/packets', '/packets', '/packet', '/operator-packets']) {
      const get = await httpRequest(runtime.port, path);
      const post = await httpRequest(runtime.port, path, 'POST', 'SECRET_TOKEN_SENTINEL=must-not-leak');
      assert(get.statusCode === 404, `${path} GET fixed 404`);
      assert(get.body === 'not found\n', `${path} GET fixed body`);
      assert(post.statusCode === 404, `${path} POST fixed 404`);
      assert(post.body === 'not found\n', `${path} POST fixed body`);
      assert(!post.body.includes('SECRET_TOKEN_SENTINEL'), `${path} no body echo`);
    }

    for (const path of ['/', '/healthz', '/manifest.json']) {
      const response = await httpRequest(runtime.port, path, 'POST', 'token=SECRET_TOKEN_SENTINEL');
      assert(response.statusCode === 405, `${path} POST fixed 405`);
      assert(response.headers.allow === 'GET', `${path} Allow GET`);
      assert(response.body === 'method not allowed\n', `${path} POST fixed body`);
    }

    for (const target of ['http://evil/login', 'https://evil/auth', '//evil/session', '///token', '/api%2fpackets', '/operator-packets/%2e']) {
      const response = await rawHttpRequest(runtime.port, target, 'POST', 'SECRET_TOKEN_SENTINEL=must-not-leak');
      assert(response.statusCode === 404, `${target} status 404`);
      assert(response.body === 'not found\n', `${target} fixed body`);
      assert(!response.body.includes('SECRET_TOKEN_SENTINEL'), `${target} no body echo`);
    }
  } finally {
    await runtime.close();
  }
});

await test('README, docs, package, and deploy guard are wired for Phase 80', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['test:operator-ui-local-auth-secret-file-preflight'] === 'tsx test/operator-ui-local-auth-secret-file-preflight.ts', 'test script');
  assert(pkg.scripts['ops:operator-ui-local-auth-secret-file-preflight'] === 'tsx src/ops/operator-ui-local-auth-secret-file-preflight-cli.ts', 'ops script');
  assert(
    (pkg.scripts.test ?? '').includes('test/operator-ui-local-auth-boundary.ts && tsx test/operator-ui-local-auth-secret-file-preflight.ts'),
    'Phase 80 suite follows Phase 79 local auth boundary in CI chain',
  );

  const combined = `${read('docs/PHASE_80_OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT.md')}\n${read('README.md')}\n${read('test/deploy.ts')}\n${read('package.json')}`;
  for (const kw of [
    'Phase 80',
    'Local Auth Secret File Preflight',
    'operator UI local auth secret-file preflight',
    'ops:operator-ui-local-auth-secret-file-preflight',
    'test:operator-ui-local-auth-secret-file-preflight',
    documentedNpmJsonCommand,
    'operator-ui-local-auth-secret-file-preflight',
    'phase-80.v1',
    'OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT_REPORTED',
    'ready-for-review/preflight-only',
    'blocked/preflight-only',
    'authImplementation',
    'not-implemented',
    'local-operator-secret-file-with-explicit-path-and-redacted-evidence',
    'single explicit operator JSON descriptor file',
    'descriptor path is never echoed',
    'descriptor values are never echoed',
    'future secret file path is not read',
    'future secret path is not validated against the filesystem',
    'operatorFilePathProvided',
    'defaultPathDisabled',
    'envSecretValueDisabled',
    'cliSecretValueDisabled',
    'maxSecretFileBytes',
    '<= 4096',
    'trimOneTrailingNewlineOnly',
    'rejectEmptyOrWhitespace',
    'rejectLowEntropyOrShort',
    'constantTimeComparisonPlanned',
    'secretNeverLoggedOrPersisted',
    'redactionSafeErrors',
    'loopbackOnly',
    'browserStorageCookieSessionBearerBasicOAuthDisabled',
    'reviewerGoRecorded',
    'operatorAcceptanceRecorded',
    'secretValue',
    'secretPath',
    'databaseUrl',
    'packetContents',
    'artifactContents',
    'DESCRIPTOR_FILE_REQUIRED',
    'DESCRIPTOR_JSON_MALFORMED',
    'DESCRIPTOR_OBJECT_REQUIRED',
    'DESCRIPTOR_FILE_IS_DIRECTORY',
    'DESCRIPTOR_FILE_TOO_LARGE',
    'GET /, GET /healthz, GET /manifest.json',
    'runtime auth remains blocked',
    'no auth/runtime/route/provider/UI/data expansion is added',
  ]) assert(combined.includes(kw), `Phase 80 docs/deploy include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
