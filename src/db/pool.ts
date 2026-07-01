import { readFileSync } from 'node:fs';
import { Client, Pool } from 'pg';
import { loadDbConfig } from '../config/env.js';
import { MIGRATION_VERSION } from './schema-version.js';

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

/** Applies the schema and role grants as the owner. Idempotent. */
export async function migrate(): Promise<void> {
  const sql = readFileSync(new URL('./migrations.sql', import.meta.url), 'utf8');
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query(sql);
    await client.query('SELECT set_schema_version($1)', [MIGRATION_VERSION]); // record the applied version
  } finally {
    await client.end();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
