import { ConfigError, resolveVar, type Env } from '../../config/env.js';
import type { ProviderAdapter } from './adapter.js';
import { FakeProviderAdapter } from './fake-adapter.js';
import { TorBoxProviderAdapter } from './torbox-provider-adapter.js';
import type { TorBoxTransport } from './torbox-real-client-gate.js';

/**
 * Provider adapter selection (mirrors the custodian factory pattern).
 *
 * `ADAPTER_MODE`: `fake` (the local reference harness) | `torbox-readonly` (requires explicit
 * injected transport config) | `none` (no adapter configured; the default when unset). Adapters are
 * OPTIONAL - the catalog core works with none. Unknown modes FAIL CLOSED (a `ConfigError`); an
 * adapter is never silently defaulted to something unexpected. The factory never constructs live
 * transport or reads provider credentials.
 */
export type AdapterMode = 'fake' | 'torbox-readonly' | 'none';
export type AdapterConfig =
  | { mode: 'none' }
  | { mode: 'fake'; available?: ReadonlySet<string> }
  | {
      mode: 'torbox-readonly';
      transport: TorBoxTransport;
      timeoutMs?: number;
      gateErrors?: 'return-unknown' | 'throw';
    };

const SUPPORTED_MODES: readonly AdapterMode[] = ['fake', 'torbox-readonly', 'none'];

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
  if (mode === 'fake') return { mode: 'fake' };
  if (mode === 'torbox-readonly') {
    throw new ConfigError(['ADAPTER_MODE=torbox-readonly requires explicit injected transport configuration']);
  }
  return { mode: 'none' };
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
    case 'torbox-readonly':
      return new TorBoxProviderAdapter(config);
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
