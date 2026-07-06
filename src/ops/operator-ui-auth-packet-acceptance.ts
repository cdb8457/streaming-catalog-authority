import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPERATOR_UI_LOCAL_AUTH_HEADER_DISPLAY,
} from './operator-ui-local-auth-runtime.js';
import {
  OPERATOR_UI_STATIC_RUNTIME_CSP,
  OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
  buildOperatorUiStaticRuntimeManifest,
  startOperatorUiStaticRuntime,
} from './operator-ui-static-runtime.js';

export type OperatorUiAuthPacketAcceptanceReportName = 'operator-ui-auth-packet-acceptance';
export type OperatorUiAuthPacketAcceptanceReportVersion = 'phase-82.v1';
export type OperatorUiAuthPacketAcceptanceCode = 'OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_REPORTED';
export type OperatorUiAuthPacketAcceptanceStatus = 'accepted' | 'blocked';
export type OperatorUiAuthPacketAcceptanceCheckStatus = 'accepted' | 'blocked';

export interface OperatorUiAuthPacketAcceptanceCheck {
  readonly id:
    | 'static-packet-endpoint-disabled'
    | 'manifest-auth-packet-source-sanitized'
    | 'missing-header-fixed-401'
    | 'wrong-header-fixed-401'
    | 'multiple-header-fixed-401'
    | 'correct-header-fixture-counts-only'
    | 'query-secret-fixed-404-before-auth'
    | 'query-bearing-target-fixed-404-before-auth'
    | 'head-fixed-405-empty-body'
    | 'non-get-fixed-405'
    | 'raw-target-bypass-fixed-404'
    | 'root-html-csp-hash-pinned-same-origin-connect'
    | 'auth-scheme-and-storage-patterns-absent';
  readonly status: OperatorUiAuthPacketAcceptanceCheckStatus;
  readonly statusCode?: number;
  readonly details: string;
}

export interface OperatorUiAuthPacketAcceptanceReport {
  readonly ok: true;
  readonly reportName: OperatorUiAuthPacketAcceptanceReportName;
  readonly reportVersion: OperatorUiAuthPacketAcceptanceReportVersion;
  readonly code: OperatorUiAuthPacketAcceptanceCode;
  readonly status: OperatorUiAuthPacketAcceptanceStatus;
  readonly runtimeMode: 'local-loopback-fixture-only';
  readonly auth: 'local-secret-file-enabled';
  readonly packetEndpoint: '/operator-ui/packets.json';
  readonly packetSource: 'synthetic-fixture-only';
  readonly packetCount: number;
  readonly screenCount: number;
  readonly checks: readonly OperatorUiAuthPacketAcceptanceCheck[];
  readonly forbiddenEvidence: readonly string[];
  readonly boundaries: readonly string[];
}

interface HttpResult {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface ProbeContext {
  readonly tempDir: string;
  readonly secretFile: string;
  readonly secret: string;
  readonly wrongSecret: string;
  readonly querySentinel: string;
}

const PACKET_ENDPOINT = '/operator-ui/packets.json';
const REPORT_NAME: OperatorUiAuthPacketAcceptanceReportName = 'operator-ui-auth-packet-acceptance';
const REPORT_VERSION: OperatorUiAuthPacketAcceptanceReportVersion = 'phase-82.v1';
const REPORT_CODE: OperatorUiAuthPacketAcceptanceCode = 'OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_REPORTED';
const BLOCKED_PACKET_COUNT = 0;
const BLOCKED_SCREEN_COUNT = 0;

export const OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_FORBIDDEN_EVIDENCE = [
  'secret values',
  'secret file paths',
  'auth headers',
  'request bodies',
  'query strings',
  'database URLs',
  'credentials',
  'real titles',
  'external IDs',
  'provider names or logos',
  'raw refs',
  'hashes',
  'magnet links',
  'user library data',
  'artwork',
  'artifact contents',
  'packet contents',
  'raw packet contents',
  'HTML contents',
] as const;

export const OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_BOUNDARIES = [
  'local loopback fixture runtime only',
  'no DB reads',
  'no provider or debrid integrations',
  'no live source, scraping, download, playback, or media-server behavior',
  'no frontend framework or API framework',
  'no browser-side persistence or standardized web auth flows',
  'no user-provided secret values or user-provided secret paths',
  'temporary generated local secret file is removed after probing',
  'packet evidence is counts only from synthetic fixtures',
  'O4 and O5 remain open/deferred',
  'FileCustodian remains a hardened reference harness only, not production KMS',
] as const;

function accepted(
  id: OperatorUiAuthPacketAcceptanceCheck['id'],
  statusCode: number | undefined,
  details: string,
): OperatorUiAuthPacketAcceptanceCheck {
  return statusCode === undefined
    ? { id, status: 'accepted', details }
    : { id, status: 'accepted', statusCode, details };
}

function blocked(
  id: OperatorUiAuthPacketAcceptanceCheck['id'],
  details: string,
): OperatorUiAuthPacketAcceptanceCheck {
  return { id, status: 'blocked', details };
}

function probeSecret(): string {
  return `phase82-${randomBytes(24).toString('base64url')}-local`;
}

function createProbeContext(): ProbeContext {
  const tempDir = mkdtempSync(join(tmpdir(), 'phase-82-auth-acceptance-'));
  const secretFile = join(tempDir, 'operator-ui-secret.txt');
  const secret = probeSecret();
  const wrongSecret = probeSecret();
  const querySentinel = `phase82-query-${randomBytes(12).toString('base64url')}`;
  writeFileSync(secretFile, `${secret}\n`, 'utf8');
  return { tempDir, secretFile, secret, wrongSecret, querySentinel };
}

function headersText(headers: Record<string, string | string[] | undefined>): string {
  return JSON.stringify(headers);
}

function hasLeak(value: string, sentinels: readonly string[]): boolean {
  return sentinels.some((sentinel) => sentinel.length > 0 && value.includes(sentinel));
}

function hasPacketData(response: HttpResult): boolean {
  return response.body.includes('OPERATOR_UI_SANITIZED_PACKET_SNAPSHOT')
    || response.body.includes('"packets"')
    || response.body.includes('"screenId"')
    || response.body.includes('"descriptor"')
    || response.body.includes('"rows"');
}

function hasAuthChallenge(response: HttpResult): boolean {
  return response.headers['www-authenticate'] !== undefined;
}

function hasExpectedFixed401(response: HttpResult, sentinels: readonly string[]): boolean {
  const transcript = `${headersText(response.headers)}\n${response.body}`;
  return response.statusCode === 401
    && !hasAuthChallenge(response)
    && !hasPacketData(response)
    && !hasLeak(transcript, sentinels);
}

function hasExpectedFixed404(response: HttpResult, sentinels: readonly string[]): boolean {
  const transcript = `${headersText(response.headers)}\n${response.body}`;
  return response.statusCode === 404
    && response.body === 'not found\n'
    && !hasAuthChallenge(response)
    && !hasPacketData(response)
    && !hasLeak(transcript, sentinels);
}

function hasExpectedFixed405(response: HttpResult, emptyBody: boolean, sentinels: readonly string[]): boolean {
  const transcript = `${headersText(response.headers)}\n${response.body}`;
  return response.statusCode === 405
    && response.headers.allow === 'GET'
    && response.body === (emptyBody ? '' : 'method not allowed\n')
    && !hasAuthChallenge(response)
    && !hasPacketData(response)
    && !hasLeak(transcript, sentinels);
}

function httpRequest(
  port: number,
  path: string,
  method = 'GET',
  secret?: string,
  body = '',
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (secret !== undefined) headers[OPERATOR_UI_LOCAL_AUTH_HEADER_DISPLAY] = secret;
    if (body.length > 0) headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
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

function rawHttpRequest(
  port: number,
  target: string,
  method = 'GET',
  headerLines: readonly string[] = [],
  body = '',
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST);
    let raw = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000);
    socket.on('connect', () => {
      socket.write(`${method} ${target} HTTP/1.1\r\n`);
      socket.write(`Host: ${OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST}:${port}\r\n`);
      for (const line of headerLines) socket.write(`${line}\r\n`);
      if (body.length > 0) socket.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n`);
      socket.write('Connection: close\r\n\r\n');
      if (body.length > 0) socket.write(body);
    });
    socket.on('data', (chunk: string) => { raw += chunk; });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('raw request timed out'));
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

function packetCountsFromSnapshot(body: string): { readonly packetCount: number; readonly screenCount: number } | undefined {
  const parsed = JSON.parse(body) as {
    readonly code?: unknown;
    readonly dataMode?: unknown;
    readonly packetCount?: unknown;
    readonly screens?: unknown;
  };
  if (parsed.code !== 'OPERATOR_UI_SANITIZED_PACKET_SNAPSHOT') return undefined;
  if (parsed.dataMode !== 'synthetic-fixture-only') return undefined;
  if (typeof parsed.packetCount !== 'number') return undefined;
  if (!Array.isArray(parsed.screens)) return undefined;
  return { packetCount: parsed.packetCount, screenCount: parsed.screens.length };
}

function staticPatternCheck(): OperatorUiAuthPacketAcceptanceCheck {
  const manifest = buildOperatorUiStaticRuntimeManifest({ operatorAuthEnabled: true });
  const serialized = JSON.stringify(manifest);
  for (const forbidden of [
    ['local', 'Storage'].join(''),
    ['session', 'Storage'].join(''),
    ['Set', 'Cookie'].join('-'),
    ['Author', 'ization'].join(''),
    ['Bear', 'er'].join(''),
    ['Bas', 'ic'].join(''),
    ['O', 'Auth'].join(''),
    ['?', 'secret', '='].join(''),
    ['password', '='].join(''),
  ]) {
    if (serialized.includes(forbidden)) {
      return blocked('auth-scheme-and-storage-patterns-absent', 'forbidden auth or storage pattern observed');
    }
  }
  return accepted('auth-scheme-and-storage-patterns-absent', undefined, 'no forbidden browser storage or auth scheme pattern observed');
}

export function evaluateOperatorUiAuthPacketAcceptanceStatus(
  checks: readonly OperatorUiAuthPacketAcceptanceCheck[],
): OperatorUiAuthPacketAcceptanceStatus {
  return checks.every((check) => check.status === 'accepted') ? 'accepted' : 'blocked';
}

export async function buildOperatorUiAuthPacketAcceptanceReport(): Promise<OperatorUiAuthPacketAcceptanceReport> {
  const checks: OperatorUiAuthPacketAcceptanceCheck[] = [];
  let packetCount = BLOCKED_PACKET_COUNT;
  let screenCount = BLOCKED_SCREEN_COUNT;
  let context: ProbeContext | undefined;

  try {
    context = createProbeContext();
    const sentinels = [context.secret, context.wrongSecret, context.secretFile, context.tempDir, context.querySentinel];

    const staticRuntime = await startOperatorUiStaticRuntime({ host: OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST, port: 0 });
    try {
      const disabled = await httpRequest(staticRuntime.port, PACKET_ENDPOINT);
      checks.push(hasExpectedFixed404(disabled, sentinels)
        ? accepted('static-packet-endpoint-disabled', disabled.statusCode, 'static-only packet endpoint returns fixed 404')
        : blocked('static-packet-endpoint-disabled', 'static-only packet endpoint did not return fixed 404'));
    } finally {
      await staticRuntime.close();
    }

    const runtime = await startOperatorUiStaticRuntime({
      host: OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST,
      port: 0,
      operatorSecretFile: context.secretFile,
    });
    try {
      const manifestResponse = await httpRequest(runtime.port, '/manifest.json');
      const manifest = JSON.parse(manifestResponse.body) as {
        readonly operatorAuth?: unknown;
        readonly packetSource?: unknown;
      };
      checks.push(
        manifestResponse.statusCode === 200
          && manifest.operatorAuth === 'local-secret-file-enabled'
          && manifest.packetSource === 'sanitized-local-packet-endpoint'
          && !hasLeak(manifestResponse.body, sentinels)
          ? accepted('manifest-auth-packet-source-sanitized', manifestResponse.statusCode, 'manifest reports local auth and sanitized packet source without secret path')
          : blocked('manifest-auth-packet-source-sanitized', 'manifest did not report sanitized local auth packet source safely'),
      );

      const missing = await httpRequest(runtime.port, PACKET_ENDPOINT);
      checks.push(hasExpectedFixed401(missing, sentinels)
        ? accepted('missing-header-fixed-401', missing.statusCode, 'missing header returns fixed 401 without challenge or packet data')
        : blocked('missing-header-fixed-401', 'missing header was not rejected safely'));

      const wrong = await httpRequest(runtime.port, PACKET_ENDPOINT, 'GET', context.wrongSecret);
      checks.push(hasExpectedFixed401(wrong, sentinels)
        ? accepted('wrong-header-fixed-401', wrong.statusCode, 'wrong header returns fixed 401 without challenge or packet data')
        : blocked('wrong-header-fixed-401', 'wrong header was not rejected safely'));

      const multiple = await rawHttpRequest(runtime.port, PACKET_ENDPOINT, 'GET', [
        `${OPERATOR_UI_LOCAL_AUTH_HEADER_DISPLAY}: ${context.secret}`,
        `${OPERATOR_UI_LOCAL_AUTH_HEADER_DISPLAY}: ${context.wrongSecret}`,
      ]);
      checks.push(hasExpectedFixed401(multiple, sentinels)
        ? accepted('multiple-header-fixed-401', multiple.statusCode, 'multiple headers return fixed 401 without challenge or packet data')
        : blocked('multiple-header-fixed-401', 'multiple headers were not rejected safely'));

      const authorized = await httpRequest(runtime.port, PACKET_ENDPOINT, 'GET', context.secret);
      const counts = authorized.statusCode === 200 ? packetCountsFromSnapshot(authorized.body) : undefined;
      if (counts === undefined || hasLeak(authorized.body, sentinels)) {
        checks.push(blocked('correct-header-fixture-counts-only', 'authorized probe did not return safe synthetic fixture counts'));
      } else {
        packetCount = counts.packetCount;
        screenCount = counts.screenCount;
        checks.push(accepted('correct-header-fixture-counts-only', authorized.statusCode, 'correct header returns synthetic fixture snapshot; evidence records counts only'));
      }

      const secretQuery = await httpRequest(runtime.port, `${PACKET_ENDPOINT}?secret=${context.querySentinel}`, 'GET', context.secret);
      checks.push(hasExpectedFixed404(secretQuery, sentinels)
        ? accepted('query-secret-fixed-404-before-auth', secretQuery.statusCode, 'query secret target returns fixed 404 before auth')
        : blocked('query-secret-fixed-404-before-auth', 'query secret target was not rejected safely'));

      const otherQuery = await httpRequest(runtime.port, `${PACKET_ENDPOINT}?probe=${context.querySentinel}`, 'GET', context.secret);
      checks.push(hasExpectedFixed404(otherQuery, sentinels)
        ? accepted('query-bearing-target-fixed-404-before-auth', otherQuery.statusCode, 'query-bearing packet target returns fixed 404 before auth')
        : blocked('query-bearing-target-fixed-404-before-auth', 'query-bearing packet target was not rejected safely'));

      const head = await httpRequest(runtime.port, PACKET_ENDPOINT, 'HEAD', context.secret);
      checks.push(hasExpectedFixed405(head, true, sentinels)
        ? accepted('head-fixed-405-empty-body', head.statusCode, 'HEAD returns fixed 405 with Allow GET and empty body')
        : blocked('head-fixed-405-empty-body', 'HEAD behavior was not fixed and redaction-safe'));

      const post = await httpRequest(runtime.port, PACKET_ENDPOINT, 'POST', context.secret, `body=${context.querySentinel}`);
      checks.push(hasExpectedFixed405(post, false, sentinels)
        ? accepted('non-get-fixed-405', post.statusCode, 'non-GET returns fixed 405 with Allow GET and no body echo')
        : blocked('non-get-fixed-405', 'non-GET behavior was not fixed and redaction-safe'));

      const rawBypass = await rawHttpRequest(runtime.port, `${PACKET_ENDPOINT}%2f..`, 'GET', [
        `${OPERATOR_UI_LOCAL_AUTH_HEADER_DISPLAY}: ${context.secret}`,
      ]);
      checks.push(hasExpectedFixed404(rawBypass, sentinels)
        ? accepted('raw-target-bypass-fixed-404', rawBypass.statusCode, 'raw target bypass attempt returns fixed 404')
        : blocked('raw-target-bypass-fixed-404', 'raw target bypass attempt was not rejected safely'));

      const root = await httpRequest(runtime.port, '/');
      const csp = String(root.headers['content-security-policy'] ?? '');
      checks.push(
        root.statusCode === 200
          && csp === OPERATOR_UI_STATIC_RUNTIME_CSP
          && csp.includes("script-src 'sha256-")
          && csp.includes("connect-src 'self'")
          && !hasLeak(headersText(root.headers), sentinels)
          ? accepted('root-html-csp-hash-pinned-same-origin-connect', root.statusCode, 'root CSP remains hash-pinned for inline script and same-origin connect only')
          : blocked('root-html-csp-hash-pinned-same-origin-connect', 'root CSP did not preserve expected script/connect boundary'),
      );
    } finally {
      await runtime.close();
    }

    checks.push(staticPatternCheck());
  } catch {
    checks.push(blocked('static-packet-endpoint-disabled', 'acceptance probe failed safely before all checks completed'));
  } finally {
    if (context !== undefined) rmSync(context.tempDir, { recursive: true, force: true });
  }

  return {
    ok: true,
    reportName: REPORT_NAME,
    reportVersion: REPORT_VERSION,
    code: REPORT_CODE,
    status: evaluateOperatorUiAuthPacketAcceptanceStatus(checks),
    runtimeMode: 'local-loopback-fixture-only',
    auth: 'local-secret-file-enabled',
    packetEndpoint: PACKET_ENDPOINT,
    packetSource: 'synthetic-fixture-only',
    packetCount,
    screenCount,
    checks,
    forbiddenEvidence: [...OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_FORBIDDEN_EVIDENCE],
    boundaries: [...OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_BOUNDARIES],
  };
}

export function formatOperatorUiAuthPacketAcceptanceText(
  report: OperatorUiAuthPacketAcceptanceReport,
): string {
  const lines = [
    'Operator UI Auth Packet Acceptance',
    `code: ${report.code}`,
    `report: ${report.reportName}`,
    `version: ${report.reportVersion}`,
    `status: ${report.status}`,
    `runtimeMode: ${report.runtimeMode}`,
    `auth: ${report.auth}`,
    `packetEndpoint: ${report.packetEndpoint}`,
    `packetSource: ${report.packetSource}`,
    `packetCount: ${report.packetCount}`,
    `screenCount: ${report.screenCount}`,
    '',
    'Checks:',
  ];

  for (const check of report.checks) {
    const statusCode = check.statusCode === undefined ? '' : ` statusCode=${check.statusCode}`;
    lines.push(`- ${check.id}: ${check.status}${statusCode}`);
    lines.push(`  details: ${check.details}`);
  }

  lines.push('', 'Forbidden evidence:');
  for (const field of report.forbiddenEvidence) lines.push(`- ${field}`);

  lines.push('', 'Boundaries:');
  for (const boundary of report.boundaries) lines.push(`- ${boundary}`);

  return `${lines.join('\n')}\n`;
}
