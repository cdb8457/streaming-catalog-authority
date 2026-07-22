import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { operatorUiRenderHasExternalReference, operatorUiRenderHasForbiddenMarkup } from './operator-ui-render-allowlist.js';
import type { OperatorConsoleReport } from './promotion-operator-console.js';
import {
  buildDashboardManifest,
  buildDashboardStatus,
  renderOperatorDashboardHtml,
  type DashboardStatus,
} from './promotion-operator-dashboard.js';

// The Phase 243 dashboard's HTTP surface. It follows the Phase 70 static-runtime shape deliberately -- same
// loopback enforcement, same raw-target hardening, same server timeouts, same safe headers -- because those
// are the patterns this stack has already argued through, and a second local surface inventing its own would
// be a second thing to get wrong. It does NOT touch the Phase 147 operator UI service or the Phase 70 static
// runtime: it is a separate surface with its own manifest, and neither of theirs is relaxed to make room.
//
// LOOPBACK OR NOTHING. The host is not configurable to anything but 127.0.0.1. There is no flag, no
// environment variable and no code path that binds anywhere else, so the page cannot be reached from another
// machine even by accident.
//
// THE SNAPSHOT IS TAKEN BEFORE THE SOCKET OPENS. The console report is computed by the caller, rendered here
// once, and then held as two immutable strings. After `listen`, this process never touches the filesystem
// again on behalf of a request -- so no request can name a path, race a file, or observe a directory changing
// under it. What was audited is what every request gets.
//
// NO ROUTE TAKES A PARAMETER. Query-bearing targets are refused outright rather than parsed and ignored, so
// there is no path at all by which a browser can supply input to this server.

export const DASHBOARD_HOST = '127.0.0.1';
export const DASHBOARD_DEFAULT_PORT = 0;              // ephemeral by default: never squats a port, never collides
export const DASHBOARD_MIN_EXPLICIT_PORT = 1024;
export const DASHBOARD_MAX_PORT = 65535;
export const DASHBOARD_REQUEST_TIMEOUT_MS = 15000;
export const DASHBOARD_HEADERS_TIMEOUT_MS = 8000;
export const DASHBOARD_KEEP_ALIVE_TIMEOUT_MS = 3000;
export const DASHBOARD_MAX_HEADERS_COUNT = 64;
export const DASHBOARD_MAX_REQUEST_TARGET_LENGTH = 2048;

export const DASHBOARD_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export interface DashboardConfigInput {
  readonly host?: string;
  readonly port?: number;
}

export interface DashboardConfig {
  readonly host: typeof DASHBOARD_HOST;
  readonly port: number;
}

export class DashboardConfigError extends Error {
  readonly code = 'PROMOTION_OPERATOR_DASHBOARD_CONFIG_REJECTED';

  constructor(message = 'The dashboard binds to loopback on a bounded port, and nothing else.') {
    super(message);
    this.name = 'DashboardConfigError';
  }
}

export class DashboardRenderError extends Error {
  readonly code = 'PROMOTION_OPERATOR_DASHBOARD_RENDER_REJECTED';

  constructor(message = 'The rendered dashboard failed its own markup self-check.') {
    super(message);
    this.name = 'DashboardRenderError';
  }
}

export class DashboardStartupError extends Error {
  readonly code = 'PROMOTION_OPERATOR_DASHBOARD_STARTUP_REJECTED';

  constructor(message = 'The dashboard failed safely during startup and is not listening.') {
    super(message);
    this.name = 'DashboardStartupError';
  }
}

export interface StartedDashboard {
  readonly server: Server;
  readonly host: typeof DASHBOARD_HOST;
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

export function validateDashboardConfig(input: DashboardConfigInput = {}): DashboardConfig {
  const host = input.host ?? DASHBOARD_HOST;
  const port = input.port ?? DASHBOARD_DEFAULT_PORT;
  // Loopback is not a default here, it is the only accepted value: 0.0.0.0, ::, a LAN address and a hostname
  // that merely resolves to loopback are all refused, because "reachable from this machine only" has to be a
  // property of the bind, not of a name someone can re-point.
  if (host !== DASHBOARD_HOST) throw new DashboardConfigError();
  if (!Number.isInteger(port)) throw new DashboardConfigError();
  if (port !== 0 && (port < DASHBOARD_MIN_EXPLICIT_PORT || port > DASHBOARD_MAX_PORT)) throw new DashboardConfigError();
  return { host, port };
}

// Render once, self-check once, then serve strings. The self-check reuses the Phase 64 markup gates rather
// than restating them: no script, no form, no iframe, no inline event handler, and no external reference of
// any kind. A page that cannot pass them is never served at all.
export function renderCheckedDashboard(report: OperatorConsoleReport): { readonly html: string; readonly status: DashboardStatus } {
  const html = renderOperatorDashboardHtml(report);
  if (operatorUiRenderHasForbiddenMarkup(html) || operatorUiRenderHasExternalReference(html)) {
    throw new DashboardRenderError();
  }
  return { html, status: buildDashboardStatus(report) };
}

export function createDashboardServer(report: OperatorConsoleReport): Server {
  const { html, status } = renderCheckedDashboard(report);
  const manifest = buildDashboardManifest();

  return hardenServer(createServer((req, res) => {
    ignoreRequestBody(req);
    const method = req.method ?? '';
    const rawTarget = req.url ?? '/';

    // Anything carrying a query string is refused before it is looked at. No route here takes a parameter, so
    // accepting one and discarding it would only invite the belief that some future route might read it.
    if (rawTarget.length > DASHBOARD_MAX_REQUEST_TARGET_LENGTH) { sendPlain(res, 414, 'request target too long\n', undefined, method === 'HEAD'); return; }
    if (rawTarget.includes('?') || rawTarget.includes('#') || isUnsafeRawRequestPath(rawTarget)) {
      sendPlain(res, 404, 'not found\n', undefined, method === 'HEAD');
      return;
    }

    const known = rawTarget === '/' || rawTarget === '/healthz' || rawTarget === '/status.json' || rawTarget === '/manifest.json';
    if (method !== 'GET') {
      sendPlain(res, known ? 405 : 404, known ? 'method not allowed\n' : 'not found\n', known ? 'GET' : undefined, method === 'HEAD');
      return;
    }

    if (rawTarget === '/') { sendHtml(res, html); return; }
    if (rawTarget === '/healthz') {
      sendJson(res, 200, { ok: true, code: 'PROMOTION_OPERATOR_DASHBOARD_HEALTHY', surface: status.surface, snapshotTakenAtLaunch: true });
      return;
    }
    // A chain that is honestly unfinished is HEALTHY. Only a chain that does not hang together, or has no
    // anchor, answers 503 -- the surface never dresses incompleteness up as a fault.
    if (rawTarget === '/status.json') { sendJson(res, status.ok ? 200 : 503, status); return; }
    if (rawTarget === '/manifest.json') { sendJson(res, 200, manifest); return; }

    sendPlain(res, 404, 'not found\n');
  }));
}

export function startDashboard(report: OperatorConsoleReport, input: DashboardConfigInput = {}): Promise<StartedDashboard> {
  let config: DashboardConfig;
  let server: Server;
  try {
    config = validateDashboardConfig(input);
    server = createDashboardServer(report);
  } catch (err) {
    // Config and render failures are surfaced as themselves; anything else fails closed as a startup refusal.
    return Promise.reject(err instanceof DashboardConfigError || err instanceof DashboardRenderError ? err : new DashboardStartupError());
  }

  return new Promise((resolve, reject) => {
    const onError = (): void => {
      server.off('listening', onListening);
      server.close(() => undefined);
      reject(new DashboardStartupError());
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : config.port;
      resolve({
        server,
        host: config.host,
        port,
        url: `http://${config.host}:${port}/`,
        close: () => new Promise<void>((closeResolve) => {
          // Idempotent and never rejecting: shutdown must not be a thing that can itself fail loudly.
          server.closeAllConnections?.();
          server.close(() => closeResolve());
        }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });
}

function isUnsafeRawRequestPath(rawPath: string): boolean {
  const lower = rawPath.toLowerCase();
  return !rawPath.startsWith('/')
    || lower.startsWith('http://')
    || lower.startsWith('https://')
    || rawPath.startsWith('//')
    || rawPath.includes('..')
    || rawPath.includes('\\')
    || rawPath.includes('\0')
    || /%(?:2e|2f|5c|00)/i.test(rawPath);
}

function setSafeHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', DASHBOARD_CSP);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
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
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendPlain(res: ServerResponse, statusCode: number, body: string, allow?: string, emptyBody = false): void {
  setSafeHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (allow) res.setHeader('Allow', allow);
  res.end(emptyBody ? '' : body);
}

function ignoreRequestBody(req: IncomingMessage): void {
  req.resume();
}

function hardenServer(server: Server): Server {
  server.requestTimeout = DASHBOARD_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DASHBOARD_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = DASHBOARD_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = DASHBOARD_MAX_HEADERS_COUNT;
  return server;
}
