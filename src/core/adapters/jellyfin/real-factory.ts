import { resolveVar, ConfigError, type Env } from '../../../config/env.js';
import type { FetchLike } from './transport.js';
import { loadJellyfinConfig } from './config.js';
import { JellyfinHttpClient } from './http-client.js';
import { createJellyfinAdapters } from './factory.js';
import type { JellyfinPublisher } from './publisher.js';
import type { JellyfinRevoker } from './revoker.js';

/** Raised when real Jellyfin networking is attempted without the explicit default-off enable gate. */
export class JellyfinNetworkDisabledError extends Error {
  constructor(message: string) { super(message); this.name = 'JellyfinNetworkDisabledError'; }
}

/** True ONLY when `JELLYFIN_ENABLE_NETWORK` is exactly `"true"`. Fail-closed default: OFF. */
export function isJellyfinNetworkEnabled(env: Env = process.env): boolean {
  return resolveVar(env, 'JELLYFIN_ENABLE_NETWORK').value === 'true';
}

/**
 * True ONLY when `JELLYFIN_ALLOW_LIVE_PUBLISH` is exactly `"true"`. Fail-closed default: OFF. This is a
 * SEPARATE switch from network-enable: it gates the ambiguous, non-idempotent `createCollection`, so
 * real live publishing stays off until an operator has validated create/delete via `smoke:jellyfin`.
 */
export function isJellyfinLivePublishAllowed(env: Env = process.env): boolean {
  return resolveVar(env, 'JELLYFIN_ALLOW_LIVE_PUBLISH').value === 'true';
}

/**
 * Construct the REAL Jellyfin client over a CALLER-SUPPLIED transport. Two independent conditions must
 * hold or it FAILS CLOSED:
 *   1. `JELLYFIN_ENABLE_NETWORK=true` (default off) — else {@link JellyfinNetworkDisabledError};
 *   2. `JELLYFIN_*` is fully configured — else {@link ConfigError}.
 *
 * `fetchImpl` is a REQUIRED parameter — there is NO implicit platform-fetch default here, so this
 * module cannot touch the network on its own; only an operator entrypoint that BOTH enabled the gate
 * AND injected a real transport can. (Live publishing ALSO requires `PUBLISH_EXTERNAL_IDENTITY=allow`.)
 */
export function createRealJellyfinClient(fetchImpl: FetchLike, env: Env = process.env): JellyfinHttpClient {
  if (!isJellyfinNetworkEnabled(env)) {
    throw new JellyfinNetworkDisabledError('Jellyfin network is disabled: set JELLYFIN_ENABLE_NETWORK=true to enable real HTTP (default off)');
  }
  const config = loadJellyfinConfig(env);
  if (config === null) {
    throw new ConfigError(['JELLYFIN_BASE_URL and JELLYFIN_API_KEY (or _FILE) are required to enable Jellyfin networking']);
  }
  return new JellyfinHttpClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: fetchImpl,
    allowLivePublish: isJellyfinLivePublishAllowed(env), // default off — createCollection fails closed
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });
}

/** Gated construction of the real publisher + revoker over a caller-supplied transport. */
export function createRealJellyfinAdapters(fetchImpl: FetchLike, env: Env = process.env): { publisher: JellyfinPublisher; revoker: JellyfinRevoker } {
  return createJellyfinAdapters(createRealJellyfinClient(fetchImpl, env));
}
