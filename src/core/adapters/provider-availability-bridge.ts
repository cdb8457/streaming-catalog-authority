import type { AdapterContext, AdapterRefView, AdapterStatus, ProviderAdapter } from './adapter.js';
import {
  decideProviderAvailability,
  type ProviderAvailabilityPolicyDecision,
  type ProviderAvailabilityPolicyInput,
} from './provider-availability-policy.js';

/**
 * Phase 56 - provider availability bridge.
 *
 * Runs one scoped adapter lookup and immediately classifies it through the Phase 55 policy. The
 * returned report is intentionally sanitized: no provider locator, detail, raw ref, item identity,
 * provider payload, URL, or credential value is echoed.
 */

export interface ProviderAvailabilityBridgeOptions {
  readonly observedAtMs?: number;
  readonly nowMs?: number;
  readonly maxAgeMs?: number;
}

export interface ProviderAvailabilityBridgeReport {
  readonly adapterStatus: AdapterStatus;
  readonly decision: ProviderAvailabilityPolicyDecision;
  readonly advisoryOnly: true;
  readonly persisted: false;
  readonly redactionSafe: true;
  readonly echoesAdapterLocator: false;
  readonly echoesAdapterDetail: false;
}

export async function resolveProviderAvailability(
  adapter: ProviderAdapter,
  view: AdapterRefView,
  ctx?: AdapterContext,
  options: ProviderAvailabilityBridgeOptions = {},
): Promise<ProviderAvailabilityBridgeReport> {
  const result = await adapter.resolveRef(view, ctx);
  const policyInput: ProviderAvailabilityPolicyInput = {
    result,
    ...(options.observedAtMs !== undefined ? { observedAtMs: options.observedAtMs } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
  };
  return {
    adapterStatus: sanitizeAdapterStatus(result.status),
    decision: decideProviderAvailability(policyInput),
    advisoryOnly: true,
    persisted: false,
    redactionSafe: true,
    echoesAdapterLocator: false,
    echoesAdapterDetail: false,
  };
}

function sanitizeAdapterStatus(status: unknown): AdapterStatus {
  return status === 'available' || status === 'unavailable' || status === 'unknown'
    ? status
    : 'unknown';
}
