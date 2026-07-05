import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildOperatorUiStaticArtifact, type OperatorUiStaticArtifact } from './operator-ui-static-artifact.js';
import { inspectOperatorUiRenderedHtml } from './operator-ui-render-allowlist.js';

export const OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST = '127.0.0.1';
export const OPERATOR_UI_STATIC_RUNTIME_DEFAULT_PORT = 8787;
export const OPERATOR_UI_STATIC_RUNTIME_MIN_CLI_PORT = 1024;
export const OPERATOR_UI_STATIC_RUNTIME_MAX_PORT = 65535;
export const OPERATOR_UI_STATIC_RUNTIME_REQUEST_TIMEOUT_MS = 15000;
export const OPERATOR_UI_STATIC_RUNTIME_HEADERS_TIMEOUT_MS = 8000;
export const OPERATOR_UI_STATIC_RUNTIME_KEEP_ALIVE_TIMEOUT_MS = 3000;
export const OPERATOR_UI_STATIC_RUNTIME_MAX_HEADERS_COUNT = 64;

export const OPERATOR_UI_STATIC_RUNTIME_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export interface OperatorUiStaticRuntimeConfigInput {
  readonly host?: string;
  readonly port?: number;
}

export interface OperatorUiStaticRuntimeConfig {
  readonly host: typeof OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST;
  readonly port: number;
}

export interface OperatorUiStaticRuntimeValidationOptions {
  readonly allowEphemeralPort?: boolean;
}

export class OperatorUiStaticRuntimeConfigError extends Error {
  readonly code = 'OPERATOR_UI_STATIC_RUNTIME_CONFIG_REJECTED';

  constructor(message = 'Operator UI static runtime config is not local-only and bounded.') {
    super(message);
    this.name = 'OperatorUiStaticRuntimeConfigError';
  }
}

export class OperatorUiStaticRuntimeSelfCheckError extends Error {
  readonly code = 'OPERATOR_UI_STATIC_RUNTIME_SELF_CHECK_REJECTED';

  constructor(message = 'Operator UI static runtime self-check failed safely.') {
    super(message);
    this.name = 'OperatorUiStaticRuntimeSelfCheckError';
  }
}

export interface StartedOperatorUiStaticRuntime {
  readonly server: Server;
  readonly host: typeof OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST;
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

function isAllowedHost(host: string): host is typeof OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST {
  return host === OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST;
}

function isAllowedPort(port: number, allowEphemeralPort: boolean): boolean {
  if (!Number.isInteger(port)) return false;
  if (allowEphemeralPort && port === 0) return true;
  return port >= OPERATOR_UI_STATIC_RUNTIME_MIN_CLI_PORT && port <= OPERATOR_UI_STATIC_RUNTIME_MAX_PORT;
}

export function validateOperatorUiStaticRuntimeConfig(
  input: OperatorUiStaticRuntimeConfigInput = {},
  options: OperatorUiStaticRuntimeValidationOptions = {},
): OperatorUiStaticRuntimeConfig {
  const host = input.host ?? OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST;
  const port = input.port ?? OPERATOR_UI_STATIC_RUNTIME_DEFAULT_PORT;
  const allowEphemeralPort = options.allowEphemeralPort ?? true;

  if (!isAllowedHost(host)) throw new OperatorUiStaticRuntimeConfigError();
  if (!isAllowedPort(port, allowEphemeralPort)) throw new OperatorUiStaticRuntimeConfigError();

  return { host, port };
}

function setSafeHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', OPERATOR_UI_STATIC_RUNTIME_CSP);
}

function sendPlain(res: ServerResponse, statusCode: number, body: string, allow?: string, emptyBody = false): void {
  setSafeHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (allow) res.setHeader('Allow', allow);
  res.end(emptyBody ? '' : body);
}

function requestPath(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}

function isTraversalLikeRequestTarget(req: IncomingMessage): boolean {
  const rawPath = (req.url ?? '/').split('?', 1)[0]?.toLowerCase() ?? '/';
  return rawPath.includes('..')
    || rawPath.includes('\\')
    || rawPath.includes('%2e')
    || rawPath.includes('%2f')
    || rawPath.includes('%5c');
}

function ignoreRequestBody(req: IncomingMessage): void {
  req.resume();
}

export function buildPrecheckedOperatorUiStaticRuntimeArtifact(): OperatorUiStaticArtifact {
  const artifact = buildOperatorUiStaticArtifact();
  const inspection = inspectOperatorUiRenderedHtml(artifact.html);
  if (!inspection.ok) throw new OperatorUiStaticRuntimeSelfCheckError();
  return artifact;
}

function hardenServer(server: Server): Server {
  server.requestTimeout = OPERATOR_UI_STATIC_RUNTIME_REQUEST_TIMEOUT_MS;
  server.headersTimeout = OPERATOR_UI_STATIC_RUNTIME_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = OPERATOR_UI_STATIC_RUNTIME_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = OPERATOR_UI_STATIC_RUNTIME_MAX_HEADERS_COUNT;
  return server;
}

export function createOperatorUiStaticRuntimeServer(
  artifact: OperatorUiStaticArtifact = buildPrecheckedOperatorUiStaticRuntimeArtifact(),
): Server {
  return hardenServer(createServer((req, res) => {
    const method = req.method ?? '';
    if (isTraversalLikeRequestTarget(req)) {
      ignoreRequestBody(req);
      sendPlain(res, 404, 'not found\n', undefined, method === 'HEAD');
      return;
    }

    const path = requestPath(req);
    if (path === null) {
      ignoreRequestBody(req);
      sendPlain(res, 400, 'bad request\n');
      return;
    }

    const isKnownPath = path === '/' || path === '/healthz';

    if (method === 'HEAD') {
      ignoreRequestBody(req);
      sendPlain(res, isKnownPath ? 405 : 404, isKnownPath ? 'method not allowed\n' : 'not found\n', isKnownPath ? 'GET' : undefined, true);
      return;
    }

    if (method !== 'GET') {
      ignoreRequestBody(req);
      sendPlain(res, isKnownPath ? 405 : 404, isKnownPath ? 'method not allowed\n' : 'not found\n', isKnownPath ? 'GET' : undefined);
      return;
    }

    if (path === '/') {
      ignoreRequestBody(req);
      setSafeHeaders(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', artifact.contentType);
      res.end(artifact.html);
      return;
    }

    if (path === '/healthz') {
      setSafeHeaders(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(`${JSON.stringify({
        ok: true,
        code: 'OPERATOR_UI_STATIC_RUNTIME_HEALTHY',
        status: 'fixture/static/local-only',
      })}\n`);
      return;
    }

    sendPlain(res, 404, 'not found\n');
  }));
}

export function startOperatorUiStaticRuntime(
  input: OperatorUiStaticRuntimeConfigInput = {},
): Promise<StartedOperatorUiStaticRuntime> {
  const config = validateOperatorUiStaticRuntimeConfig(input, { allowEphemeralPort: true });
  let server: Server;
  try {
    server = createOperatorUiStaticRuntimeServer();
  } catch {
    return Promise.reject(new OperatorUiStaticRuntimeSelfCheckError());
  }

  return new Promise((resolve, reject) => {
    const onError = (): void => {
      server.off('listening', onListening);
      reject(new OperatorUiStaticRuntimeConfigError('Operator UI static runtime failed to start safely.'));
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
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((err) => {
            if (err) closeReject(err);
            else closeResolve();
          });
        }),
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });
}
