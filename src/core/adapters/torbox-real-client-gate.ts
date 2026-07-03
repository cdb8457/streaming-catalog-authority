/**
 * Phase 33 - TorBox real-client gate design.
 *
 * Static contracts only: no SDK import, no transport implementation, no env reads, and no live
 * client construction. Real TorBox enablement remains a separately authorized future phase.
 */

export type TorBoxReadOnlyOperation =
  | 'torrent-cache-check'
  | 'webdl-cache-check'
  | 'usenet-cache-check'
  | 'status-check'
  | 'hoster-list';

export type TorBoxFutureGatedOperation =
  | 'create-download'
  | 'request-download-link'
  | 'request-permalink'
  | 'user-list'
  | 'user-data'
  | 'control-item'
  | 'delete-item'
  | 'export-provider-data'
  | 'cdn-url';

export type TorBoxOperation = TorBoxReadOnlyOperation | TorBoxFutureGatedOperation;

export type TorBoxErrorCategory =
  | 'real-client-disabled'
  | 'forbidden-operation'
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'transport'
  | 'parse'
  | 'ambiguous-availability';

export type TorBoxGateOperation = TorBoxOperation | 'client-construction' | 'invalid-operation';
export type TorBoxGateErrorCategory = TorBoxErrorCategory | 'invalid-error-category';

export interface TorBoxTransportRequest {
  readonly operation: TorBoxReadOnlyOperation;
  readonly method: 'GET';
  readonly routeId: string;
  readonly scopedRef?: {
    readonly refType: 'infohash' | 'hash-digest' | 'link-derived-digest' | 'nzb-derived-digest';
    readonly refValue: string;
  };
  readonly timeoutMs: number;
}

export interface TorBoxTransportResponse {
  readonly status: number;
  readonly category?: TorBoxErrorCategory;
  readonly body: unknown;
}

export interface TorBoxTransport {
  request(request: TorBoxTransportRequest): Promise<TorBoxTransportResponse>;
}

export interface TorBoxClientGateConfig {
  readonly enableRealClient?: boolean;
  readonly credentialRef?: string;
  readonly transport?: TorBoxTransport;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

export interface DisabledTorBoxRealClientPlan {
  readonly phase: 33;
  readonly enabled: false;
  readonly reason: 'future-phase-required';
  readonly allowedOperations: readonly TorBoxReadOnlyOperation[];
  readonly futureGatedOperations: readonly TorBoxFutureGatedOperation[];
  readonly transport: 'injected-contract-only';
  readonly sdk: 'not-installed-not-imported';
  readonly liveSmoke: 'operator-run-outside-ci';
  readonly notes: readonly string[];
}

export const TORBOX_REAL_CLIENT_ALLOWED_OPERATIONS = [
  'torrent-cache-check',
  'webdl-cache-check',
  'usenet-cache-check',
  'status-check',
  'hoster-list',
] as const satisfies readonly TorBoxReadOnlyOperation[];

export const TORBOX_REAL_CLIENT_FUTURE_GATED_OPERATIONS = [
  'create-download',
  'request-download-link',
  'request-permalink',
  'user-list',
  'user-data',
  'control-item',
  'delete-item',
  'export-provider-data',
  'cdn-url',
] as const satisfies readonly TorBoxFutureGatedOperation[];

export const TORBOX_REAL_CLIENT_TIMEOUT_BACKOFF_POLICY = {
  perRequestTimeoutMs: {
    default: 5_000,
    min: 1_000,
    max: 10_000,
  },
  retry: {
    maxAttempts: {
      default: 2,
      min: 1,
      max: 3,
    },
    baseDelayMs: 250,
    maxDelayMs: 2_000,
    jitter: 'required',
    retryableCategories: ['quota', 'timeout', 'transport'] as const,
    mutatingRetry: 'forbidden-without-durable-outbox',
  },
} as const;

export class TorBoxRealClientGateError extends Error {
  readonly operation: TorBoxGateOperation;
  readonly status?: number;
  readonly category: TorBoxGateErrorCategory;

  constructor(input: {
    readonly operation: TorBoxOperation | 'client-construction';
    readonly status?: number;
    readonly category: TorBoxErrorCategory;
  }) {
    const category = sanitizeTorBoxErrorCategory(input.category);
    super(`TorBox real client gate closed: ${category}`);
    this.name = 'TorBoxRealClientGateError';
    this.operation = sanitizeTorBoxGateOperation(input.operation);
    this.status = sanitizeTorBoxStatus(input.status);
    this.category = category;
  }

  toJSON(): { operation: TorBoxGateOperation; status?: number; category: TorBoxGateErrorCategory } {
    return this.status === undefined
      ? { operation: this.operation, category: this.category }
      : { operation: this.operation, status: this.status, category: this.category };
  }
}

export function isTorBoxReadOnlyOperation(operation: string): operation is TorBoxReadOnlyOperation {
  return (TORBOX_REAL_CLIENT_ALLOWED_OPERATIONS as readonly string[]).includes(operation);
}

export function isTorBoxFutureGatedOperation(operation: string): operation is TorBoxFutureGatedOperation {
  return (TORBOX_REAL_CLIENT_FUTURE_GATED_OPERATIONS as readonly string[]).includes(operation);
}

export function isTorBoxErrorCategory(category: string): category is TorBoxErrorCategory {
  return ([
    'real-client-disabled',
    'forbidden-operation',
    'auth',
    'quota',
    'timeout',
    'transport',
    'parse',
    'ambiguous-availability',
  ] as readonly string[]).includes(category);
}

function sanitizeTorBoxGateOperation(operation: unknown): TorBoxGateOperation {
  if (operation === 'client-construction') return operation;
  return typeof operation === 'string' && (isTorBoxReadOnlyOperation(operation) || isTorBoxFutureGatedOperation(operation))
    ? operation
    : 'invalid-operation';
}

function sanitizeTorBoxErrorCategory(category: unknown): TorBoxGateErrorCategory {
  return typeof category === 'string' && isTorBoxErrorCategory(category) ? category : 'invalid-error-category';
}

function sanitizeTorBoxStatus(status: unknown): number | undefined {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

export function createTorBoxGateError(input: {
  readonly operation: TorBoxOperation | 'client-construction';
  readonly status?: number;
  readonly category: TorBoxErrorCategory;
}): TorBoxRealClientGateError {
  return new TorBoxRealClientGateError(input);
}

export function assertTorBoxOperationAllowed(operation: TorBoxOperation): asserts operation is TorBoxReadOnlyOperation {
  if (!isTorBoxReadOnlyOperation(operation)) {
    throw createTorBoxGateError({ operation, category: 'forbidden-operation' });
  }
}

export function createDisabledTorBoxRealClientPlan(config: TorBoxClientGateConfig = {}): DisabledTorBoxRealClientPlan {
  if (config.enableRealClient === true) {
    throw createTorBoxGateError({ operation: 'client-construction', category: 'real-client-disabled' });
  }

  return {
    phase: 33,
    enabled: false,
    reason: 'future-phase-required',
    allowedOperations: TORBOX_REAL_CLIENT_ALLOWED_OPERATIONS,
    futureGatedOperations: TORBOX_REAL_CLIENT_FUTURE_GATED_OPERATIONS,
    transport: 'injected-contract-only',
    sdk: 'not-installed-not-imported',
    liveSmoke: 'operator-run-outside-ci',
    notes: [
      'No live TorBox client is constructed in Phase 33.',
      'Injected transport is a future contract only.',
      'Authorization, endpoint mapping, and smoke validation require a separate phase.',
    ],
  };
}

export function assertTorBoxRealClientGateClosed(config: TorBoxClientGateConfig = {}): DisabledTorBoxRealClientPlan {
  return createDisabledTorBoxRealClientPlan(config);
}
