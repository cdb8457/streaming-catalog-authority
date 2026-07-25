import {
  BACKUP_DIR_ENV,
  BackupInspectError,
  inspectBackupDirectory,
  renderBackupInspection,
  resolveBackupInspectRequest,
} from './backup-inspect.js';

/**
 * Phase 257 — `ops:backup-inspect`. Does the backup you have still get you back?
 *
 * OFFLINE. No database is contacted, nothing is fetched, no process is spawned. That is the point: the moment
 * you want to know whether a backup is any good is not a moment when the thing it backs up is available.
 *
 * FROM A RELEASE BUNDLE, with no Node.js toolchain on the host:
 *
 *   docker compose run --rm --no-deps -v "$PWD/backup:/backup:ro" \
 *     -e CATALOG_AUTHORITY_BACKUP_DIR=/backup app ops:backup-inspect
 *
 * `--no-deps` is load-bearing. Without it Compose starts PostgreSQL and the migration before running this,
 * which would make a check whose whole claim is "it needs no database" quietly need one.
 *
 * HOW TO NAME THE DIRECTORY. `CATALOG_AUTHORITY_BACKUP_DIR` is the reliable channel — it cannot be reordered,
 * renamed or eaten between the caller and this process. `--dir <directory>` works when invoked directly.
 * There is NO default: a run that cannot resolve a directory inspects nothing and says so, rather than
 * reporting on somewhere nobody asked about.
 *
 * EXIT CODES. 0 only for a complete backup whose schema version is established and not ahead of this build.
 * Everything else is non-zero, including every kind of "I could not tell" — a check that cannot answer must
 * never produce the same verdict as one that answered yes.
 */

const HELP = [
  'usage: ops:backup-inspect [--json]',
  '',
  `  ${BACKUP_DIR_ENV}=<directory>   the backup directory to inspect (the reliable channel)`,
  '  --dir <directory>                        the same, for direct invocation',
  '  --json                                   machine-readable output',
  '',
  'Reads a backup directory offline and reports which components are present and which schema',
  'version a plain-format dump holds. Contacts no database, fetches nothing, spawns nothing, and',
  'opens no secret file. Restores nothing and changes nothing.',
  '',
  'Exit codes: 0 complete and usable, 1 incomplete or indeterminate or ahead of this build,',
  '2 the arguments could not be resolved, 3 the directory could not be read.',
].join('\n');

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) { console.log(HELP); return 0; }

  const request = resolveBackupInspectRequest(argv.filter((arg) => arg !== '--help'), process.env);
  if (!request.ok) {
    console.error(`backup inspect: ${request.code}`);
    console.error(`  ${request.message}`);
    return 2;
  }

  let inspection: ReturnType<typeof inspectBackupDirectory>;
  try {
    inspection = inspectBackupDirectory(request.dir);
  } catch (err) {
    // The rejected path is not echoed: it is operator input, and this stack does not reflect that anywhere.
    console.error('backup inspect: BACKUP_INSPECT_UNREADABLE');
    console.error(`  ${err instanceof BackupInspectError ? err.message : 'the backup directory could not be read'}.`);
    return 3;
  }

  console.log(request.json ? JSON.stringify(inspection) : renderBackupInspection(inspection));
  return inspection.ok ? 0 : 1;
}

process.exit(main());
