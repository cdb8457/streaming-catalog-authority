import { Client } from 'pg';
import { loadDbConfig, resolveAppEnv } from '../config/env.js';
import { loadCustodianConfig, createCustodian } from '../core/crypto/custodian-factory.js';
import { migrate, getPool, closePool } from '../db/pool.js';
import { runDoctor, formatDoctorReport } from './doctor.js';

/**
 * Phase 5 Stage 5.2 — first-run bootstrap ("ops init").
 *
 *   tsx src/ops/init-cli.ts        (or: npm run ops:init)
 *
 * The ONLY mutations are migration + secret provisioning: it (1) applies the schema/grants
 * idempotently (owner), (2) provisions `crypto_config.completion_secret` to the configured
 * COMPLETION_SECRET via the owner-only `set_completion_secret()` (so the DB and custodian agree —
 * required for attested shred completion), then (3) runs the read-only `ops:doctor` self-check and
 * exits non-zero if anything still fails. Prints no secret values.
 */
async function main(): Promise<number> {
  const db = loadDbConfig();
  const custodianConfig = loadCustodianConfig(); // fail-closed on bad/insecure config

  console.log('ops:init — applying migrations (owner) ...');
  await migrate();

  const admin = new Client({ connectionString: db.adminDatabaseUrl });
  await admin.connect();
  const pool = getPool();
  try {
    console.log('ops:init — provisioning the completion secret (owner-only) ...');
    await admin.query('SELECT set_completion_secret($1)', [custodianConfig.completionSecret]);

    const custodian = createCustodian(custodianConfig);
    const report = await runDoctor({
      admin, pool, custodian,
      completionSecret: custodianConfig.completionSecret,
      custodianMode: custodianConfig.mode,
      appEnv: resolveAppEnv(),
      keystoreDir: custodianConfig.mode === 'file' ? custodianConfig.keystoreDir : undefined,
    });
    console.log(formatDoctorReport(report));
    console.log(report.ok ? '\nops:init complete — deployment is ready.' : '\nops:init: doctor reported failures — resolve them before serving.');
    return report.ok ? 0 : 1;
  } finally {
    await admin.end();
    await closePool();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('ops:init failed:', (err as Error).message); process.exit(1); }); // message only
