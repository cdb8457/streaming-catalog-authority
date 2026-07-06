import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  OPERATOR_UI_LOCAL_AUTH_HEADER,
  type OperatorUiLocalAuthRuntime,
  OperatorUiLocalAuthRuntimeError,
  loadOperatorUiLocalAuthRuntime,
  verifyOperatorUiLocalAuthHeader,
} from './operator-ui-local-auth-runtime.js';
import { buildOperatorUiSanitizedPacketSnapshot } from './operator-ui-packet-endpoint.js';
import { buildOperatorUiStaticArtifact, type OperatorUiStaticArtifact } from './operator-ui-static-artifact.js';
import { OPERATOR_UI_STATIC_PROTOTYPE_SCRIPT_SHA256 } from './operator-ui-static-prototype.js';
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
  `script-src 'sha256-${OPERATOR_UI_STATIC_PROTOTYPE_SCRIPT_SHA256}'`,
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export interface OperatorUiStaticRuntimeConfigInput {
  readonly host?: string;
  readonly port?: number;
  readonly operatorSecretFile?: string;
}

export interface OperatorUiStaticRuntimeConfig {
  readonly host: typeof OPERATOR_UI_STATIC_RUNTIME_DEFAULT_HOST;
  readonly port: number;
  readonly operatorSecretFile?: string;
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

export interface OperatorUiStaticRuntimeManifest {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_STATIC_RUNTIME_MANIFEST';
  readonly surface: 'local-static-fixture-preview';
  readonly routes: readonly string[];
  readonly dataMode: 'fixture-only';
  readonly packetSource: 'not-implemented' | 'sanitized-local-packet-endpoint';
  readonly localRuntime: 'static-preview-only';
  readonly liveProduct: 'not-ready';
  readonly accessBoundary: 'loopback-only-fixture-preview';
  readonly operatorAuth: 'not-implemented' | 'local-secret-file-enabled';
  readonly remoteExposure: 'blocked';
  readonly futureDataSurfacesRequire: 'explicit-auth-access-phase';
  readonly boundaries: readonly string[];
  readonly gates: readonly string[];
}

const OPERATOR_UI_STATIC_RUNTIME_MANIFEST: OperatorUiStaticRuntimeManifest = {
  ok: true,
  code: 'OPERATOR_UI_STATIC_RUNTIME_MANIFEST',
  surface: 'local-static-fixture-preview',
  routes: ['GET /', 'GET /healthz', 'GET /manifest.json'],
  dataMode: 'fixture-only',
  packetSource: 'not-implemented',
  localRuntime: 'static-preview-only',
  liveProduct: 'not-ready',
  accessBoundary: 'loopback-only-fixture-preview',
  operatorAuth: 'not-implemented',
  remoteExposure: 'blocked',
  futureDataSurfacesRequire: 'explicit-auth-access-phase',
  boundaries: [
    'no-db-read',
    'no-provider-call-or-integration',
    'no-api-data-route',
    'no-playback-control',
    'no-download-control',
    'no-scraping',
    'no-media-server-logic',
    'no-packet-source',
    'no-live-packet-ingestion',
    'no-secret-material',
    'no-host-machine-data',
    'no-filesystem-artifact-read',
    'no-env-or-config-read',
    'no-outbound-network',
  ],
  gates: [
    'Phase 64 render allowlist remains enforced',
    'Phase 65 in-process static artifact remains the root body',
    'Phase 68 local runtime boundary remains blocked/deferred',
    'Phase 69 packet source contract remains not implemented',
    'Phase 71 raw target hardening remains enforced',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness, not production KMS',
    'Provider availability remains packet/count/advisory only',
  ],
};

export function buildOperatorUiStaticRuntimeManifest(
  options: { readonly operatorAuthEnabled?: boolean } = {},
): OperatorUiStaticRuntimeManifest {
  const operatorAuthEnabled = options.operatorAuthEnabled === true;
  const boundaries = operatorAuthEnabled
    ? OPERATOR_UI_STATIC_RUNTIME_MANIFEST.boundaries.map((boundary) => {
      if (boundary === 'no-api-data-route') return 'sanitized-local-packet-endpoint-auth-gated';
      if (boundary === 'no-packet-source') return 'fixture-packet-source-only';
      return boundary;
    })
    : [...OPERATOR_UI_STATIC_RUNTIME_MANIFEST.boundaries];
  return {
    ...OPERATOR_UI_STATIC_RUNTIME_MANIFEST,
    routes: operatorAuthEnabled
      ? [...OPERATOR_UI_STATIC_RUNTIME_MANIFEST.routes, 'GET /operator-ui/packets.json']
      : [...OPERATOR_UI_STATIC_RUNTIME_MANIFEST.routes],
    packetSource: operatorAuthEnabled ? 'sanitized-local-packet-endpoint' : 'not-implemented',
    operatorAuth: operatorAuthEnabled ? 'local-secret-file-enabled' : 'not-implemented',
    boundaries,
    gates: [...OPERATOR_UI_STATIC_RUNTIME_MANIFEST.gates],
  };
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

  return input.operatorSecretFile === undefined ? { host, port } : { host, port, operatorSecretFile: input.operatorSecretFile };
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

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  setSafeHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(body)}\n`);
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    ok: false,
    code: 'OPERATOR_UI_PACKET_ENDPOINT_UNAUTHORIZED',
    message: 'Operator UI packet endpoint is unauthorized.',
  });
}

function rawRequestTarget(req: IncomingMessage): string {
  return req.url ?? '/';
}

function rawRequestPath(rawTarget: string): string {
  const queryIndex = rawTarget.indexOf('?');
  return queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
}

function isQueryBearingPacketEndpointRawTarget(rawTarget: string): boolean {
  return rawTarget.startsWith('/operator-ui/packets.json?');
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
  auth?: OperatorUiLocalAuthRuntime,
): Server {
  return hardenServer(createServer((req, res) => {
    const method = req.method ?? '';
    const rawTarget = rawRequestTarget(req);
    const path = rawRequestPath(rawTarget);
    if (isQueryBearingPacketEndpointRawTarget(rawTarget) || isUnsafeRawRequestPath(path)) {
      ignoreRequestBody(req);
      sendPlain(res, 404, 'not found\n', undefined, method === 'HEAD');
      return;
    }

    const packetEndpointEnabled = auth !== undefined;
    const isKnownPath = path === '/'
      || path === '/healthz'
      || path === '/manifest.json'
      || (packetEndpointEnabled && path === '/operator-ui/packets.json');

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
      sendJson(res, 200, {
        ok: true,
        code: 'OPERATOR_UI_STATIC_RUNTIME_HEALTHY',
        status: 'fixture/static/local-only',
      });
      return;
    }

    if (path === '/manifest.json') {
      sendJson(res, 200, buildOperatorUiStaticRuntimeManifest({ operatorAuthEnabled: packetEndpointEnabled }));
      return;
    }

    if (path === '/operator-ui/packets.json' && packetEndpointEnabled) {
      const presented = req.headers[OPERATOR_UI_LOCAL_AUTH_HEADER];
      if (!verifyOperatorUiLocalAuthHeader(auth, presented)) {
        ignoreRequestBody(req);
        sendUnauthorized(res);
        return;
      }

      sendJson(res, 200, buildOperatorUiSanitizedPacketSnapshot());
      return;
    }

    sendPlain(res, 404, 'not found\n');
  }));
}

export function startOperatorUiStaticRuntime(
  input: OperatorUiStaticRuntimeConfigInput = {},
): Promise<StartedOperatorUiStaticRuntime> {
  const config = validateOperatorUiStaticRuntimeConfig(input, { allowEphemeralPort: true });
  let auth: OperatorUiLocalAuthRuntime | undefined;
  try {
    auth = config.operatorSecretFile === undefined ? undefined : loadOperatorUiLocalAuthRuntime(config.operatorSecretFile);
  } catch {
    return Promise.reject(new OperatorUiLocalAuthRuntimeError());
  }

  let server: Server;
  try {
    server = createOperatorUiStaticRuntimeServer(undefined, auth);
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
