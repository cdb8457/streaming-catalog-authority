import { Client } from 'pg';
import { loadDbConfig } from '../config/env.js';
import { MIGRATION_VERSION } from '../db/schema-version.js';

/**
 * Phase 6 Stage 6.3 — print the DB migration version vs what this build expects.
 *
 *   tsx src/ops/version-cli.ts        (or: npm run ops:version)
 *
 * Exit 0 if they match, 1 on mismatch (run ops:migrate). Read-only; prints no secrets.
 */
async function main(): Promise<number> {
  const { adminDatabaseUrl } = loadDbConfig();
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    let db: number | undefined;
    try { db = (await admin.query('SELECT version FROM schema_meta WHERE id = 1')).rows[0]?.version as number | undefined; }
    catch { db = undefined; /* schema_meta absent -> not migrated */ }
    const match = db === MIGRATION_VERSION;
    console.log(`schema version: db=${db ?? 'unknown'} expected=${MIGRATION_VERSION} — ${match ? 'OK' : 'MISMATCH (run ops:migrate)'}`);
    return match ? 0 : 1;
  } finally {
    await admin.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('ops:version failed:', (err as Error).message); process.exit(1); });
