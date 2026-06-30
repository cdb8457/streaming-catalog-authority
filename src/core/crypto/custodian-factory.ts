import { ConfigError, resolveVar, resolveAppEnv, type Env } from '../../config/env.js';
import type { KeyCustodian } from './custodian.js';
import { InMemoryCustodian } from './custodian.js';
import { FileCustodian } from './file-custodian.js';

/**
 * Phase 3 Stage 3.2 — custodian selection boundary.
 *
 * A single place that turns validated configuration into a `KeyCustodian`, using the Stage 3.1
 * config patterns (`resolveVar` + aggregated `ConfigError`, `*_FILE` indirection, redaction-safe
 * errors). The rest of the system depends only on the `KeyCustodian` interface, so swapping the
 * production custodian is a config change, not a code change.
 *
 * Operator-facing config:
 *   CUSTODIAN_MODE            memory | file                         (required)
 *   COMPLETION_SECRET[_FILE]  HMAC attestation secret              (required; shared with the DB)
 *   CUSTODIAN_KEYSTORE_DIR    keystore root                        (required for mode=file)
 *   CUSTODIAN_KEK[_FILE]      base64-encoded 32-byte KEK           (required for mode=file)
 *
 * Scope (Stage 3.2): supported modes are `memory` (dev/test) and `file` (the FileCustodian
 * reference harness). The KEK is resolved here from a base64 value / file — this is the seam
 * where the planned **age-encrypted-file KEK** (Phase 3 decision) will later plug in (an
 * age-wrapped source would decrypt to the same 32 bytes). That age integration is NOT built
 * here. Unknown/unsupported modes fail closed (see {@link createCustodian}).
 *
 * Security note: `memory` and `file` are reference harnesses, not a managed KMS. The managed-KMS
 * adapter (design O4) is still an open production deployment gate; it would add another mode here.
 */

export type CustodianMode = 'memory' | 'file';

export type CustodianConfig =
  | { mode: 'memory'; completionSecret: string }
  | { mode: 'file'; completionSecret: string; keystoreDir: string; kek: Buffer };

const SUPPORTED_MODES: readonly CustodianMode[] = ['memory', 'file'];

/**
 * Parse + validate custodian configuration from the environment. Aggregates every problem into
 * one {@link ConfigError}; secret values (COMPLETION_SECRET, CUSTODIAN_KEK) never appear in error
 * messages (only variable names), matching the Stage 3.1 redaction guarantee.
 */
export function loadCustodianConfig(env: Env = process.env): CustodianConfig {
  const problems: string[] = [];

  const secret = resolveVar(env, 'COMPLETION_SECRET');
  if (secret.problem) problems.push(secret.problem);
  else if (secret.value === undefined) problems.push('COMPLETION_SECRET is required (set COMPLETION_SECRET or COMPLETION_SECRET_FILE)');

  const modeVar = resolveVar(env, 'CUSTODIAN_MODE');
  if (modeVar.problem) problems.push(modeVar.problem);
  else if (modeVar.value === undefined) problems.push(`CUSTODIAN_MODE is required (one of: ${SUPPORTED_MODES.join(', ')})`);
  else if (!SUPPORTED_MODES.includes(modeVar.value as CustodianMode)) {
    problems.push(`CUSTODIAN_MODE must be one of: ${SUPPORTED_MODES.join(', ')} (got "${modeVar.value}")`);
  }

  // Phase 4 production guard: the in-process `memory` custodian loses keys on restart and enforces
  // no trust boundary, so it is REFUSED in production. The only override is the exact, explicit
  // value CUSTODIAN_ALLOW_INSECURE_MEMORY=true (intentionally loud; not recommended).
  if (modeVar.value === 'memory' && resolveAppEnv(env) === 'production' && env.CUSTODIAN_ALLOW_INSECURE_MEMORY !== 'true') {
    problems.push('CUSTODIAN_MODE=memory is refused in production (APP_ENV/NODE_ENV=production); configure a durable custodian (e.g. mode=file), or set CUSTODIAN_ALLOW_INSECURE_MEMORY=true to override (NOT recommended)');
  }

  if (modeVar.value === 'file') {
    const dir = resolveVar(env, 'CUSTODIAN_KEYSTORE_DIR');
    if (dir.problem) problems.push(dir.problem);
    else if (dir.value === undefined) problems.push('CUSTODIAN_KEYSTORE_DIR is required for CUSTODIAN_MODE=file');

    // KEK resolution seam: a base64 32-byte key today; the planned age-encrypted-file KEK would
    // decrypt to these same 32 bytes here, without changing anything downstream.
    const kek = resolveKek(env, 'CUSTODIAN_KEK', problems);

    if (problems.length > 0) throw new ConfigError(problems);
    return { mode: 'file', completionSecret: secret.value!, keystoreDir: dir.value!, kek: kek! };
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { mode: 'memory', completionSecret: secret.value! };
}

/** Resolve a base64-encoded 32-byte KEK from `env[name]` / `env[name_FILE]`, aggregating problems. */
function resolveKek(env: Env, name: string, problems: string[]): Buffer | undefined {
  const v = resolveVar(env, name);
  if (v.problem) { problems.push(v.problem); return undefined; }
  if (v.value === undefined) { problems.push(`${name} is required (base64-encoded 32 bytes; or ${name}_FILE)`); return undefined; }
  const buf = Buffer.from(v.value, 'base64');
  if (buf.length !== 32) { problems.push(`${name} must decode (base64) to exactly 32 bytes`); return undefined; }
  return buf;
}

/** Config for an explicit KEK rotation/rewrap (Phase 4 Stage 4.2). */
export interface RewrapConfig {
  keystoreDir: string;
  /** The OLD KEK — read ONLY here (the explicit rotation path), never by normal custodian config. */
  fromKek: Buffer;
  /** The NEW/current KEK. */
  toKek: Buffer;
}

/**
 * Validate config for a KEK rewrap: `CUSTODIAN_KEYSTORE_DIR`, the new `CUSTODIAN_KEK`, and the
 * previous `CUSTODIAN_KEK_PREVIOUS` (both base64 32 bytes). Aggregated {@link ConfigError};
 * redaction-safe (KEK values never appear in errors). `CUSTODIAN_KEK_PREVIOUS` exists only for
 * this rotation path, so the previous KEK is never accepted by normal operation.
 */
export function loadRewrapConfig(env: Env = process.env): RewrapConfig {
  const problems: string[] = [];
  const dir = resolveVar(env, 'CUSTODIAN_KEYSTORE_DIR');
  if (dir.problem) problems.push(dir.problem);
  else if (dir.value === undefined) problems.push('CUSTODIAN_KEYSTORE_DIR is required for a KEK rewrap');
  const toKek = resolveKek(env, 'CUSTODIAN_KEK', problems);
  const fromKek = resolveKek(env, 'CUSTODIAN_KEK_PREVIOUS', problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return { keystoreDir: dir.value!, fromKek: fromKek!, toKek: toKek! };
}

/**
 * Construct a `KeyCustodian` from validated config. Unknown/unsupported modes FAIL CLOSED with a
 * {@link ConfigError} — a custodian is never silently defaulted (that could mask key material the
 * operator believes is protected). `clock` is injectable for deterministic tests.
 */
export function createCustodian(config: CustodianConfig, clock: () => number = () => Date.now()): KeyCustodian {
  switch (config.mode) {
    case 'memory':
      return new InMemoryCustodian(config.completionSecret, clock);
    case 'file':
      return new FileCustodian(config.keystoreDir, config.completionSecret, config.kek, clock);
    default: {
      // Exhaustiveness guard + runtime fail-closed for any future/unknown mode (e.g. a managed
      // KMS or age-file variant added to the union before its adapter exists).
      const unknown = config as { mode?: string };
      throw new ConfigError([`unsupported custodian mode "${String(unknown.mode)}" (fail-closed; no adapter)`]);
    }
  }
}

/** Convenience: load from env and construct in one step. */
export function custodianFromEnv(env: Env = process.env, clock?: () => number): KeyCustodian {
  return createCustodian(loadCustodianConfig(env), clock);
}
