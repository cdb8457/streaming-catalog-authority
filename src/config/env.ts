import { readFileSync } from 'node:fs';

/**
 * Phase 3 Stage 3.1 — configuration & environment validation foundation.
 *
 * One typed, fail-fast loader for runtime configuration. Goals:
 *  - validate ALL problems at once (aggregate), not first-throw, so an operator sees every
 *    misconfiguration in a single message;
 *  - support `*_FILE` indirection (Docker / Unraid secrets) for any variable;
 *  - be REDACTION-SAFE: error messages reference variable NAMES only, never values or file
 *    paths, so a connection string (which embeds a password) can never leak into logs.
 *
 * Scope note (Stage 3.1): this builds the foundation and wires the existing DB variables only.
 * Custodian / KEK configuration (incl. the chosen age-encrypted-file KEK) is deferred to
 * Stage 3.2 — this module deliberately does NOT read or validate key material yet.
 */

export type Env = Record<string, string | undefined>;

export interface DbConfig {
  /** Least-privileged runtime role (DATABASE_URL). */
  databaseUrl: string;
  /** Owner/migrator role (ADMIN_DATABASE_URL); falls back to databaseUrl for single-role dev. */
  adminDatabaseUrl: string;
  /** True when adminDatabaseUrl fell back to databaseUrl (no distinct owner role configured). */
  singleRole: boolean;
}

export interface AppConfig {
  db: DbConfig;
}

/** Aggregated, redaction-safe configuration failure. `problems` lists each issue by var name. */
export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

interface Resolved {
  value?: string;
  problem?: string;
}

/**
 * Resolve one variable with optional `*_FILE` indirection.
 *  - `NAME_FILE` set -> read the (trimmed of one trailing newline) value from that file;
 *  - else `NAME` is used directly;
 *  - setting BOTH is an ambiguous conflict and reported;
 *  - empty/whitespace value is reported.
 * Problems mention only variable NAMES (never the value or the file path) — redaction-safe.
 */
export function resolveVar(env: Env, name: string): Resolved {
  const fileVar = `${name}_FILE`;
  const direct = env[name];
  const filePath = env[fileVar];

  if (direct !== undefined && filePath !== undefined) {
    return { problem: `${name} and ${fileVar} are both set (choose exactly one)` };
  }

  if (filePath !== undefined) {
    if (filePath.trim() === '') return { problem: `${fileVar} is set but empty` };
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return { problem: `${fileVar} points to a file that could not be read` };
    }
    const value = raw.replace(/\r?\n$/, ''); // strip a single trailing newline (common in secret files)
    if (value.trim() === '') return { problem: `${fileVar} file is empty` };
    return { value };
  }

  if (direct !== undefined) {
    if (direct.trim() === '') return { problem: `${name} is set but empty` };
    return { value: direct };
  }

  return {}; // absent (caller decides whether that is an error)
}

/**
 * Validate + resolve the database configuration. DATABASE_URL is required (directly or via
 * DATABASE_URL_FILE); ADMIN_DATABASE_URL is optional and falls back to DATABASE_URL for a
 * single-role dev setup. Throws {@link ConfigError} listing every problem.
 */
export function loadDbConfig(env: Env = process.env): DbConfig {
  const problems: string[] = [];

  const db = resolveVar(env, 'DATABASE_URL');
  if (db.problem) problems.push(db.problem);
  else if (db.value === undefined) problems.push('DATABASE_URL is required (set DATABASE_URL or DATABASE_URL_FILE)');

  const admin = resolveVar(env, 'ADMIN_DATABASE_URL');
  if (admin.problem) problems.push(admin.problem);

  if (problems.length > 0) throw new ConfigError(problems);

  const databaseUrl = db.value!;
  const adminDatabaseUrl = admin.value ?? databaseUrl;
  return { databaseUrl, adminDatabaseUrl, singleRole: admin.value === undefined };
}

/** Load and validate all runtime configuration. Throws {@link ConfigError} on any problem. */
export function loadConfig(env: Env = process.env): AppConfig {
  return { db: loadDbConfig(env) };
}

export type AppEnv = 'production' | 'development' | 'test';

/**
 * Resolve the deployment environment (Phase 4): `APP_ENV` takes precedence, falling back to
 * `NODE_ENV`, then defaulting to `development` (so dev/test are never accidentally treated as
 * production). Only an explicit `production`/`prod` is treated as production; `test` as test;
 * everything else as development. Reads from the SAME `env` it is given (deterministic in tests).
 */
export function resolveAppEnv(env: Env = process.env): AppEnv {
  const raw = (env.APP_ENV ?? env.NODE_ENV ?? 'development').trim().toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'production';
  if (raw === 'test') return 'test';
  return 'development';
}
