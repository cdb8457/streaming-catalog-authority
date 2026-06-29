import { readFileSync } from 'node:fs';
import { Client, Pool } from 'pg';

let pool: Pool | undefined;

/**
 * Runtime connection pool, using the least-privileged `app` role via
 * DATABASE_URL. The core is environment-agnostic: point it at any PostgreSQL 16.
 */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({ connectionString, max: 60 });
  }
  return pool;
}

/**
 * Connection string for the OWNER/migrator role. Falls back to DATABASE_URL for
 * single-role setups, but production should keep these distinct so the runtime
 * role cannot alter schema, disable triggers, or delete events.
 */
export function adminUrl(): string {
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('ADMIN_DATABASE_URL / DATABASE_URL is not set');
  return url;
}

/** Applies the schema and role grants as the owner. Idempotent. */
export async function migrate(): Promise<void> {
  const sql = readFileSync(new URL('./migrations.sql', import.meta.url), 'utf8');
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query(sql);
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
