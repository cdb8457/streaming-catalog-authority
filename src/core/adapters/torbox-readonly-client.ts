import type { AdapterContext, AdapterRefView, AdapterResult } from './adapter.js';
import {
  TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY,
  assertTorBoxOperationAllowed,
  createTorBoxGateError,
  isTorBoxErrorCategory,
  type TorBoxErrorCategory,
  type TorBoxReadOnlyOperation,
  type TorBoxTransport,
  type TorBoxTransportRequest,
  type TorBoxTransportResponse,
} from './torbox-real-client-gate.js';

/**
 * Phase 34 - TorBox read-only injected-transport fixture client.
 *
 * This is executable contract plumbing only. It accepts an injected transport, maps scoped
 * AdapterRefView refs to Phase 33 read-only operation ids, and fails closed on anything ambiguous.
 */

export type TorBoxReadOnlySupportedRefType =
  | 'infohash'
  | 'hash-digest'
  | 'link-derived-digest'
  | 'nzb-derived-digest';

export const TORBOX_READONLY_CLIENT_REF_OPERATION_MAP = {
  infohash: 'torrent-cache-check',
  'hash-digest': 'torrent-cache-check',
  'link-derived-digest': 'webdl-cache-check',
  'nzb-derived-digest': 'usenet-cache-check',
} as const satisfies Record<TorBoxReadOnlySupportedRefType, TorBoxReadOnlyOperation>;

export const TORBOX_READONLY_CLIENT_ROUTE_IDS = {
  'torrent-cache-check': 'torrents.cache-availability',
  'webdl-cache-check': 'web-downloads.cache-availability',
  'usenet-cache-check': 'usenet.cache-availability',
  'status-check': 'general.status',
  'hoster-list': 'web-downloads.hoster-list',
} as const satisfies Record<TorBoxReadOnlyOperation, string>;

export interface TorBoxReadOnlyClientConfig {
  readonly transport: TorBoxTransport;
  readonly timeoutMs?: number;
  readonly gateErrors?: 'return-unknown' | 'throw';
}

type TransportScopedRef = NonNullable<TorBoxTransportRequest['scopedRef']>;

export class TorBoxReadOnlyClient {
  private readonly transport: TorBoxTransport;
  private readonly timeoutMs: number;
  private readonly gateErrors: 'return-unknown' | 'throw';

  constructor(config: TorBoxReadOnlyClientConfig) {
    this.transport = config.transport;
    this.timeoutMs = clampTimeout(config.timeoutMs);
    this.gateErrors = config.gateErrors ?? 'return-unknown';
  }

  describe(): { name: string; kind: 'read-only-ref-resolver' } {
    return { name: 'torbox-readonly-injected-transport-fixture', kind: 'read-only-ref-resolver' };
  }

  async resolveRef(view: AdapterRefView, ctx?: AdapterContext): Promise<AdapterResult> {
    const scopedRef = toTransportScopedRef(view);
    if (!scopedRef) {
      ctx?.log?.('torbox-readonly-client: unsupported scoped ref');
      return { status: 'unknown', detail: view.refValue.length === 0 ? 'empty-ref-value' : 'unsupported-ref-type' };
    }

    const operation = TORBOX_READONLY_CLIENT_REF_OPERATION_MAP[scopedRef.refType];
    return this.requestReadOnly(operation, scopedRef, ctx);
  }

  async checkServiceStatus(ctx?: AdapterContext): Promise<AdapterResult> {
    return this.requestReadOnly('status-check', undefined, ctx);
  }

  async checkHosters(ctx?: AdapterContext): Promise<AdapterResult> {
    return this.requestReadOnly('hoster-list', undefined, ctx);
  }

  private async requestReadOnly(
    operation: TorBoxReadOnlyOperation,
    scopedRef: TransportScopedRef | undefined,
    ctx?: AdapterContext,
  ): Promise<AdapterResult> {
    assertTorBoxOperationAllowed(operation);
    const request: TorBoxTransportRequest = {
      operation,
      method: 'GET',
      routeId: TORBOX_READONLY_CLIENT_ROUTE_IDS[operation],
      timeoutMs: this.timeoutMs,
      ...(scopedRef ? { scopedRef } : {}),
    };

    ctx?.log?.('torbox-readonly-client: read-only operation requested');

    let response: TorBoxTransportResponse;
    try {
      response = await this.transport.request(request);
    } catch (err) {
      const category: TorBoxErrorCategory = err instanceof SyntaxError ? 'parse' : 'transport';
      return this.failClosed(operation, undefined, category, ctx);
    }

    if (!isTransportResponse(response)) {
      return this.failClosed(operation, undefined, 'parse', ctx);
    }
    if (response.category !== undefined) {
      return this.failClosed(operation, response.status, categoryFor(response.status, response.category), ctx);
    }
    if (response.status < 200 || response.status > 299) {
      return this.failClosed(operation, response.status, categoryFor(response.status), ctx);
    }

    const status = parseFixtureAvailability(response.body);
    if (!status) {
      return this.failClosed(operation, response.status, 'ambiguous-availability', ctx);
    }
    return status === 'unknown'
      ? { status: 'unknown', detail: 'fixture-advisory-unknown' }
      : { status, detail: `fixture-advisory-${status === 'available' ? 'hit' : 'miss'}` };
  }

  private failClosed(
    operation: TorBoxReadOnlyOperation,
    status: number | undefined,
    category: TorBoxErrorCategory,
    ctx?: AdapterContext,
  ): AdapterResult {
    ctx?.log?.('torbox-readonly-client: read-only operation failed closed');
    if (this.gateErrors === 'throw') {
      throw createTorBoxGateError({ operation, status, category });
    }
    return { status: 'unknown', detail: category };
  }
}

function toTransportScopedRef(view: AdapterRefView): TransportScopedRef | null {
  if (!isSupportedRefType(view.refType)) return null;
  if (view.refValue.length === 0) return null;
  return { refType: view.refType, refValue: view.refValue };
}

function isSupportedRefType(refType: string): refType is TorBoxReadOnlySupportedRefType {
  return Object.hasOwn(TORBOX_READONLY_CLIENT_REF_OPERATION_MAP, refType);
}

function clampTimeout(timeoutMs: number | undefined): number {
  const policy = TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY.perRequestTimeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) return policy.default;
  return Math.min(policy.max, Math.max(policy.min, timeoutMs));
}

function isTransportResponse(response: unknown): response is TorBoxTransportResponse {
  return isPlainObject(response) && typeof response.status === 'number' && Number.isInteger(response.status);
}

function categoryFor(status: number, category?: unknown): TorBoxErrorCategory {
  if (typeof category === 'string' && isTorBoxErrorCategory(category)) return category;
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'quota';
  return 'transport';
}

function parseFixtureAvailability(body: unknown): AdapterResult['status'] | null {
  if (!isPlainObject(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'availability') return null;
  const availability = body.availability;
  return availability === 'available' || availability === 'unavailable' || availability === 'unknown'
    ? availability
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
