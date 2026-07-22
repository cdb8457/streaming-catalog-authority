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
import {
  buildPromotionChainSnapshot,
  PromotionRecordsConfigError,
  resolvePromotionRecordsDir,
} from './operator-ui-promotion-chain.js';
import {
  firstRunChecklist,
  REPOSITORY_COMPOSE_NOTE,
  TOKEN_HANDLING_NOTE,
  troubleshootingTable,
  type ChecklistStep,
  type TroubleshootingEntry,
} from './operator-ui-first-run-checklist.js';
import {
  collectStaticFacts,
  deriveInstallationReadiness,
  summarizeChainSnapshot,
  type InstallationReadiness,
} from './operator-ui-installation-readiness.js';
import { probeDatabase } from './operator-ui-database-probe.js';
import { buildRuntimeVersionView } from './operator-ui-runtime-version.js';

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
  readonly promotionRecordsDir?: string;
}

export interface OperatorUiServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly operatorSecretFile: string;
  // The container path the promotion record artifacts are mounted at, READ-ONLY. Resolved from configuration
  // at startup and never from a request, so nothing a browser sends can steer a filesystem read.
  readonly promotionRecordsDir: string;
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

  // A misconfigured artifact directory refuses STARTUP rather than surfacing later as an empty panel. The
  // narrow validation lives with the promotion-chain module; a rejection there is a config rejection here.
  let promotionRecordsDir: string;
  try {
    promotionRecordsDir = input.promotionRecordsDir === undefined
      ? resolvePromotionRecordsDir()
      : resolvePromotionRecordsDir({ PROMOTION_RECORDS_DIR: input.promotionRecordsDir });
  } catch (err) {
    if (err instanceof PromotionRecordsConfigError) throw new OperatorUiServiceConfigError();
    throw err;
  }

  return { host, port, operatorSecretFile, promotionRecordsDir };
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

    const known = path === '/' || path === '/healthz' || path === '/api/status' || path === '/api/logs'
      || path === '/api/promotion-chain' || path === '/api/installation' || path === '/api/version';
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

    // The promotion record chain, behind the SAME token boundary as every other operational route. It is a
    // read: the artifact directory comes from container configuration, the request contributes nothing to it,
    // and no method other than GET reaches this point.
    if (path === '/api/promotion-chain') {
      if (!isAuthorized(req, auth)) {
        ignoreRequestBody(req);
        sendUnauthorized(res);
        logs.add('warn', 'operation', 'AUTH_REJECTED', 'Rejected promotion chain request without a valid operator token.');
        return;
      }
      let snapshot: ReturnType<typeof buildPromotionChainSnapshot>;
      try {
        snapshot = buildPromotionChainSnapshot(config.promotionRecordsDir);
      } catch {
        // Fail closed and say nothing about the filesystem. A read that surprises us is still not a verdict.
        sendJson(res, 503, {
          ok: false,
          code: 'PROMOTION_CHAIN_UNAVAILABLE',
          report: 'phase-244-operator-ui-promotion-chain',
          message: 'The promotion record chain could not be read safely.',
        });
        logs.add('warn', 'operation', 'PROMOTION_CHAIN_FAILED', 'Promotion chain read failed safely.');
        return;
      }
      sendJson(res, snapshot.ok ? 200 : 503, snapshot);
      // The log line carries the verdict and nothing else -- no path, no count that could identify a chain.
      logs.add(snapshot.ok ? 'info' : 'warn', 'operation', 'PROMOTION_CHAIN_READ',
        `Served promotion chain snapshot with availability=${snapshot.availability}.`);
      return;
    }

    // Phase 246. The question this answers -- "is this install usable, and what do I do next?" -- is asked by
    // someone who has just extracted a bundle, so it is the one route that must work when everything else is
    // half-configured. It therefore reports states rather than failing: a missing secret file, a database
    // that is not up and an empty records folder are all ANSWERS here, not errors.
    if (path === '/api/installation') {
      if (!isAuthorized(req, auth)) {
        ignoreRequestBody(req);
        sendUnauthorized(res);
        logs.add('warn', 'operation', 'AUTH_REJECTED', 'Rejected installation readiness request without a valid operator token.');
        return;
      }
      const readiness = await buildInstallationReadiness(config);
      // 200 whatever the verdict: NEEDS_SETUP is a correct answer to a correct question, and answering 503
      // would make a browser treat a fresh install as a broken server.
      sendJson(res, 200, {
        ok: readiness.ok,
        code: 'OPERATOR_UI_INSTALLATION_READINESS',
        readiness,
        checklist: firstRunChecklist(),
        troubleshooting: troubleshootingTable(),
        notes: { repositoryCompose: REPOSITORY_COMPOSE_NOTE, tokenHandling: TOKEN_HANDLING_NOTE },
      });
      // The verdict and nothing else. A component list here would put an installation's shape in the log.
      logs.add(readiness.ok ? 'info' : 'warn', 'operation', 'INSTALLATION_READ',
        `Served installation readiness with state=${readiness.state}.`);
      return;
    }

    // Deliberately authenticated, like every other operational route. What version something is running is
    // exactly what an attacker enumerating hosts wants, and there is no consumer for it that does not
    // already hold the token.
    if (path === '/api/version') {
      if (!isAuthorized(req, auth)) {
        ignoreRequestBody(req);
        sendUnauthorized(res);
        logs.add('warn', 'operation', 'AUTH_REJECTED', 'Rejected version request without a valid operator token.');
        return;
      }
      const version = buildRuntimeVersionView();
      sendJson(res, 200, { ok: version.agreement !== 'MISMATCH', code: 'OPERATOR_UI_VERSION', version });
      logs.add('info', 'operation', 'VERSION_READ', `Served runtime version with provenance=${version.provenance}.`);
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

/**
 * Gather the facts and derive the verdict.
 *
 * Every gatherer is wrapped: a readiness endpoint that throws when the thing it is reporting on is broken is
 * the one endpoint that must never do that. A chain read that fails becomes UNAVAILABLE, a database probe
 * that fails becomes UNREACHABLE, and the page still renders with the rest intact.
 */
export async function buildInstallationReadiness(
  config: Pick<OperatorUiServiceConfig, 'promotionRecordsDir'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstallationReadiness> {
  const statics = collectStaticFacts({ promotionRecordsDir: config.promotionRecordsDir, env });

  let chainSummary: ReturnType<typeof summarizeChainSnapshot> = { chain: 'UNAVAILABLE', artifacts: null };
  try {
    chainSummary = summarizeChainSnapshot(buildPromotionChainSnapshot(config.promotionRecordsDir));
  } catch { /* an unreadable chain is a state the records component already reports */ }

  let database: Awaited<ReturnType<typeof probeDatabase>>;
  try {
    database = await probeDatabase({ env });
  } catch {
    database = 'UNREACHABLE';
  }

  return deriveInstallationReadiness({
    ...statics,
    database,
    chain: chainSummary.chain,
    artifacts: chainSummary.artifacts,
  });
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

/**
 * The one place a value becomes markup.
 *
 * Everything else on this page is built client-side with `textContent`, which cannot produce an element. The
 * checklist and the troubleshooting table are the exception: they are static guidance that must be readable
 * BEFORE a token is entered — a person who cannot log in is exactly the person who needs "here is how to
 * read your token" — so they are rendered into the shell, and therefore have to be escaped.
 *
 * The single quote is escaped too. It is not required for text content, but these strings also land in
 * attribute positions in this file, and an escaper with an exception is an escaper someone will misuse.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCommands(commands: ChecklistStep['commands']): string {
  if (commands === null) return '';
  const block = (label: string, command: string): string =>
    `<div class="cmd"><span>${escapeHtml(label)}</span><code>${escapeHtml(command)}</code></div>`;
  // Two identical blocks under two headings makes a reader hunt for a difference that is not there.
  const inner = commands.posix === commands.windows
    ? block('Any platform', commands.posix)
    : block('Linux / macOS', commands.posix) + block('Windows (PowerShell)', commands.windows);
  return `<div class="cmds">${inner}</div>`;
}

function renderChecklist(steps: readonly ChecklistStep[]): string {
  const item = (step: ChecklistStep): string =>
    `<li id="step-${escapeHtml(step.id)}"><strong>${escapeHtml(step.title)}</strong>`
    + `<p class="muted">${escapeHtml(step.why)}</p>${renderCommands(step.commands)}</li>`;
  const firstRun = steps.filter((step) => step.firstRun);
  const lifecycle = steps.filter((step) => !step.firstRun);
  return `<h3>First run — five minutes, in order</h3><ol class="list steps">${firstRun.map(item).join('')}</ol>`
    + `<h3>Running it afterwards</h3><ul class="list steps">${lifecycle.map(item).join('')}</ul>`;
}

function renderTroubleshooting(entries: readonly TroubleshootingEntry[]): string {
  const row = (entry: TroubleshootingEntry): string =>
    `<li id="trouble-${escapeHtml(entry.id)}"><strong>${escapeHtml(entry.symptom)}</strong>`
    + `<p class="muted"><em>Likely cause.</em> ${escapeHtml(entry.likelyCause)}</p>`
    + `<p><em>Do this.</em> ${escapeHtml(entry.fix)}</p>${renderCommands(entry.commands)}</li>`;
  return `<ul class="list steps">${entries.map(row).join('')}</ul>`;
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
h3{font-size:13px;margin:16px 0 8px;color:#354154}nav{display:flex;gap:14px;flex-wrap:wrap;font-size:13px}nav a{color:#1769aa}
ol.list{list-style:decimal;padding-left:22px}ol.list li{list-style:decimal}
:focus-visible{outline:3px solid #1769aa;outline-offset:2px}
.steps li{padding:12px 14px}.steps strong{display:block;margin-bottom:4px;font-size:13px}.steps p{margin:4px 0 8px}
.cmds{display:grid;gap:6px}.cmd{display:grid;gap:3px}.cmd span{font-size:11px;color:#637083;text-transform:uppercase;letter-spacing:.04em}
code{display:block;background:#101820;color:#eef4f8;border-radius:6px;padding:8px 10px;font-size:12px;overflow-wrap:anywhere;user-select:all}
.verdict{display:inline-block;border-radius:999px;padding:6px 14px;font-weight:700;font-size:13px;border:1px solid #b9c2cf;background:#f8fafc}
.verdict.ready{background:#e7f5ec;border-color:#177245;color:#0f5132}.verdict.setup{background:#fff5e0;border-color:#9b6400;color:#7a4f00}
.verdict.degraded{background:#fdeceb;border-color:#b42318;color:#8d1a12}
.hint{font-size:12px;color:#536173;margin:6px 0 0}.err{color:#b42318}.ok-text{color:#177245}
dl.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:13px}dl.kv dt{color:#637083}dl.kv dd{margin:0;overflow-wrap:anywhere}
@media(max-width:760px){main{grid-template-columns:1fr;padding:12px}header{padding:14px 12px;flex-wrap:wrap;gap:10px}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
<header><h1>Catalog Authority</h1>
<nav aria-label="Sections"><a href="#setup-panel">Setup &amp; Diagnostics</a><a href="#status-panel">Status</a><a href="#promotion-panel">Promotion record chain</a><a href="#logs-panel">Logs</a></nav>
<div class="badge">read-only operator UI</div></header>
<main>
<section class="panel">
<h2>Access</h2>
<p class="hint">There is no username and no password. This stack authenticates with a single token that the
setup script wrote to a file on this machine — <code>./secrets/operator_ui_token</code>. Read it and paste it
below.</p>
<div class="field"><label for="token">Operator token</label>
<input id="token" type="password" autocomplete="off" spellcheck="false" aria-describedby="tokenHelp"></div>
<p class="hint" id="tokenHelp">${escapeHtml(TOKEN_HANDLING_NOTE)}</p>
<div class="actions"><button id="refresh">Load everything</button><button id="clear" type="button">Clear</button></div>
<div class="status" id="statusText" role="status" aria-live="polite"></div>
</section>
<section class="panel wide" id="setup-panel">
<h2>Setup &amp; Diagnostics</h2>
<p><span class="verdict" id="verdict">Not loaded</span></p>
<p class="status" id="verdictHeadline">Paste your operator token above and choose <strong>Load everything</strong>.</p>
<div class="grid">
<div class="metric"><span>Version</span><strong id="verVersion">-</strong></div>
<div class="metric"><span>Build</span><strong id="verProvenance">-</strong></div>
<div class="metric"><span>Bundle agreement</span><strong id="verAgreement">-</strong></div>
<div class="metric"><span>Image pin</span><strong id="verPin">-</strong></div>
</div>
<h3>What is configured</h3>
<ul class="list" id="components"><li class="muted">Not loaded.</li></ul>
<h3>Do this next</h3>
<ol class="list steps" id="nextSteps"><li class="muted">Not loaded.</li></ol>
<h3>Artifacts found</h3>
<dl class="kv" id="artifactSummary"><dt>Artifacts</dt><dd>Not loaded.</dd></dl>
<h3>Notes</h3>
<ul class="list" id="advisories"><li class="muted">Not loaded.</li></ul>
<p class="hint" id="authorizationNote"></p>
</section>
<section class="panel wide" id="firstrun-panel">
<h2>First-run checklist</h2>
<p class="muted">These are the same commands whatever this installation reports, so they are readable without
a token — the person who cannot log in is the person who needs the "read your token" line.</p>
${renderChecklist(firstRunChecklist())}
<p class="hint">${escapeHtml(REPOSITORY_COMPOSE_NOTE)}</p>
</section>
<section class="panel wide" id="trouble-panel">
<h2>Troubleshooting</h2>
${renderTroubleshooting(troubleshootingTable())}
</section>
<section class="panel" id="status-panel">
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
<section class="panel" id="logs-panel">
<h2>Logs</h2>
<pre id="logs">No logs loaded.</pre>
</section>
<section class="panel wide" id="promotion-panel">
<h2>Promotion Record Chain</h2>
<p class="muted">Phases 231-241, audited from the read-only artifact folder mounted into this container. Nothing on this page changes a record, and the folder cannot be chosen from the browser.</p>
<div class="grid">
<div class="metric"><span>Outcome</span><strong id="chainOutcome">-</strong></div>
<div class="metric"><span>Chain reaches</span><strong id="chainReaches">-</strong></div>
<div class="metric"><span>Outstanding next</span><strong id="chainNext">-</strong></div>
<div class="metric"><span>Blockers</span><strong id="chainBlockerCount">-</strong></div>
</div>
<p class="status" id="chainHeadline"></p>
<p class="muted" id="chainCaveat"></p>
<h3>Artifacts</h3>
<ul class="list" id="chainArtifacts"><li class="muted">No chain loaded.</li></ul>
<h3>Blockers</h3>
<ul class="list" id="chainBlockers"><li class="muted">No chain loaded.</li></ul>
<h3>Safe next steps for a human</h3>
<ol class="list" id="chainSteps"><li class="muted">No chain loaded.</li></ol>
<h3>Proof limits</h3>
<ul class="list" id="chainLimits"><li class="muted">No chain loaded.</li></ul>
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
const chainOutcome = document.getElementById('chainOutcome');
const chainReaches = document.getElementById('chainReaches');
const chainNext = document.getElementById('chainNext');
const chainBlockerCount = document.getElementById('chainBlockerCount');
const chainHeadline = document.getElementById('chainHeadline');
const chainCaveat = document.getElementById('chainCaveat');
const chainArtifacts = document.getElementById('chainArtifacts');
const chainBlockers = document.getElementById('chainBlockers');
const chainSteps = document.getElementById('chainSteps');
const chainLimits = document.getElementById('chainLimits');
const verdict = document.getElementById('verdict');
const verdictHeadline = document.getElementById('verdictHeadline');
const authorizationNote = document.getElementById('authorizationNote');
const verVersion = document.getElementById('verVersion');
const verProvenance = document.getElementById('verProvenance');
const verAgreement = document.getElementById('verAgreement');
const verPin = document.getElementById('verPin');
const components = document.getElementById('components');
const nextSteps = document.getElementById('nextSteps');
const artifactSummary = document.getElementById('artifactSummary');
const advisories = document.getElementById('advisories');
// Error text an operator can act on. A bare "request failed" sends someone to the logs for a problem whose
// answer is "you pasted a stale token"; the status code already knows which of those it is.
function describeFailure(status, body){
  if(status === 401) return 'The operator token was not accepted. Re-read ./secrets/operator_ui_token and paste it with no extra spaces or line breaks.';
  if(status === 503) return 'The service answered, but a dependency it needs is not ready. See Setup & Diagnostics.';
  if(status === 0) return 'The server did not answer. Check that the stack is running, then press Load everything again.';
  return (body && (body.message || body.code)) || ('The request failed with status ' + status + '.');
}
async function getJson(path){
  const value = token.value;
  let res;
  try{
    res = await fetch(path,{headers:{'${OPERATOR_UI_LOCAL_AUTH_HEADER}':value},cache:'no-store'});
  }catch(err){
    throw new Error(describeFailure(0, null));
  }
  const body = await res.json().catch(() => null);
  if(!res.ok) throw new Error(describeFailure(res.status, body));
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
// Every list is built with createElement + textContent. Nothing served here is ever parsed as markup, so a
// value that somehow reached this page could still never execute.
function setList(target, items){
  target.replaceChildren();
  if(items.length === 0){ const li = document.createElement('li'); li.className='muted'; li.textContent='None.'; target.appendChild(li); return; }
  for(const item of items){ const li = document.createElement('li'); li.textContent = item; target.appendChild(li); }
}
// The chain answers 503 for a chain that does not hang together and for a fresh install with no anchor yet.
// Both are states to SHOW, not request failures to hide, so only a rejected token is treated as an error.
async function getChain(){
  const res = await fetch('/api/promotion-chain',{headers:{'${OPERATOR_UI_LOCAL_AUTH_HEADER}':token.value},cache:'no-store'});
  const body = await res.json();
  if(res.status === 401) throw new Error(body.message || 'operator token required');
  return body;
}
function renderChain(data){
  const view = data && data.view;
  if(!view){
    chainOutcome.textContent = (data && data.availability) || 'UNAVAILABLE';
    chainReaches.textContent = '-'; chainNext.textContent = '-'; chainBlockerCount.textContent = '-';
    chainHeadline.textContent = 'No promotion record chain is readable yet.';
    chainCaveat.textContent = '';
    setList(chainArtifacts, (data && data.unavailableGuidance) || []);
    setList(chainBlockers, []); setList(chainSteps, []); setList(chainLimits, []);
    return;
  }
  chainOutcome.textContent = view.overall;
  chainHeadline.textContent = view.headline;
  chainCaveat.textContent = view.caveat;
  chainReaches.textContent = view.terminalPhase === null ? 'nothing yet' : 'Phase ' + view.terminalPhase;
  chainNext.textContent = view.nextRequiredPhase === null
    ? 'nothing further'
    : 'Phase ' + view.nextRequiredPhase + (view.nextIsUnfinished ? ' (present, not finished)' : '');
  chainBlockerCount.textContent = String(view.blockers.length);
  setList(chainArtifacts, view.artifacts.map(a => 'Phase ' + a.phase + ' - ' + a.status + ' - ' + a.detail));
  setList(chainBlockers, view.blockers.map(b => b.code + ' - ' + b.meaning + ' Do: ' + b.humanAction));
  setList(chainSteps, view.nextSteps);
  setList(chainLimits, view.proofLimits.map(l => 'Phase ' + l.phase + ' establishes: ' + l.establishes + ' It does NOT establish: ' + l.doesNotEstablish));
}
const VERDICT_CLASS = { READY: 'verdict ready', NEEDS_SETUP: 'verdict setup', DEGRADED: 'verdict degraded' };
// Built from the checklist the same response carried, so a step id can never render as a bare identifier.
function renderInstallation(data){
  const r = data.readiness;
  const steps = data.checklist || [];
  verdict.textContent = r.state;
  verdict.className = VERDICT_CLASS[r.state] || 'verdict';
  verdictHeadline.textContent = r.headline;
  authorizationNote.textContent = r.authorizationNote;
  const v = r.version;
  verVersion.textContent = v.version || 'not declared';
  verProvenance.textContent = v.provenance;
  verAgreement.textContent = v.agreement;
  verPin.textContent = v.image.pinnedByDigest ? 'digest' : (v.image.tag || v.image.state.toLowerCase());
  setList(components, r.components.map(c => c.title + ' - ' + c.state + ' - ' + c.detail));
  const byId = {};
  for(const step of steps) byId[step.id] = step;
  nextSteps.replaceChildren();
  if(r.nextSteps.length === 0){
    const li = document.createElement('li'); li.className='muted';
    li.textContent = 'Nothing outstanding.'; nextSteps.appendChild(li);
  }else{
    for(const id of r.nextSteps){
      const step = byId[id]; if(!step) continue;
      const li = document.createElement('li');
      const title = document.createElement('strong'); title.textContent = step.title; li.appendChild(title);
      const why = document.createElement('p'); why.className='muted'; why.textContent = step.why; li.appendChild(why);
      if(step.commands){
        const same = step.commands.posix === step.commands.windows;
        const pairs = same
          ? [['Any platform', step.commands.posix]]
          : [['Linux / macOS', step.commands.posix],['Windows (PowerShell)', step.commands.windows]];
        for(const [label,value] of pairs){
          const wrap = document.createElement('div'); wrap.className='cmd';
          const name = document.createElement('span'); name.textContent = label; wrap.appendChild(name);
          const code = document.createElement('code'); code.textContent = value; wrap.appendChild(code);
          li.appendChild(wrap);
        }
      }
      nextSteps.appendChild(li);
    }
  }
  artifactSummary.replaceChildren();
  const a = r.artifacts;
  const pairs = a === null
    ? [['Artifacts','No readable chain yet.']]
    : [['Present', String(a.present) + ' of ' + String(a.expected)],
       ['Blockers', String(a.blockers)],
       ['Chain reaches', a.terminalPhase === null ? 'nothing yet' : 'Phase ' + a.terminalPhase],
       ['Outstanding next', a.nextRequiredPhase === null ? 'nothing further' : 'Phase ' + a.nextRequiredPhase]];
  for(const [key,value] of pairs){
    const dt = document.createElement('dt'); dt.textContent = key; artifactSummary.appendChild(dt);
    const dd = document.createElement('dd'); dd.textContent = value; artifactSummary.appendChild(dd);
  }
  setList(advisories, r.advisories);
}
async function refresh(){
  statusText.className = 'status';
  statusText.textContent = 'Loading...';
  if(token.value === ''){
    statusText.className = 'status err';
    statusText.textContent = 'Paste your operator token first. Read it with: cat ./secrets/operator_ui_token';
    return;
  }
  // Settled independently: a stack with no database still has a promotion record chain worth reading, and one
  // panel failing must not blank the others.
  const [i,s,l,c] = await Promise.allSettled([
    getJson('/api/installation'), getJson('/api/status'), getJson('/api/logs'), getChain()]);
  const problems = [];
  if(i.status === 'fulfilled') renderInstallation(i.value); else problems.push(i.reason.message);
  if(s.status === 'fulfilled') renderStatus(s.value); else problems.push(s.reason.message);
  if(l.status === 'fulfilled') renderLogs(l.value); else problems.push(l.reason.message);
  if(c.status === 'fulfilled') renderChain(c.value); else problems.push(c.reason.message);
  // De-duplicated: four routes rejecting one stale token is one problem, not four lines of the same sentence.
  const unique = [...new Set(problems)];
  statusText.className = unique.length === 0 ? 'status ok-text' : 'status err';
  statusText.textContent = unique.length === 0
    ? 'Updated. Everything below reflects this moment; press Load everything again after you change anything.'
    : unique.join(' ');
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('clear').addEventListener('click', () => {
  token.value=''; statusText.className='status'; statusText.textContent='Token cleared from this page.';
});
</script>
</body>
</html>`;
}
