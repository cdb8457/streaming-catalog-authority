import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildOperatorUiStaticArtifact } from './operator-ui-static-artifact.js';

export const OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST = '127.0.0.1';
export const OPERATOR_UI_STATIC_RUNTIME_DEFAULT_PORT = 8787;
export const OPERATOR_UI_STATIC_RUNTIME_MIN_CLI_PORT = 1024;
export const OPERATOR_UI_STATIC_RUNTIME_MAX_PORT = 65535;

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
  res.setHeader('Content-Security-Policy', OPERATOR_UI_STATIC_RUNTIME_CSP);
}

function sendPlain(res: ServerResponse, statusCode: number, body: string, allow?: string): void {
  setSafeHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (allow) res.setHeader('Allow', allow);
  res.end(body);
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
}

export function createOperatorUiStaticRuntimeServer(): Server {
  return createServer((req, res) => {
    const method = req.method ?? '';
    const path = requestPath(req);
    const isKnownPath = path === '/' || path === '/healthz';

    if (method !== 'GET') {
      sendPlain(res, isKnownPath ? 405 : 404, isKnownPath ? 'method not allowed\n' : 'not found\n', isKnownPath ? 'GET' : undefined);
      return;
    }

    if (path === '/') {
      const artifact = buildOperatorUiStaticArtifact();
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
  });
}

export function startOperatorUiStaticRuntime(
  input: OperatorUiStaticRuntimeConfigInput = {},
): Promise<StartedOperatorUiStaticRuntime> {
  const config = validateOperatorUiStaticRuntimeConfig(input, { allowEphemeralPort: true });
  const server = createOperatorUiStaticRuntimeServer();

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
