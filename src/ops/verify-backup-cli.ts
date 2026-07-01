import { readFileSync } from 'node:fs';
import { BackupPolicy, type BackupArtifact } from '../core/backup/backup-policy.js';

/**
 * Phase 6 Stage 6.3 — OFFLINE backup verification (no DB, no secrets).
 *
 *   tsx src/ops/verify-backup-cli.ts <artifact.json>   (or: npm run ops:verify-backup -- <file>)
 *
 * Fast structural sanity check of a backup artifact. Exit 0 if sane, 1 on any problem, 2 on usage
 * error. The FULL replay-and-compare derivability proof needs a database — run
 * `ops:rehearse-restore` for that.
 */
function main(): number {
  const file = process.argv[2];
  if (!file || file.startsWith('-')) {
    console.error('usage: ops:verify-backup <artifact.json>');
    return 2;
  }
  let artifact: BackupArtifact;
  try {
    artifact = JSON.parse(readFileSync(file, 'utf8')) as BackupArtifact;
  } catch (err) {
    console.error(`verify-backup: could not read/parse the artifact: ${(err as Error).message}`);
    return 1;
  }
  const { ok, problems } = BackupPolicy.verifyStructure(artifact);
  if (ok) {
    console.log(`verify-backup: OK (${artifact.tables.length} tables) — offline structural check passed. Run ops:rehearse-restore for a full DB-backed proof.`);
    return 0;
  }
  console.error(`verify-backup: FAILED\n  - ${problems.join('\n  - ')}`);
  return 1;
}

process.exit(main());
