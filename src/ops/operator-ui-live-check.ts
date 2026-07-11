import { request } from 'node:http';
import { URL } from 'node:url';
import { readTokenValue } from './operator-ui-token.js';

export const OPERATOR_UI_LIVE_CHECK_REPORT = 'phase-150-operator-ui-live-check';
export const OPERATOR_UI_LIVE_CHECK_DEFAULT_BASE_URL = 'http://127.0.0.1:8099';
export const OPERATOR_UI_LIVE_CHECK_DEFAULT_TIMEOUT_MS = 5000;

export interface OperatorUiLiveCheckInput {
  readonly baseUrl?: string;
  readonly tokenFile: string;
  readonly timeoutMs?: number;
}

export interface OperatorUiLiveCheckReport {
  readonly report: typeof OPERATOR_UI_LIVE_CHECK_REPORT;
  readonly baseUrl: string;
  readonly ok: boolean;
  readonly checks: readonly OperatorUiLiveCheckResult[];
  readonly statusSummary?: {
    readonly ok: boolean;
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
    readonly needsAttentionCount: number;
  };
  readonly logSummary?: {
    readonly entries: number;
  };
  readonly forbidden: readonly [
    'token-output',
    'secret-output',
    'provider-contact',
    'scraping',
    'downloading',
    'playback',
    'runtime-mutations',
  ];
}

export interface OperatorUiLiveCheckResult {
  readonly name: 'healthz' | 'unauth-status' | 'auth-status' | 'auth-logs';
  readonly state: 'pass' | 'fail';
  readonly statusCode: number;
  readonly detail: string;
}

interface HttpResult {
  readonly statusCode: number;
  readonly body: string;
}

const FORBIDDEN: OperatorUiLiveCheckReport['forbidden'] = [
  'token-output',
  'secret-output',
  'provider-contact',
  'scraping',
  'downloading',
  'playback',
  'runtime-mutations',
];

export async function runOperatorUiLiveCheck(input: OperatorUiLiveCheckInput): Promise<OperatorUiLiveCheckReport> {
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? OPERATOR_UI_LIVE_CHECK_DEFAULT_BASE_URL);
  const timeoutMs = input.timeoutMs ?? OPERATOR_UI_LIVE_CHECK_DEFAULT_TIMEOUT_MS;
  const token = readTokenValue(input.tokenFile);
  const checks: OperatorUiLiveCheckResult[] = [];

  const health = await getJson(baseUrl, '/healthz', undefined, timeoutMs);
  checks.push({
    name: 'healthz',
    state: health.statusCode === 200 ? 'pass' : 'fail',
    statusCode: health.statusCode,
    detail: health.statusCode === 200 ? 'health endpoint returned ok' : 'health endpoint was not ok',
  });

  const unauthStatus = await getJson(baseUrl, '/api/status', undefined, timeoutMs);
  checks.push({
    name: 'unauth-status',
    state: unauthStatus.statusCode === 401 ? 'pass' : 'fail',
    statusCode: unauthStatus.statusCode,
    detail: unauthStatus.statusCode === 401 ? 'status endpoint rejected missing token' : 'status endpoint did not reject missing token',
  });

  const authStatus = await getJson(baseUrl, '/api/status', token, timeoutMs);
  const parsedStatus = parseObject(authStatus.body);
  const doctorSummary = parseDoctorSummary(parsedStatus);
  const needsAttentionCount = Array.isArray(parsedStatus?.needsAttention) ? parsedStatus.needsAttention.length : 0;
  checks.push({
    name: 'auth-status',
    state: authStatus.statusCode === 200 && parsedStatus?.ok === true ? 'pass' : 'fail',
    statusCode: authStatus.statusCode,
    detail: authStatus.statusCode === 200 && parsedStatus?.ok === true ? 'authenticated status returned ok' : 'authenticated status was not ok',
  });

  const authLogs = await getJson(baseUrl, '/api/logs', token, timeoutMs);
  const parsedLogs = parseObject(authLogs.body);
  const logEntries = Array.isArray(parsedLogs?.entries) ? parsedLogs.entries.length : 0;
  checks.push({
    name: 'auth-logs',
    state: authLogs.statusCode === 200 && Array.isArray(parsedLogs?.entries) ? 'pass' : 'fail',
    statusCode: authLogs.statusCode,
    detail: authLogs.statusCode === 200 && Array.isArray(parsedLogs?.entries) ? 'authenticated logs returned redacted entries' : 'authenticated logs were not readable',
  });

  const report: OperatorUiLiveCheckReport = {
    report: OPERATOR_UI_LIVE_CHECK_REPORT,
    baseUrl,
    ok: checks.every((check) => check.state === 'pass'),
    checks,
    forbidden: FORBIDDEN,
  };

  if (doctorSummary !== undefined) {
    return {
      ...report,
      statusSummary: {
        ok: parsedStatus?.ok === true,
        ...doctorSummary,
        needsAttentionCount,
      },
      logSummary: { entries: logEntries },
    };
  }
  return { ...report, logSummary: { entries: logEntries } };
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:') throw new Error('Only http:// operator UI URLs are allowed.');
  if (url.username !== '' || url.password !== '') throw new Error('Credentials in operator UI URL are not allowed.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function getJson(baseUrl: string, path: string, token: string | undefined, timeoutMs: number): Promise<HttpResult> {
  const url = new URL(path, `${baseUrl}/`);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers['x-operator-ui-secret'] = token;
    const req = request(url, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('operator UI request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

function parseObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

function parseDoctorSummary(parsed: Record<string, unknown> | undefined): { pass: number; warn: number; fail: number; total: number } | undefined {
  const summary = parsed?.doctorSummary;
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return undefined;
  const candidate = summary as Record<string, unknown>;
  const pass = candidate.pass;
  const warn = candidate.warn;
  const fail = candidate.fail;
  const total = candidate.total;
  if ([pass, warn, fail, total].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return { pass: pass as number, warn: warn as number, fail: fail as number, total: total as number };
  }
  return undefined;
}
