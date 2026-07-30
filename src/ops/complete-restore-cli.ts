import { CommandLedger } from './maintenance-safety.js';
import {
  MaintenanceUsageError,
  parseMaintenanceFlags,
  realCommandRunner,
  realFileInputRunner,
  realFileOutputRunner,
  reportRefusal,
} from './maintenance-cli-shared.js';
import {
  CompleteRestoreFailed,
  abandonRestore,
  planCompleteRestore,
  renderCompleteRestore,
  renderRestorePlan,
  resolveCompleteRestoreRequest,
  runCompleteRestore,
  type CompleteRestoreRequest,
  type RestoreMode,
} from './complete-restore.js';
import type { CustodianTopology } from './restore-model.js';
import { isDirectRun } from './direct-run.js';

// Phase 304 — `npm run ops:complete-restore`.
//
// THE INVERSE OF `ops:complete-backup`, AND THE HALF THIS PRODUCT HAD ONLY EVER DESCRIBED. It runs on the
// HOST, beside the Compose project, because it stops the stack and destroys its volumes — the two things
// nothing inside the stack could do to itself.
//
// AND IT IS READ BEFORE IT IS RUN. `--plan` verifies the set, classifies the installation, prints every step
// in order with the exact commands, marks the ones after which the installation is not where it was, and ends
// with a digest. Running requires that digest back through `--confirm`, and the digest is re-proved under the
// maintenance lock before the first destructive step. There is no way to reach `docker compose down -v` from
// this CLI without having been shown, and having passed back, exactly what it would do.

export const COMPLETE_RESTORE_EXIT_OK = 0;
export const COMPLETE_RESTORE_EXIT_FAILED = 1;
export const COMPLETE_RESTORE_EXIT_USAGE = 2;
export const COMPLETE_RESTORE_EXIT_REFUSED = 3;

function usage(): string {
  return [
    'usage: npm run ops:complete-restore -- --project <dir> --set <name> --custodian inline|sidecar [options]',
    '',
    'Puts a verified complete backup set back into this installation: the secret files, the promotion record',
    'artifacts, the custodian keystore and the database. Takes a verified safety set of what it is about to',
    'destroy, stops the stack and destroys its volumes, places every component, starts everything again, and',
    'then PROVES the result — including that the installation can DECRYPT its own catalog.',
    '',
    'required:',
    '  --project <dir>          the Compose project directory, absolute',
    '  --set <name>             the backup set to restore, inside the destination',
    '  --custodian <mode>       inline (keystore in the app volume) or sidecar (its own state directory).',
    '                           It must agree with the set\'s own manifest; a disagreement is refused.',
    '',
    'options:',
    '  --destination <rel>      where sets are kept, relative to the project (default: backups)',
    '  --secrets <rel>          the secrets directory, relative to the project (default: secrets)',
    '  --promotion-records <rel>  the promotion records directory. REQUIRED if the set carries them.',
    '  --sidecar-state <rel>    REQUIRED with --custodian sidecar. Never guessed.',
    '  --safety-set <name>      what to call the safety set (default: pre-restore-<set>)',
    '  --plan                   verify, classify, print every step and the digest — and stop',
    '  --confirm <digest>       the digest --plan printed. Required to run.',
    '  --accept-data-loss <digest>  skip the safety set. Takes the SAME digest, so it cannot be pasted from',
    '                           another run, and it is refused when there is nothing to lose.',
    '  --resume <digest>        continue an interrupted restore from the first step it did not complete',
    '  --abandon                put the swapped host directories back and clear the journal',
    '  --json                   print the machine-readable report',
    '',
    'It contacts no network, reads no media path, opens no secret file, and takes no credential on this',
    'command line. Components are placed by RENAME: the previous directory is kept beside the new one.',
    '',
    'THE ONLY ROLLBACK IS A RESTORE. There are no down-migrations, so putting an older image back is not a',
    'rollback — this command is. A set older than this build is refused rather than replayed.',
    '',
    'exit codes: 0 restored and proved | 1 restored and a proof did not hold, or a step failed | 2 bad usage',
    '            | 3 refused before anything was destroyed',
  ].join('\n');
}

export interface ParsedRestoreArgs {
  readonly request: CompleteRestoreRequest;
  readonly plan: boolean;
  readonly json: boolean;
  readonly abandon: boolean;
  readonly confirm: string | null;
  readonly resume: string | null;
  readonly acceptDataLoss: string | null;
}

export function parseCompleteRestoreArgs(argv: readonly string[]): ParsedRestoreArgs {
  const parsed = parseMaintenanceFlags(argv, {
    values: ['project', 'set', 'custodian', 'destination', 'secrets', 'promotion-records', 'sidecar-state',
      'safety-set', 'confirm', 'resume', 'accept-data-loss'],
    switches: ['plan', 'json', 'abandon'],
  });
  const project = parsed.values.project;
  const set = parsed.values.set;
  const custodian = parsed.values.custodian;
  if (project === undefined) throw new MaintenanceUsageError('--project is required');
  if (set === undefined) throw new MaintenanceUsageError('--set is required');
  if (custodian !== 'inline' && custodian !== 'sidecar') {
    throw new MaintenanceUsageError('--custodian must be exactly "inline" or "sidecar"; this command will not guess');
  }

  const plan = parsed.switches.has('plan');
  const abandon = parsed.switches.has('abandon');
  const confirm = parsed.values.confirm ?? null;
  const resume = parsed.values.resume ?? null;

  // THE MODES ARE EXCLUSIVE, AND SAYING SO IS NOT PEDANTRY. `--plan --confirm` reads as "show me and do it",
  // and a command that guessed which half was meant would either destroy an installation somebody wanted to
  // read about, or print a plan somebody believed had run.
  const chosen = [plan && 'plan', abandon && 'abandon', resume !== null && 'resume', confirm !== null && 'confirm']
    .filter((value): value is string => typeof value === 'string');
  if (chosen.length > 1) {
    throw new MaintenanceUsageError(
      `--${chosen.join(', --')} were all given, and they are different operations. Choose one.`);
  }
  if (chosen.length === 0) {
    throw new MaintenanceUsageError(
      'nothing was asked for. Start with --plan, which verifies the set, classifies this installation and '
      + 'prints every step and a digest without changing anything.');
  }

  const request: CompleteRestoreRequest = {
    projectRoot: project,
    setName: set,
    custodian: custodian as CustodianTopology,
    destination: parsed.values.destination ?? 'backups',
    secrets: parsed.values.secrets ?? 'secrets',
    ...(parsed.values['promotion-records'] === undefined ? {} : { promotionRecords: parsed.values['promotion-records'] }),
    ...(parsed.values['sidecar-state'] === undefined ? {} : { sidecarState: parsed.values['sidecar-state'] }),
    ...(parsed.values['safety-set'] === undefined ? {} : { safetySetName: parsed.values['safety-set'] }),
  };
  return {
    request,
    plan,
    json: parsed.switches.has('json'),
    abandon,
    confirm,
    resume,
    acceptDataLoss: parsed.values['accept-data-loss'] ?? null,
  };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return COMPLETE_RESTORE_EXIT_OK; }
  let args: ParsedRestoreArgs;
  try {
    args = parseCompleteRestoreArgs(argv);
  } catch (err) {
    console.error(reportRefusal(err));
    console.error('');
    console.error(usage());
    return COMPLETE_RESTORE_EXIT_USAGE;
  }

  try {
    if (args.abandon) {
      // ABANDON READS THE JOURNAL AND NOTHING ELSE. It deliberately does not need the set — somebody
      // abandoning a restore may well have moved it away, and a command that required it then would be a
      // command that could not be used at the moment it is for.
      const report = abandonRestore(args.request, { ledger: new CommandLedger() });
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`Restore abandoned — set ${report.setName}`);
        console.log(`  put back: ${report.restored.length === 0 ? 'nothing had been swapped yet' : report.restored.join(', ')}`);
        for (const note of report.notes) console.log(`  note: ${note}`);
      }
      return COMPLETE_RESTORE_EXIT_OK;
    }

    if (args.plan) {
      // NOTHING IS STOPPED, NOTHING IS CREATED, NOTHING IS DESTROYED. The resolution refuses everything it
      // would refuse for real — including a set that does not verify and a topology that disagrees — so a plan
      // that prints is a plan that could run.
      const resolved = resolveCompleteRestoreRequest(args.request);
      const safetySet = resolved.targetState === 'OCCUPIED' && args.acceptDataLoss === null;
      console.log(renderRestorePlan(resolved, planCompleteRestore(resolved, { safetySet })));
      return COMPLETE_RESTORE_EXIT_OK;
    }

    const mode: RestoreMode = args.resume !== null
      ? { kind: 'resume', confirm: args.resume }
      : { kind: 'run', confirm: args.confirm!, acceptDataLoss: args.acceptDataLoss };

    const report = runCompleteRestore(args.request, {
      runner: realCommandRunner(),
      fileRunner: realFileInputRunner(),
      backupFileRunner: realFileOutputRunner(),
      ledger: new CommandLedger(),
    }, mode);

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderCompleteRestore(report));
      if (!report.ok) {
        console.log('');
        console.log('THIS RESTORE DID NOT FULLY SUCCEED:');
        for (const step of report.steps) {
          if (step.outcome === 'failed') console.log(`  - ${step.id}: ${step.detail ?? 'it did not hold'}`);
        }
        if (report.state === 'RESTORED_BUT_UNPROVEN') {
          // THE DIFFERENCE DECIDES WHAT AN OPERATOR DOES NEXT, so it is said rather than left to be inferred
          // from which step id happens to be in the list.
          console.log('  The installation IS restored and running. What did not hold is the EVIDENCE that it is');
          console.log('  correct — and one of those proofs is whether it can decrypt its own catalog, which is');
          console.log('  exactly what a keystore that did not arrive looks like. Do not put this into service on');
          console.log('  the strength of it having started.');
        }
      }
    }
    return report.ok ? COMPLETE_RESTORE_EXIT_OK : COMPLETE_RESTORE_EXIT_FAILED;
  } catch (err) {
    // A FAILURE THAT LEFT THE INSTALLATION STOPPED CARRIES ITS REPORT, and the report is where the safety
    // set's name and the kept `.replaced-` directories are. Printing the refusal alone would lose both, at
    // the one moment an operator needs them most.
    if (err instanceof CompleteRestoreFailed) {
      if (args.json) console.error(JSON.stringify(err.report, null, 2));
      else console.error(renderCompleteRestore(err.report));
      console.error('');
    }
    console.error(reportRefusal(err));
    return COMPLETE_RESTORE_EXIT_REFUSED;
  }
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
