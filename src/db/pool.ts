import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

let pool: Pool | undefined;

/**
 * Returns the process-wide connection pool. Connection string comes from
 * DATABASE_URL so the core is environment-agnostic: point it at any real
 * PostgreSQL 16 server in production, or at the embedded server in tests.
 */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    // max is sized so the concurrency suite can hold many advisory-locked
    // transactions at once without queueing masking the lock behaviour.
    pool = new Pool({ connectionString, max: 60 });
  }
  return pool;
}

/** Applies the schema. Idempotent (CREATE ... IF NOT EXISTS / OR REPLACE). */
export async function migrate(): Promise<void> {
  const sql = readFileSync(new URL('./migrations.sql', import.meta.url), 'utf8');
  await getPool().query(sql);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
