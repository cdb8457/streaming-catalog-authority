import { rmSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 5433;
const DATA_DIR = path.join(process.cwd(), '.pgdata');

/**
 * Boots a real, throwaway PostgreSQL 16 server for the test run and points
 * DATABASE_URL at it. No Docker, no system install. The server semantics
 * (advisory locks, sequences, triggers) are genuine — the concurrency proofs
 * depend on that.
 */
export async function startEmbedded(): Promise<EmbeddedPostgres> {
  // Always start from a clean data dir for a deterministic fresh-DB run.
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('catalog');

  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost:${PORT}/catalog`;
  return pg;
}
