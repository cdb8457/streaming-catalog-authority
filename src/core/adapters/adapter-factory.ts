import { ConfigError, resolveVar, type Env } from '../../config/env.js';
import type { ProviderAdapter } from './adapter.js';
import { FakeProviderAdapter } from './fake-adapter.js';

/**
 * Phase 7 — provider adapter selection (mirrors the custodian factory pattern).
 *
 * `ADAPTER_MODE`: `fake` (the local reference harness) | `none` (no adapter configured; the
 * default when unset). Adapters are OPTIONAL — the catalog core works with none. Unknown modes
 * FAIL CLOSED (a `ConfigError`); an adapter is never silently defaulted to something unexpected.
 * No real providers, no network — Phase 7 ships only the local fake.
 */
export type AdapterMode = 'fake' | 'none';
export type AdapterConfig = { mode: 'none' } | { mode: 'fake'; available?: ReadonlySet<string> };

const SUPPORTED_MODES: readonly AdapterMode[] = ['fake', 'none'];

/** Parse + validate `ADAPTER_MODE` (default `none`). Unknown values throw {@link ConfigError}. */
export function loadAdapterConfig(env: Env = process.env): AdapterConfig {
  const problems: string[] = [];
  const modeVar = resolveVar(env, 'ADAPTER_MODE');
  if (modeVar.problem) problems.push(modeVar.problem);
  const mode = modeVar.value ?? 'none'; // unset -> no adapter configured
  if (!modeVar.problem && !SUPPORTED_MODES.includes(mode as AdapterMode)) {
    problems.push(`ADAPTER_MODE must be one of: ${SUPPORTED_MODES.join(', ')} (got "${mode}")`);
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return mode === 'fake' ? { mode: 'fake' } : { mode: 'none' };
}

/**
 * Construct a {@link ProviderAdapter} (or null for `none`). Unknown/unsupported modes FAIL CLOSED
 * with a {@link ConfigError}.
 */
export function createAdapter(config: AdapterConfig): ProviderAdapter | null {
  switch (config.mode) {
    case 'none':
      return null;
    case 'fake':
      return new FakeProviderAdapter(config.available);
    default: {
      const unknown = config as { mode?: string };
      throw new ConfigError([`unsupported adapter mode "${String(unknown.mode)}" (fail-closed; no adapter)`]);
    }
  }
}

/** Convenience: load from env and construct in one step. */
export function adapterFromEnv(env: Env = process.env): ProviderAdapter | null {
  return createAdapter(loadAdapterConfig(env));
}
