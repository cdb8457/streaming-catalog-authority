import { readFileSync } from 'node:fs';
import { loadDbConfig, resolveVar } from '../config/env.js';
import { loadCustodianConfig, createCustodian } from '../core/crypto/custodian-factory.js';
import { runRehearsal, RehearsalRefused } from './rehearse.js';
import type { BackupArtifact } from '../core/backup/backup-policy.js';

/**
 * Phase 6 Stage 6.4 — restore rehearsal CLI.
 *
 *   REHEARSAL_ADMIN_DATABASE_URL=... tsx src/ops/rehearse-cli.ts <artifact.json>
 *   (or: npm run ops:rehearse-restore -- <file>)
 *
 * Restores the artifact into the SEPARATE throwaway DB named by REHEARSAL_ADMIN_DATABASE_URL and
 * proves it reads. Never touches production; HARD-refuses (exit 2) if the rehearsal DB resolves to
 * a production DB. Exit 0 on a clean rehearsal, 1 on failure. Prints no secret values.
 */
async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file || file.startsWith('-')) { console.error('usage: ops:rehearse-restore <artifact.json>'); return 2; }

  const db = loadDbConfig();
  const rehearsal = resolveVar(process.env, 'REHEARSAL_ADMIN_DATABASE_URL');
  if (rehearsal.problem || rehearsal.value === undefined) {
    console.error('REHEARSAL_ADMIN_DATABASE_URL is required — a SEPARATE throwaway database (never production)');
    return 2;
  }
  const custodianConfig = loadCustodianConfig();
  const custodian = createCustodian(custodianConfig);
  const artifact = JSON.parse(readFileSync(file, 'utf8')) as BackupArtifact;

  const report = await runRehearsal({
    artifact,
    rehearsalAdminUrl: rehearsal.value,
    productionUrls: [db.adminDatabaseUrl, db.databaseUrl],
    completionSecret: custodianConfig.completionSecret,
    custodian,
  });
  for (const s of report.steps) console.log(`  ${s.ok ? 'OK  ' : 'FAIL'} ${s.step}: ${s.detail}`);
  console.log(report.ok ? '\nrehearse-restore: OK — the backup restores + reads in an isolated database.' : '\nrehearse-restore: FAILED');
  return report.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof RehearsalRefused) { console.error(err.message); process.exit(2); }
    console.error('rehearse-restore failed:', (err as Error).message);
    process.exit(1);
  });
