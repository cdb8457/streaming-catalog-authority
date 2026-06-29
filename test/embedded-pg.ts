import { rmSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 5433;
const DATA_DIR = path.join(process.cwd(), '.pgdata');

/**
 * Boots a real, throwaway PostgreSQL 16 for the test run and sets:
 *   - ADMIN_DATABASE_URL -> superuser (owner/migrator)
 *   - DATABASE_URL       -> least-privileged `app` role (created by migrate())
 * No Docker, no system install. Semantics (advisory locks, sequences, triggers)
 * are genuine — the concurrency and append-only proofs depend on that.
 *
 * Only called when DATABASE_URL is not already set, so an external server can be
 * used instead by exporting ADMIN_DATABASE_URL + DATABASE_URL.
 */
export async function startEmbedded(): Promise<EmbeddedPostgres> {
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

  process.env.ADMIN_DATABASE_URL = `postgresql://postgres:postgres@localhost:${PORT}/catalog`;
  process.env.DATABASE_URL = `postgresql://app:app@localhost:${PORT}/catalog`;
  return pg;
}
