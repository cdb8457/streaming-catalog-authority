import {
  TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY,
  assertTorBoxOperationAllowed,
  type TorBoxErrorCategory,
  type TorBoxReadOnlyOperation,
  type TorBoxTransport,
  type TorBoxTransportRequest,
  type TorBoxTransportResponse,
} from '../core/adapters/torbox-real-client-gate.js';

/**
 * Phase 42 - first live-capable TorBox transport.
 *
 * This module is operator-smoke plumbing only. It is not wired into the provider factory, does not
 * read env or secret files, does not import the TorBox SDK, and never returns raw provider payloads.
 */

export type TorBoxFetchLike = (
  url: string,
  init: {
    readonly method: 'GET';
    readonly headers: Record<string, string>;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  readonly json?: () => Promise<unknown>;
  readonly text?: () => Promise<string>;
}>;

export interface TorBoxLiveTransportConfig {
  readonly fetchImpl: TorBoxFetchLike;
  readonly bearerToken: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

export interface TorBoxLiveTransportProbe {
  readonly operation: TorBoxReadOnlyOperation;
  readonly method: 'GET';
  readonly path: '/' | '/v1/api/torrents/checkcached' | '/v1/api/webdl/checkcached' | '/v1/api/usenet/checkcached' | '/v1/api/webdl/hosters';
  readonly auth: 'none' | 'bearer-header';
  readonly queryKeys: readonly string[];
}

const ROUTES = {
  'status-check': { path: '/', auth: 'none' },
  'hoster-list': { path: '/v1/api/webdl/hosters', auth: 'none' },
  'torrent-cache-check': { path: '/v1/api/torrents/checkcached', auth: 'bearer-header' },
  'webdl-cache-check': { path: '/v1/api/webdl/checkcached', auth: 'bearer-header' },
  'usenet-cache-check': { path: '/v1/api/usenet/checkcached', auth: 'bearer-header' },
} as const satisfies Record<TorBoxReadOnlyOperation, {
  readonly path: TorBoxLiveTransportProbe['path'];
  readonly auth: TorBoxLiveTransportProbe['auth'];
}>;

export const TORBOX_LIVE_TRANSPORT_REVIEWED_ENDPOINTS: readonly TorBoxLiveTransportProbe[] = [
  { operation: 'status-check', method: 'GET', path: '/', auth: 'none', queryKeys: [] },
  { operation: 'hoster-list', method: 'GET', path: '/v1/api/webdl/hosters', auth: 'none', queryKeys: [] },
  { operation: 'torrent-cache-check', method: 'GET', path: '/v1/api/torrents/checkcached', auth: 'bearer-header', queryKeys: ['hash', 'format', 'list_files'] },
  { operation: 'webdl-cache-check', method: 'GET', path: '/v1/api/webdl/checkcached', auth: 'bearer-header', queryKeys: ['hash', 'format', 'list_files'] },
  { operation: 'usenet-cache-check', method: 'GET', path: '/v1/api/usenet/checkcached', auth: 'bearer-header', queryKeys: ['hash', 'format', 'list_files'] },
];

export function createTorBoxLiveTransport(config: TorBoxLiveTransportConfig): TorBoxTransport {
  const fetchImpl = config.fetchImpl;
  const bearerToken = validateBearerToken(config.bearerToken);
  const baseUrl = validateBaseUrl(config.baseUrl ?? 'https://api.torbox.app');
  const timeoutMs = clamp(config.timeoutMs, TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.perRequestTimeoutMs);
  const maxAttempts = clamp(config.maxAttempts, TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.retry.maxAttempts);

  return {
    async request(request: TorBoxTransportRequest): Promise<TorBoxTransportResponse> {
      assertTorBoxOperationAllowed(request.operation);
      if (request.method !== 'GET') return failure(405, 'forbidden-operation');
      if (request.operation.endsWith('-cache-check') && (!request.scopedRef || request.scopedRef.refValue.length === 0)) {
        return failure(undefined, 'forbidden-operation');
      }
      const route = ROUTES[request.operation];
      const url = buildUrl(baseUrl, route.path, request);
      const headers: Record<string, string> = route.auth === 'bearer-header' ? { Authorization: `Bearer ${bearerToken}` } : {};

      let last: TorBoxTransportResponse = failure(undefined, 'transport');
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        last = await fetchOnce(fetchImpl, url.toString(), headers, timeoutMs, request.operation);
        if (!isRetryable(last.category) || attempt === maxAttempts) return last;
        await delay(backoffMs(attempt));
      }
      return last;
    },
  };
}

function buildUrl(baseUrl: URL, path: TorBoxLiveTransportProbe['path'], request: TorBoxTransportRequest): URL {
  const url = new URL(path, baseUrl);
  if (request.operation.endsWith('-cache-check')) {
    const scopedRef = request.scopedRef;
    if (!scopedRef || scopedRef.refValue.length === 0) return url;
    url.searchParams.set('hash', scopedRef.refValue);
    url.searchParams.set('format', 'object');
    url.searchParams.set('list_files', 'false');
  }
  return url;
}

async function fetchOnce(
  fetchImpl: TorBoxFetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  operation: TorBoxReadOnlyOperation,
): Promise<TorBoxTransportResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    const category = categoryForStatus(response.status);
    if (category) return failure(response.status, category);
    const body = await parseProviderBody(response);
    if (body === PARSE_FAILED && operation.endsWith('-cache-check')) return failure(response.status, 'parse');
    return {
      status: response.status,
      body: { availability: operation === 'status-check' || operation === 'hoster-list' ? 'available' : normalizeAvailability(body) },
    };
  } catch (err) {
    return failure(undefined, isAbortLike(err) ? 'timeout' : 'transport');
  } finally {
    clearTimeout(timer);
  }
}

const PARSE_FAILED = Symbol('torbox-parse-failed');

async function parseProviderBody(response: Awaited<ReturnType<TorBoxFetchLike>>): Promise<unknown | typeof PARSE_FAILED> {
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      return PARSE_FAILED;
    }
  }
  if (typeof response.text === 'function') {
    try {
      return JSON.parse(await response.text());
    } catch {
      return PARSE_FAILED;
    }
  }
  return null;
}

function normalizeAvailability(body: unknown): 'available' | 'unavailable' | 'unknown' {
  const direct = availabilityFromValue(body);
  if (direct) return direct;
  if (isPlainObject(body)) {
    for (const key of ['data', 'result', 'results', 'cached']) {
      const nested = availabilityFromValue(body[key]);
      if (nested) return nested;
    }
  }
  return 'unknown';
}

function availabilityFromValue(value: unknown): 'available' | 'unavailable' | 'unknown' | null {
  if (typeof value === 'boolean') return value ? 'available' : 'unavailable';
  if (Array.isArray(value)) return value.length > 0 ? 'available' : 'unavailable';
  if (isPlainObject(value)) {
    for (const key of ['cached', 'available', 'is_cached']) {
      if (typeof value[key] === 'boolean') return value[key] ? 'available' : 'unavailable';
    }
    const values = Object.values(value);
    if (values.length > 0 && values.every((item) => item === false || (Array.isArray(item) && item.length === 0))) return 'unavailable';
    if (values.some((item) => item === true || (Array.isArray(item) && item.length > 0) || (isPlainObject(item) && availabilityFromValue(item) === 'available'))) return 'available';
  }
  return null;
}

function categoryForStatus(status: number): TorBoxErrorCategory | null {
  if (status >= 200 && status <= 299) return null;
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'quota';
  return 'transport';
}

function failure(status: number | undefined, category: TorBoxErrorCategory): TorBoxTransportResponse {
  return status === undefined ? { status: 0, category, body: { availability: 'unknown' } } : { status, category, body: { availability: 'unknown' } };
}

function isRetryable(category: TorBoxErrorCategory | undefined): boolean {
  return category === 'quota' || category === 'timeout' || category === 'transport';
}

function backoffMs(attempt: number): number {
  return Math.min(
    TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.retry.maxDelayMs,
    TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.retry.baseDelayMs * attempt,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateBearerToken(value: string): string {
  const token = value.trim();
  if (token.length === 0 || /[\r\n]/.test(token)) throw new Error('TorBox bearer token is required');
  return token;
}

function validateBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('TorBox base URL must be HTTPS');
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function clamp(value: number | undefined, policy: { readonly default: number; readonly min: number; readonly max: number }): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return policy.default;
  return Math.min(policy.max, Math.max(policy.min, value));
}

function isAbortLike(err: unknown): boolean {
  return isPlainObject(err) && err.name === 'AbortError';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
