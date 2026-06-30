import { migrate } from '../db/pool.js';

/**
 * Phase 3 Stage 3.4 — deploy-time migration entrypoint (one-shot CLI).
 *
 *   tsx src/ops/migrate-cli.ts        (or: npm run ops:migrate)
 *
 * Applies the schema + role grants as the OWNER (ADMIN_DATABASE_URL), idempotently. Intended to
 * run once per deploy via `docker compose run --rm ops ops:migrate`. Prints status only —
 * never echoes connection strings or secrets.
 */
migrate()
  .then(() => {
    console.log('migration complete');
  })
  .catch((err: unknown) => {
    console.error('migration failed:', (err as Error).message); // message only, no env/secret dump
    process.exit(1);
  });
