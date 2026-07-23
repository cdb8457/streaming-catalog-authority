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
import {
  OPERATOR_UI_APP_CSS_ROUTE,
  OPERATOR_UI_APP_JS_ROUTE,
  operatorUiAsset,
  type OperatorUiAsset,
} from './operator-ui-assets.js';

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

// Phase 247. No `'unsafe-inline'` anywhere: the script and the stylesheet are same-origin static assets
// (/assets/app.js, /assets/app.css), so the browser executes and applies ONLY files it fetched from this
// origin. `default-src 'none'` denies everything by default and each capability is then granted narrowly:
// scripts and styles from self, XHR/fetch to self, and nothing else at all — no images, no fonts, no
// plugins, no framing, no base rewrite, no form target. An injected <script>, an inline handler, an
// external <link>, a data:/blob: URL: every one of them is refused by the policy, on top of the page's
// existing habit of only ever writing untrusted values through textContent.
export const OPERATOR_UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
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
      || path === '/api/promotion-chain' || path === '/api/installation' || path === '/api/version'
      || path === OPERATOR_UI_APP_JS_ROUTE || path === OPERATOR_UI_APP_CSS_ROUTE;
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

    // Phase 247. The UI's behaviour and presentation, as fixed same-origin static assets so the CSP can be
    // `script-src 'self'; style-src 'self'`. The lookup is an exact match against a precomputed table
    // (operator-ui-assets.ts) — the request contributes a key and nothing else. There is no filename joined
    // to a directory, no traversal to defend against beyond the target normalisation already done above, and
    // no filesystem read at request time: the bytes were read once at startup and are served from memory.
    // No token is required to READ the assets (they hold no operational data), exactly as the shell needs
    // none; every route that returns operational data still does.
    const asset = operatorUiAsset(path);
    if (asset !== undefined) {
      ignoreRequestBody(req);
      sendAsset(res, asset);
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
  res.setHeader('Content-Security-Policy', OPERATOR_UI_CSP);
}

function sendHtml(res: ServerResponse, body: string): void {
  setSafeHeaders(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(body);
}

function sendAsset(res: ServerResponse, asset: OperatorUiAsset): void {
  // `setSafeHeaders` applies the CSP, `nosniff`, and `Cache-Control: no-store`. `no-store` on the assets too
  // is deliberate: a loopback ops UI is reloaded rarely, and a stale script or stylesheet surviving an
  // upgrade is a worse failure than re-fetching a few kilobytes. The content type is fixed by the asset
  // table, never guessed from the request, and `nosniff` stops the browser from second-guessing it.
  setSafeHeaders(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('Content-Length', String(asset.bytes));
  res.end(asset.body);
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
<link rel="stylesheet" href="${OPERATOR_UI_APP_CSS_ROUTE}">
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
<script src="${OPERATOR_UI_APP_JS_ROUTE}" defer></script>
</body>
</html>`;
}
