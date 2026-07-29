import { join } from 'node:path';
import { CommandLedger } from './maintenance-safety.js';
import {
  MaintenanceUsageError,
  parseMaintenanceFlags,
  realCommandRunner,
  reportRefusal,
} from './maintenance-cli-shared.js';
import {
  planCompleteBackup,
  renderCompleteBackup,
  resolveCompleteBackupRequest,
  runCompleteBackup,
  type CompleteBackupRequest,
  type CustodianTopology,
} from './complete-backup.js';
import { renderBackupVerification, verifyBackupSet } from './backup-set-verification.js';
import { isDirectRun } from './direct-run.js';

// Phase 277/278 — `npm run ops:complete-backup`.
//
// IT RUNS ON THE HOST, BESIDE THE COMPOSE PROJECT. Not inside the container: it stops the container. That is
// the one thing this command does that nothing inside the stack could.
//
// AND IT VERIFIES WHAT IT TOOK, IN THE SAME RUN. "The backup succeeded" and "the backup verified" are not two
// commands an operator has to remember to pair — a set that does not verify is reported as a failure of the
// backup, which is what it is.

export const COMPLETE_BACKUP_EXIT_OK = 0;
export const COMPLETE_BACKUP_EXIT_FAILED = 1;
export const COMPLETE_BACKUP_EXIT_USAGE = 2;
export const COMPLETE_BACKUP_EXIT_REFUSED = 3;

function usage(): string {
  return [
    'usage: npm run ops:complete-backup -- --project <dir> --set <name> --custodian inline|sidecar [options]',
    '',
    'Takes the complete backup this product has always described: the database, the custodian keystore, the',
    'secret files and your promotion record artifacts. Stops what writes, takes the database and the keystore',
    'from the same moment, starts everything again, and verifies the set before it reports success.',
    '',
    'required:',
    '  --project <dir>          the Compose project directory, absolute',
    '  --set <name>             what to call this backup set. Refused if one of that name is already there.',
    '  --custodian <mode>       inline (keystore inside the app container) or sidecar (its own state directory)',
    '',
    'options:',
    '  --destination <rel>      where sets are kept, relative to the project (default: backups)',
    '  --secrets <rel>          the secrets directory, relative to the project (default: secrets)',
    '  --promotion-records <rel>  the promotion records directory, relative to the project',
    '  --sidecar-state <rel>    REQUIRED with --custodian sidecar. Never guessed.',
    '  --plan                   print the commands this would run, and stop',
    '  --json                   print the machine-readable report',
    '',
    'It contacts no network, reads no media path, opens no secret file, and takes no credential on this',
    'command line. Backup directories are private (0700) and the files inside them are private (0600).',
    '',
    'exit codes: 0 taken and verified | 1 taken and did NOT verify | 2 bad usage | 3 refused before anything ran',
  ].join('\n');
}

export interface ParsedBackupArgs {
  readonly request: CompleteBackupRequest;
  readonly plan: boolean;
  readonly json: boolean;
}

export function parseCompleteBackupArgs(argv: readonly string[]): ParsedBackupArgs {
  const parsed = parseMaintenanceFlags(argv, {
    values: ['project', 'set', 'custodian', 'destination', 'secrets', 'promotion-records', 'sidecar-state'],
    switches: ['plan', 'json'],
  });
  const project = parsed.values.project;
  const set = parsed.values.set;
  const custodian = parsed.values.custodian;
  if (project === undefined) throw new MaintenanceUsageError('--project is required');
  if (set === undefined) throw new MaintenanceUsageError('--set is required');
  if (custodian !== 'inline' && custodian !== 'sidecar') {
    throw new MaintenanceUsageError('--custodian must be exactly "inline" or "sidecar"; this command will not guess');
  }
  const request: CompleteBackupRequest = {
    projectRoot: project,
    setName: set,
    custodian: custodian as CustodianTopology,
    destination: parsed.values.destination ?? 'backups',
    secrets: parsed.values.secrets ?? 'secrets',
    ...(parsed.values['promotion-records'] === undefined ? {} : { promotionRecords: parsed.values['promotion-records'] }),
    ...(parsed.values['sidecar-state'] === undefined ? {} : { sidecarState: parsed.values['sidecar-state'] }),
  };
  return { request, plan: parsed.switches.has('plan'), json: parsed.switches.has('json') };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return COMPLETE_BACKUP_EXIT_OK; }
  let args: ParsedBackupArgs;
  try {
    args = parseCompleteBackupArgs(argv);
  } catch (err) {
    console.error(reportRefusal(err));
    console.error('');
    console.error(usage());
    return COMPLETE_BACKUP_EXIT_USAGE;
  }

  try {
    if (args.plan) {
      // NOTHING IS STOPPED, NOTHING IS CREATED. The resolution refuses everything it would refuse for real,
      // so a plan that prints is a plan that could run.
      const resolved = resolveCompleteBackupRequest(args.request);
      const commands = planCompleteBackup(resolved, '<staging directory beside the set>');
      console.log('This backup would run, in this order, with no shell involved:');
      for (const command of commands) {
        console.log(`  ${command.program} ${command.args.join(' ')}`);
        console.log(`      ${command.purpose}`);
      }
      console.log('');
      console.log('Then it would copy the secrets and promotion records, write a manifest, publish the set');
      console.log('atomically, and verify it. Nothing would be fetched and no media path would be read.');
      return COMPLETE_BACKUP_EXIT_OK;
    }

    const ledger = new CommandLedger();
    const report = runCompleteBackup(args.request, { runner: realCommandRunner(), ledger });
    const resolved = resolveCompleteBackupRequest(args.request);
    const verification = verifyBackupSet(join(resolved.destinationDir, resolved.setName));

    if (args.json) {
      console.log(JSON.stringify({ backup: report, verification }, null, 2));
    } else {
      console.log(renderCompleteBackup(report));
      console.log('');
      console.log(renderBackupVerification(verification));
    }
    return verification.ok ? COMPLETE_BACKUP_EXIT_OK : COMPLETE_BACKUP_EXIT_FAILED;
  } catch (err) {
    console.error(reportRefusal(err));
    return COMPLETE_BACKUP_EXIT_REFUSED;
  }
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
