import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { loadDbConfig } from '../config/env.js';
import { loadCustodianConfig, createCustodian, requireAppHeldCompletionSecret } from '../core/crypto/custodian-factory.js';
import { runDump, runRestore, parseBackupArgs, RestoreRefused, type BackupArtifact } from './backup-ops.js';

/**
 * Phase 3 Stage 3.3 — backup/restore ops CLI (thin entrypoint over ./backup-ops).
 *
 *   tsx src/ops/backup-cli.ts dump    <out.json> [label]
 *   tsx src/ops/backup-cli.ts restore <in.json>
 *
 * Uses the owner/migrator connection (ADMIN_DATABASE_URL). `restore` additionally builds the
 * custodian from config and runs the preflight + integrity-gated restore, refusing (exit 2) on
 * any mismatch or missing input. Output never prints secret values.
 *
 * Operator note: the backup artifact is NOT encrypted by this tool — encrypt it at rest yourself
 * (storage-level, or `... | age -r ...`). The erasure guarantee comes from key-material exclusion.
 */
async function main(): Promise<void> {
  const args = parseBackupArgs(process.argv.slice(2));
  const { adminDatabaseUrl } = loadDbConfig();
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    if (args.command === 'dump') {
      const artifact = await runDump({ admin, label: args.label });
      writeFileSync(args.file, JSON.stringify(artifact));
      console.log(`dump complete -> ${args.file} (${artifact.tables.length} tables; ciphertext only, no key material). Encrypt this artifact at rest.`);
    } else {
      const custodianConfig = loadCustodianConfig();
      const custodian = createCustodian(custodianConfig);
      const artifact = JSON.parse(readFileSync(args.file, 'utf8')) as BackupArtifact;
      const { preflight } = await runRestore({ admin, custodian, completionSecret: requireAppHeldCompletionSecret(custodianConfig, 'ops:backup restore'), artifact });
      console.log(`restore complete. preflight: ${JSON.stringify(preflight.checks)}`);
    }
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  if (err instanceof RestoreRefused) {
    console.error(err.message);
    process.exit(2);
  }
  console.error('FATAL:', (err as Error).message); // message only — never dumps env/secrets
  process.exit(1);
});
