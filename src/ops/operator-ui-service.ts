import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Client } from 'pg';
import { loadDbConfig, resolveAppEnv } from '../config/env.js';
import { loadCustodianConfig, createCustodian, requireAppHeldCompletionSecret } from '../core/crypto/custodian-factory.js';
import { getPool, closePool } from '../db/pool.js';
import {
  OPERATOR_UI_LOCAL_AUTH_HEADER,
  type OperatorUiLocalAuthRuntime,
  OperatorUiLocalAuthRuntimeError,
  loadOperatorUiLocalAuthRuntime,
  verifyOperatorUiLocalAuthHeader,
} from './operator-ui-local-auth-runtime.js';
import { runDoctor, type DoctorReport } from './doctor.js';

export const OPERATOR_UI_SERVICE_DEFAULT_HOST = '0.0.0.0';
export const OPERATOR_UI_SERVICE_DEFAULT_PORT = 8099;
export const OPERATOR_UI_SERVICE_MIN_PORT = 1024;
export const OPERATOR_UI_SERVICE_MAX_PORT = 65535;
export const OPERATOR_UI_SERVICE_REQUEST_TIMEOUT_MS = 15000;
export const OPERATOR_UI_SERVICE_HEADERS_TIMEOUT_MS = 8000;
export const OPERATOR_UI_SERVICE_KEEP_ALIVE_TIMEOUT_MS = 3000;
export const OPERATOR_UI_SERVICE_MAX_HEADERS_COUNT = 64;

export interface OperatorUiServiceConfigInput {
  readonly host?: string;
  readonly port?: number;
  readonly operatorSecretFile?: string;
}

export interface OperatorUiServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly operatorSecretFile: string;
}

export interface OperatorUiServiceLogEntry {
  readonly ts: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly class: 'system' | 'operation' | 'connector';
  readonly code: string;
  readonly message: string;
}

export interface OperatorUiServiceStatus {
  readonly ok: boolean;
  readonly service: 'catalog-authority-operator-ui';
  readonly report: 'phase-147-operator-ui-service';
  readonly uiRevision: 'phase-148-operator-ui-access';
  readonly mode: 'read-only-first';
  readonly productFraming: 'backend-orchestration-rail-not-streaming-product';
  readonly port: number;
  readonly auth: 'local-admin-token-file';
  readonly logs: 'redacted-system-operation-connector';
  readonly doctorSummary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly needsAttention: readonly string[];
  readonly forbidden: readonly [
    'provider-contact',
    'scraping',
    'downloading',
    'playback',
    'runtime-mutations',
    'secret-exposure',
  ];
  readonly doctor: DoctorReport | { readonly ok: false; readonly checks: readonly [{ readonly name: 'doctor'; readonly state: 'fail'; readonly detail: string }] };
}

export class OperatorUiServiceConfigError extends Error {
  readonly code = 'OPERATOR_UI_SERVICE_CONFIG_REJECTED';

  constructor(message = 'Operator UI service config is not bounded.') {
    super(message);
    this.name = 'OperatorUiServiceConfigError';
  }
}

export class OperatorUiServiceStartupError extends Error {
  readonly code = 'OPERATOR_UI_SERVICE_STARTUP_REJECTED';

  constructor(message = 'Operator UI service failed safely during startup.') {
    super(message);
    this.name = 'OperatorUiServiceStartupError';
  }
}

export interface StartedOperatorUiService {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const FORBIDDEN: OperatorUiServiceStatus['forbidden'] = [
  'provider-contact',
  'scraping',
  'downloading',
  'playback',
  'runtime-mutations',
  'secret-exposure',
];

export class OperatorUiServiceLogBuffer {
  private readonly entries: OperatorUiServiceLogEntry[] = [];

  constructor(private readonly maxEntries = 200) {}

  add(level: OperatorUiServiceLogEntry['level'], klass: OperatorUiServiceLogEntry['class'], code: string, message: string): void {
    const entry = { ts: new Date().toISOString(), level, class: klass, code, message: redactLogMessage(message) };
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) this.entries.shift();
    process.stdout.write(`${entry.ts} ${entry.level.toUpperCase()} ${entry.class} ${entry.code} ${entry.message}\n`);
  }

  list(): readonly OperatorUiServiceLogEntry[] {
    return [...this.entries];
  }
}

export function validateOperatorUiServiceConfig(input: OperatorUiServiceConfigInput = {}): OperatorUiServiceConfig {
  const host = input.host ?? OPERATOR_UI_SERVICE_DEFAULT_HOST;
  const port = input.port ?? OPERATOR_UI_SERVICE_DEFAULT_PORT;
  const operatorSecretFile = input.operatorSecretFile ?? process.env.OPERATOR_UI_TOKEN_FILE;

  if (!isAllowedHost(host)) throw new OperatorUiServiceConfigError();
  if (!Number.isInteger(port) || port < OPERATOR_UI_SERVICE_MIN_PORT || port > OPERATOR_UI_SERVICE_MAX_PORT) {
    throw new OperatorUiServiceConfigError();
  }
  if (operatorSecretFile === undefined || operatorSecretFile.trim() === '') throw new OperatorUiServiceConfigError();

  return { host, port, operatorSecretFile };
}

export function createOperatorUiServiceServer(
  config: OperatorUiServiceConfig,
  auth: OperatorUiLocalAuthRuntime,
  logs = new OperatorUiServiceLogBuffer(),
): Server {
  logs.add('info', 'system', 'SERVICE_CONFIGURED', `Operator UI service configured on port ${config.port}.`);

  const server = createServer(async (req, res) => {
    const method = req.method ?? '';
    const rawTarget = req.url ?? '/';
    const path = rawRequestPath(rawTarget);

    if (isUnsafeRawRequestPath(path)) {
      ignoreRequestBody(req);
      sendPlain(res, 404, 'not found\n', undefined, method === 'HEAD');
      logs.add('warn', 'system', 'REQUEST_REJECTED', 'Rejected unsafe request target.');
      return;
    }

    const known = path === '/' || path === '/healthz' || path === '/api/status' || path === '/api/logs';
    if (method === 'HEAD') {
      ignoreRequestBody(req);
      sendPlain(res, known ? 405 : 404, known ? 'method not allowed\n' : 'not found\n', known ? 'GET' : undefined, true);
      return;
    }
    if (method !== 'GET') {
      ignoreRequestBody(req);
      sendPlain(res, known ? 405 : 404, known ? 'method not allowed\n' : 'not found\n', known ? 'GET' : undefined);
      return;
    }

    if (path === '/') {
      ignoreRequestBody(req);
      sendHtml(res, buildOperatorUiServiceHtml());
      logs.add('info', 'system', 'UI_SERVED', 'Served operator UI shell.');
      return;
    }

    if (path === '/healthz') {
      ignoreRequestBody(req);
      sendJson(res, 200, {
        ok: true,
        code: 'OPERATOR_UI_SERVICE_HEALTHY',
        service: 'catalog-authority-operator-ui',
        mode: 'read-only-first',
      });
      return;
    }

    if (path === '/api/status') {
      if (!isAuthorized(req, auth)) {
        ignoreRequestBody(req);
        sendUnauthorized(res);
        logs.add('warn', 'operation', 'AUTH_REJECTED', 'Rejected status request without a valid operator token.');
        return;
      }
      const status = await buildOperatorUiServiceStatus(config, logs);
      sendJson(res, status.ok ? 200 : 503, status);
      logs.add(status.ok ? 'info' : 'warn', 'operation', 'STATUS_READ', `Served status report with ok=${status.ok}.`);
      return;
    }

    if (path === '/api/logs') {
      if (!isAuthorized(req, auth)) {
        ignoreRequestBody(req);
        sendUnauthorized(res);
        logs.add('warn', 'operation', 'AUTH_REJECTED', 'Rejected logs request without a valid operator token.');
        return;
      }
      sendJson(res, 200, { ok: true, report: 'phase-147-operator-ui-service-logs', entries: logs.list() });
      logs.add('info', 'operation', 'LOGS_READ', 'Served redacted service logs.');
      return;
    }

    ignoreRequestBody(req);
    sendPlain(res, 404, 'not found\n');
  });

  return hardenServer(server);
}

export async function buildOperatorUiServiceStatus(
  config: Pick<OperatorUiServiceConfig, 'port'>,
  logs?: OperatorUiServiceLogBuffer,
): Promise<OperatorUiServiceStatus> {
  let doctor: OperatorUiServiceStatus['doctor'];
  try {
    const db = loadDbConfig();
    const custodianConfig = loadCustodianConfig();
    const custodian = createCustodian(custodianConfig);
    const admin = new Client({ connectionString: db.adminDatabaseUrl });
    await admin.connect();
    try {
      doctor = await runDoctor({
        admin,
        pool: getPool(),
        custodian,
        completionSecret: custodianConfig.mode === 'sidecar'
          ? undefined
          : requireAppHeldCompletionSecret(custodianConfig, 'operator-ui-status'),
        custodianMode: custodianConfig.mode,
        appEnv: resolveAppEnv(),
        keystoreDir: custodianConfig.mode === 'file' ? custodianConfig.keystoreDir : undefined,
      });
    } finally {
      await admin.end();
      await closePool();
    }
  } catch {
    doctor = { ok: false, checks: [{ name: 'doctor', state: 'fail', detail: 'doctor check failed safely without exposing configuration values' }] };
    logs?.add('warn', 'operation', 'DOCTOR_FAILED', 'Doctor check failed safely.');
  }

  return {
    ok: doctor.ok,
    service: 'catalog-authority-operator-ui',
    report: 'phase-147-operator-ui-service',
    uiRevision: 'phase-148-operator-ui-access',
    mode: 'read-only-first',
    productFraming: 'backend-orchestration-rail-not-streaming-product',
    port: config.port,
    auth: 'local-admin-token-file',
    logs: 'redacted-system-operation-connector',
    doctorSummary: summarizeDoctor(doctor),
    needsAttention: doctor.checks
      .filter((check) => check.state !== 'pass')
      .map((check) => `${check.state.toUpperCase()} ${check.name}: ${check.detail}`),
    forbidden: FORBIDDEN,
    doctor,
  };
}

function summarizeDoctor(doctor: OperatorUiServiceStatus['doctor']): OperatorUiServiceStatus['doctorSummary'] {
  const pass = doctor.checks.filter((check) => check.state === 'pass').length;
  const warn = doctor.checks.filter((check) => check.state === 'warn').length;
  const fail = doctor.checks.filter((check) => check.state === 'fail').length;
  return { pass, warn, fail, total: doctor.checks.length };
}

export function startOperatorUiService(input: OperatorUiServiceConfigInput = {}): Promise<StartedOperatorUiService> {
  let config: OperatorUiServiceConfig;
  let auth: OperatorUiLocalAuthRuntime;
  try {
    config = validateOperatorUiServiceConfig(input);
    auth = loadOperatorUiLocalAuthRuntime(config.operatorSecretFile);
  } catch (err) {
    if (err instanceof OperatorUiLocalAuthRuntimeError || err instanceof OperatorUiServiceConfigError) {
      return Promise.reject(new OperatorUiServiceStartupError());
    }
    return Promise.reject(err);
  }

  const logs = new OperatorUiServiceLogBuffer();
  const server = createOperatorUiServiceServer(config, auth, logs);
  return new Promise((resolve, reject) => {
    const onError = (): void => {
      server.off('listening', onListening);
      reject(new OperatorUiServiceStartupError());
    };
    const onListening = (): void => {
      server.off('error', onError);
      logs.add('info', 'system', 'SERVICE_LISTENING', `Operator UI service listening on port ${config.port}.`);
      resolve({
        server,
        host: config.host,
        port: config.port,
        url: `http://${config.host}:${config.port}/`,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((err) => {
            if (err) closeReject(err);
            else {
              logs.add('info', 'system', 'SERVICE_STOPPED', 'Operator UI service stopped.');
              closeResolve();
            }
          });
        }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });
}

function isAllowedHost(host: string): boolean {
  return host === '0.0.0.0' || host === '127.0.0.1';
}

function rawRequestPath(rawTarget: string): string {
  const queryIndex = rawTarget.indexOf('?');
  return queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
}

function isUnsafeRawRequestPath(rawPath: string): boolean {
  const lower = rawPath.toLowerCase();
  return lower.startsWith('http://')
    || lower.startsWith('https://')
    || rawPath.startsWith('//')
    || rawPath.includes('..')
    || rawPath.includes('\\')
    || /%(?:2e|2f|5c)/i.test(rawPath);
}

function isAuthorized(req: IncomingMessage, auth: OperatorUiLocalAuthRuntime): boolean {
  return verifyOperatorUiLocalAuthHeader(auth, req.headers[OPERATOR_UI_LOCAL_AUTH_HEADER]);
}

function setSafeHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
}

function sendHtml(res: ServerResponse, body: string): void {
  setSafeHeaders(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(body);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  setSafeHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(body)}\n`);
}

function sendPlain(res: ServerResponse, statusCode: number, body: string, allow?: string, emptyBody = false): void {
  setSafeHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (allow) res.setHeader('Allow', allow);
  res.end(emptyBody ? '' : body);
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    ok: false,
    code: 'OPERATOR_UI_SERVICE_UNAUTHORIZED',
    message: 'Operator token is required.',
  });
}

function ignoreRequestBody(req: IncomingMessage): void {
  req.resume();
}

function hardenServer(server: Server): Server {
  server.requestTimeout = OPERATOR_UI_SERVICE_REQUEST_TIMEOUT_MS;
  server.headersTimeout = OPERATOR_UI_SERVICE_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = OPERATOR_UI_SERVICE_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = OPERATOR_UI_SERVICE_MAX_HEADERS_COUNT;
  return server;
}

function redactLogMessage(message: string): string {
  return message
    .replace(/postgresql:\/\/\S+/gi, '[redacted-database-url]')
    .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, '[redacted-token]');
}

function buildOperatorUiServiceHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Catalog Authority</title>
<style>
:root{color-scheme:light;background:#f7f8fa;color:#1d2430;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0}.shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr;background:linear-gradient(180deg,#ffffff 0,#f4f6f8 100%)}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid #d9dee7;background:#fff}
h1{margin:0;font-size:20px;font-weight:700;letter-spacing:0}.badge{font-size:12px;border:1px solid #b9c2cf;border-radius:999px;padding:5px 10px;background:#f8fafc;color:#354154}
main{display:grid;grid-template-columns:minmax(260px,360px) 1fr;gap:18px;padding:18px;max-width:1180px;width:100%;margin:0 auto}.panel{background:#fff;border:1px solid #d9dee7;border-radius:8px;padding:16px;min-width:0}
h2{font-size:15px;margin:0 0 12px}.field{display:grid;gap:7px;margin-bottom:12px}label{font-size:12px;color:#536173}input{width:100%;border:1px solid #b9c2cf;border-radius:6px;padding:10px 11px;font:inherit}
button{border:0;border-radius:6px;background:#1769aa;color:#fff;font-weight:700;padding:10px 12px;cursor:pointer}button:disabled{background:#aab4c0;cursor:not-allowed}.actions{display:flex;gap:8px;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.metric{border:1px solid #e0e5ec;border-radius:8px;padding:12px;background:#fbfcfd}.metric span{display:block;color:#637083;font-size:12px}.metric strong{display:block;margin-top:6px;font-size:18px;overflow-wrap:anywhere}
.metric.ok strong{color:#177245}.metric.warn strong{color:#9b6400}.metric.fail strong{color:#b42318}
pre{margin:0;white-space:pre-wrap;word-break:break-word;background:#101820;color:#eef4f8;border-radius:8px;padding:12px;max-height:380px;overflow:auto;font-size:12px;line-height:1.45}.status{font-size:13px;color:#536173;margin-top:12px;min-height:20px}
.wide{grid-column:1/-1}.list{display:grid;gap:8px;margin:0;padding:0;list-style:none}.list li{border:1px solid #e0e5ec;border-radius:8px;padding:10px 12px;background:#fbfcfd;font-size:13px;overflow-wrap:anywhere}.muted{color:#637083}
@media(max-width:760px){main{grid-template-columns:1fr;padding:12px}header{padding:14px 12px}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
<header><h1>Catalog Authority</h1><div class="badge">read-only operator UI</div></header>
<main>
<section class="panel">
<h2>Access</h2>
<div class="field"><label for="token">Operator token</label><input id="token" type="password" autocomplete="off"></div>
<div class="actions"><button id="refresh">Refresh</button><button id="clear" type="button">Clear</button></div>
<div class="status" id="statusText"></div>
</section>
<section class="panel">
<h2>Status</h2>
<div class="grid">
<div class="metric"><span>Service</span><strong id="service">-</strong></div>
<div class="metric"><span>Mode</span><strong id="mode">-</strong></div>
<div class="metric"><span>Doctor</span><strong id="doctor">-</strong></div>
<div class="metric"><span>Port</span><strong id="port">-</strong></div>
<div class="metric ok"><span>Pass</span><strong id="passCount">-</strong></div>
<div class="metric warn"><span>Warn</span><strong id="warnCount">-</strong></div>
<div class="metric fail"><span>Fail</span><strong id="failCount">-</strong></div>
<div class="metric"><span>Log entries</span><strong id="logCount">-</strong></div>
</div>
</section>
<section class="panel wide">
<h2>Needs Attention</h2>
<ul class="list" id="attention"><li class="muted">No status loaded.</li></ul>
</section>
<section class="panel">
<h2>Checks</h2>
<pre id="checks">No status loaded.</pre>
</section>
<section class="panel">
<h2>Logs</h2>
<pre id="logs">No logs loaded.</pre>
</section>
</main>
</div>
<script>
const token = document.getElementById('token');
const statusText = document.getElementById('statusText');
const service = document.getElementById('service');
const mode = document.getElementById('mode');
const doctor = document.getElementById('doctor');
const port = document.getElementById('port');
const passCount = document.getElementById('passCount');
const warnCount = document.getElementById('warnCount');
const failCount = document.getElementById('failCount');
const logCount = document.getElementById('logCount');
const attention = document.getElementById('attention');
const checks = document.getElementById('checks');
const logs = document.getElementById('logs');
async function getJson(path){
  const value = token.value;
  const res = await fetch(path,{headers:{'${OPERATOR_UI_LOCAL_AUTH_HEADER}':value}});
  const body = await res.json();
  if(!res.ok) throw new Error(body.message || body.code || 'request failed');
  return body;
}
function renderStatus(data){
  service.textContent = data.service || '-';
  mode.textContent = data.mode || '-';
  doctor.textContent = data.doctor && data.doctor.ok ? 'OK' : 'Needs attention';
  port.textContent = String(data.port || '-');
  passCount.textContent = String((data.doctorSummary && data.doctorSummary.pass) || 0);
  warnCount.textContent = String((data.doctorSummary && data.doctorSummary.warn) || 0);
  failCount.textContent = String((data.doctorSummary && data.doctorSummary.fail) || 0);
  const items = data.needsAttention || [];
  attention.innerHTML = '';
  if(items.length === 0){
    const li = document.createElement('li'); li.className='muted'; li.textContent='No warnings or failures.'; attention.appendChild(li);
  }else{
    for(const item of items){ const li = document.createElement('li'); li.textContent = item; attention.appendChild(li); }
  }
  checks.textContent = (data.doctor.checks || []).map(c => c.state.toUpperCase() + '  ' + c.name + ': ' + c.detail).join('\\n');
}
function renderLogs(data){
  const entries = data.entries || [];
  logCount.textContent = String(entries.length);
  logs.textContent = entries.map(e => e.ts + ' ' + e.level.toUpperCase() + ' ' + e.class + ' ' + e.code + ' ' + e.message).join('\\n') || 'No log entries.';
}
async function refresh(){
  statusText.textContent = 'Loading...';
  try{
    const [s,l] = await Promise.all([getJson('/api/status'), getJson('/api/logs')]);
    renderStatus(s); renderLogs(l); statusText.textContent = 'Updated.';
  }catch(err){ statusText.textContent = err.message; }
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('clear').addEventListener('click', () => { token.value=''; statusText.textContent=''; });
</script>
</body>
</html>`;
}
