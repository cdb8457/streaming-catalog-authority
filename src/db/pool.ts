import { readFileSync } from 'node:fs';
import { Client, Pool } from 'pg';
import { loadDbConfig } from '../config/env.js';
import { MIGRATION_ADVISORY_LOCK_KEY, MIGRATION_VERSION } from './schema-version.js';

let pool: Pool | undefined;

/**
 * Runtime connection pool, using the least-privileged `app` role via
 * DATABASE_URL. The core is environment-agnostic: point it at any PostgreSQL 16.
 * Config is resolved + validated lazily (so test harnesses can set env after import).
 */
export function getPool(): Pool {
  if (!pool) {
    const { databaseUrl } = loadDbConfig();
    pool = new Pool({ connectionString: databaseUrl, max: 60 });
  }
  return pool;
}

/**
 * Connection string for the OWNER/migrator role. Falls back to DATABASE_URL for
 * single-role setups, but production should keep these distinct so the runtime
 * role cannot alter schema, disable triggers, or delete events.
 */
export function adminUrl(): string {
  return loadDbConfig().adminDatabaseUrl;
}

/**
 * A migration attempt that could not take the exclusive lock in time.
 *
 * Distinguished from every other failure on purpose. "Someone else is migrating" is a WAIT, not a fault, and
 * a startup that reports it as a schema error sends an operator looking for a broken database when the real
 * answer is that the other container will finish in a moment. The code is stable so a caller can branch on it.
 */
export class MigrationLockUnavailableError extends Error {
  readonly code = 'MIGRATION_LOCK_UNAVAILABLE';

  constructor(message = 'another migration is already running against this database and did not finish in time') {
    super(message);
    this.name = 'MigrationLockUnavailableError';
  }
}

/** A migration that ran but did not leave the database at the version this build requires. */
export class MigrationVerificationError extends Error {
  readonly code = 'MIGRATION_VERIFICATION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'MigrationVerificationError';
  }
}

export interface MigrateOptions {
  /** How long to keep trying for the exclusive lock before failing closed. */
  readonly lockTimeoutMs?: number;
  /** Poll interval while waiting. Exposed so tests do not have to sleep for real. */
  readonly lockPollIntervalMs?: number;
}

export const MIGRATION_LOCK_TIMEOUT_MS = 120_000;
export const MIGRATION_LOCK_POLL_INTERVAL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Take the exclusive migration lock, or fail closed.
 *
 * `pg_try_advisory_lock` rather than `pg_advisory_lock`: the blocking form waits forever, and a container
 * that hangs forever on startup is indistinguishable from one that is broken. Polling with a deadline turns
 * "the other migrator is wedged" into a bounded, diagnosable exit instead of a stuck `docker compose up`.
 */
async function acquireMigrationLock(client: Client, options: MigrateOptions): Promise<void> {
  const timeoutMs = options.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS;
  const pollMs = options.lockPollIntervalMs ?? MIGRATION_LOCK_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const granted = (await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_ADVISORY_LOCK_KEY])).rows[0]?.locked === true;
    if (granted) return;
    if (Date.now() >= deadline) throw new MigrationLockUnavailableError();
    await sleep(pollMs);
  }
}

/** The tables a completed migration must have left behind. Names only — no contents are ever read here. */
export const MIGRATED_TABLES: readonly string[] = [
  'events', 'items', 'provider_refs', 'item_key_control', 'crypto_config', 'aborted_operations',
  'publish_ledger', 'schema_meta', 'import_history', 'collection_control_history',
];

/**
 * Read back what is actually deployed, using the same owner connection that just wrote it.
 *
 * A migration that "succeeded" is a claim; the recorded version and the presence of the objects this build
 * needs are the evidence. Verifying separately is what makes the caller able to say `MIGRATED` honestly, and
 * is why a partially-applied schema cannot be reported as a completed one.
 */
async function verifyMigration(client: Client): Promise<void> {
  const version = (await client.query<{ version: number | null }>(
    'SELECT version FROM public.schema_meta WHERE id = 1')).rows[0]?.version ?? null;
  if (version !== MIGRATION_VERSION) {
    throw new MigrationVerificationError(
      `the database records schema version ${version === null ? 'none' : version} after migrating, but this build requires ${MIGRATION_VERSION}`);
  }
  const missing = (await client.query<{ name: string }>(
    `SELECT n AS name FROM unnest($1::text[]) n WHERE to_regclass('public.' || n) IS NULL`,
    [MIGRATED_TABLES])).rows.map((row) => row.name);
  if (missing.length > 0) {
    throw new MigrationVerificationError(`the migration did not create: ${missing.join(', ')}`);
  }
}

/**
 * Applies the schema and role grants as the owner against an explicit connection. Idempotent, serialised,
 * and verified.
 *
 * IDEMPOTENT: every statement in migrations.sql is `IF NOT EXISTS`, `OR REPLACE` or a privilege statement, so
 * running it against an already-migrated database is a no-op that ends at the same version.
 *
 * SERIALISED: the whole thing runs under a session-level advisory lock, so two containers racing at first
 * boot produce one migration and one no-op rather than two half-migrations.
 *
 * VERIFIED: the recorded version and the expected relations are read back before this resolves. A caller that
 * gets a resolved promise has evidence, not an assumption.
 */
export async function migrateWith(connectionString: string, options: MigrateOptions = {}): Promise<void> {
  const sql = readFileSync(new URL('./migrations.sql', import.meta.url), 'utf8');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await acquireMigrationLock(client, options);
    try {
      await client.query(sql);
      await client.query('SELECT set_schema_version($1)', [MIGRATION_VERSION]); // record the applied version
      await verifyMigration(client);
    } finally {
      // Best-effort: the lock is session-scoped and dies with the connection below regardless, but releasing
      // it explicitly means a pooled or reused connection cannot hold it past its usefulness.
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

/** Applies the schema and role grants as the production owner (ADMIN_DATABASE_URL). Idempotent. */
export async function migrate(options: MigrateOptions = {}): Promise<void> {
  await migrateWith(adminUrl(), options);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
