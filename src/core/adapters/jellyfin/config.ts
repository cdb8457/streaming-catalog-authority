import { resolveVar, ConfigError, type Env } from '../../../config/env.js';
import type { SecretStore } from '../../secrets/secret-store.js';

/**
 * Phase 10 — Jellyfin config: parser / redaction / factory SCAFFOLDING ONLY.
 *
 * This module parses and validates `JELLYFIN_*` and provides secret redaction. It constructs NOTHING
 * capable of network I/O — no client, no connection. The real HTTP client is Phase 11. Errors
 * reference variable NAMES only and never include the api key value (redaction-safe, like Stage 3.1).
 */
export interface JellyfinConfig {
  readonly baseUrl: string;
  readonly apiKey: string;   // SECRET — register via registerJellyfinSecret; never log or ledger it
  readonly userId?: string;
}

/**
 * Parse + validate `JELLYFIN_*`. Returns `null` when UNCONFIGURED (both base url and api key absent).
 * Throws {@link ConfigError} on partial config, an unreadable `*_FILE`, or a malformed base URL.
 */
export function loadJellyfinConfig(env: Env = process.env): JellyfinConfig | null {
  const base = resolveVar(env, 'JELLYFIN_BASE_URL');
  const key = resolveVar(env, 'JELLYFIN_API_KEY');
  const user = resolveVar(env, 'JELLYFIN_USER_ID');
  const problems: string[] = [];
  for (const v of [base, key, user]) if (v.problem) problems.push(v.problem);

  const hasBase = base.value !== undefined && base.value.length > 0;
  const hasKey = key.value !== undefined && key.value.length > 0;
  if (problems.length === 0 && !hasBase && !hasKey) return null; // unconfigured — Jellyfin is optional

  if (!hasBase) problems.push('JELLYFIN_BASE_URL is required when Jellyfin is configured');
  if (!hasKey) problems.push('JELLYFIN_API_KEY (or JELLYFIN_API_KEY_FILE) is required when Jellyfin is configured');
  if (hasBase) {
    try {
      const u = new URL(base.value!);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') problems.push('JELLYFIN_BASE_URL must be an http(s) URL');
    } catch { problems.push('JELLYFIN_BASE_URL is not a valid URL'); }
  }
  if (problems.length > 0) throw new ConfigError(problems); // never contains the api key value

  const cfg: JellyfinConfig = user.value
    ? { baseUrl: base.value!, apiKey: key.value!, userId: user.value }
    : { baseUrl: base.value!, apiKey: key.value! };
  return cfg;
}

/** Register the api key (a secret) with a SecretStore so it is redacted from logs while in use. */
export function registerJellyfinSecret(config: JellyfinConfig, secrets: SecretStore): void {
  if (config.apiKey.length > 0) secrets.set('jellyfin-api-key', config.apiKey);
}

/** A NON-secret, redaction-safe summary for diagnostics — NEVER includes the api key. */
export function describeJellyfinConfig(config: JellyfinConfig): string {
  return `jellyfin base=${config.baseUrl}${config.userId ? ` user=${config.userId}` : ''} (api key configured)`;
}
