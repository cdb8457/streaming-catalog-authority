import type { AdapterResult } from './adapter.js';

/**
 * Phase 55 - provider availability policy.
 *
 * Converts advisory adapter output into fixed, redaction-safe routing decisions. This layer is
 * intentionally pure: no provider contact, no DB writes, no env reads, no identity access, and no
 * locator/detail echoing.
 */

export type ProviderAvailabilityPolicyStatus = 'available' | 'unavailable' | 'unknown' | 'stale' | 'invalid';
export type ProviderAvailabilityPolicyAction = 'candidate' | 'skip' | 'hold';

export interface ProviderAvailabilityPolicyInput {
  readonly result: AdapterResult | null | undefined;
  readonly observedAtMs?: number;
  readonly nowMs?: number;
  readonly maxAgeMs?: number;
}

export interface ProviderAvailabilityPolicyDecision {
  readonly status: ProviderAvailabilityPolicyStatus;
  readonly action: ProviderAvailabilityPolicyAction;
  readonly advisoryOnly: true;
  readonly persisted: false;
  readonly redactionSafe: true;
  readonly echoesProviderDetail: false;
  readonly reason: string;
}

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;

export function decideProviderAvailability(input: ProviderAvailabilityPolicyInput): ProviderAvailabilityPolicyDecision {
  const result = input.result;
  if (!isAdapterResult(result)) return decision('invalid', 'hold', 'invalid-adapter-result');

  const age = availabilityAge(input);
  if (age !== null && age > maxAge(input.maxAgeMs)) return decision('stale', 'hold', 'stale-advisory-result');

  switch (result.status) {
    case 'available':
      return decision('available', 'candidate', 'advisory-availability-hit');
    case 'unavailable':
      return decision('unavailable', 'skip', 'advisory-availability-miss');
    case 'unknown':
      return decision('unknown', 'hold', 'advisory-availability-unknown');
    default:
      return decision('invalid', 'hold', 'invalid-adapter-status');
  }
}

function isAdapterResult(result: unknown): result is AdapterResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const status = (result as { status?: unknown }).status;
  return status === 'available' || status === 'unavailable' || status === 'unknown';
}

function availabilityAge(input: ProviderAvailabilityPolicyInput): number | null {
  if (input.observedAtMs === undefined && input.nowMs === undefined) return null;
  if (!safeInteger(input.observedAtMs) || !safeInteger(input.nowMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, input.nowMs - input.observedAtMs);
}

function maxAge(value: number | undefined): number {
  return safeInteger(value) && value > 0 ? value : DEFAULT_MAX_AGE_MS;
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function decision(
  status: ProviderAvailabilityPolicyStatus,
  action: ProviderAvailabilityPolicyAction,
  reason: string,
): ProviderAvailabilityPolicyDecision {
  return {
    status,
    action,
    advisoryOnly: true,
    persisted: false,
    redactionSafe: true,
    echoesProviderDetail: false,
    reason,
  };
}
