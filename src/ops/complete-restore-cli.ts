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
  composeOccupancyProbe,
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
    'FOUR MODES, and each one accepts only its own flags — a flag this command would ignore is refused',
    'rather than accepted, because a flag that does nothing is a flag somebody believes did something.',
    '',
    '  --plan                   verify, classify, print every step and the digest — and stop.',
    '                           takes: --set --custodian --destination --secrets --promotion-records',
    '                                  --sidecar-state --safety-set --accept-data-loss',
    '  --confirm <digest>       run it. Takes the same flags as --plan, and the digest --plan printed.',
    '  --resume <digest>        continue an interrupted restore. TAKES ONLY --project: the operation comes',
    '                           from the journal the interrupted run left, not from this command line.',
    '  --abandon                put the swapped host directories back. TAKES ONLY --project, for the same',
    '                           reason — the journal knows which directories were actually swapped.',
    '',
    'options for --plan and --confirm:',
    '  --destination <rel>      where sets are kept, relative to the project (default: backups)',
    '  --secrets <rel>          the secrets directory, relative to the project (default: secrets)',
    '  --promotion-records <rel>  the promotion records directory. REQUIRED if the set carries them.',
    '  --sidecar-state <rel>    REQUIRED with --custodian sidecar. Never guessed.',
    '  --safety-set <name>      what to call the safety set (default: pre-restore-<set>)',
    '  --accept-data-loss <digest>  destroy this installation WITHOUT a safety set. Takes the SAME digest,',
    '                           so it cannot be pasted from another run. Required when this command cannot',
    '                           take a safety set, which is any installation with no host state to back up.',
    '  --json                   print the machine-readable report',
    '',
    'THIS COMMAND CANNOT PROVE YOUR DOCKER VOLUMES ARE EMPTY. `docker compose down -v` destroys the database',
    'and, in inline custody, the keystore volume — and reading a volume means starting something, which is a',
    'change. So an installation is OCCUPIED or UNKNOWN, never EMPTY, and both need either a verified safety',
    'set or --accept-data-loss.',
    '',
    'It contacts no network, reads no media path, opens no secret file, and takes no credential on this',
    'command line. Components are STAGED out of the set and re-verified against the manifest before anything',
    'is destroyed, then placed by RENAME: the previous directory is kept beside the new one.',
    '',
    'THE ONLY ROLLBACK IS A RESTORE. There are no down-migrations, so putting an older image back is not a',
    'rollback — this command is. A set older than this build is refused rather than replayed.',
    '',
    'exit codes: 0 every step held AND custody was proven | 1 a step failed, or custody was not proven, or',
    '            an abandon could not put everything back | 2 bad usage | 3 refused before anything was',
    '            destroyed',
  ].join('\n');
}

export type RestoreCliMode = 'plan' | 'run' | 'resume' | 'abandon';

export interface ParsedRestoreArgs {
  readonly mode: RestoreCliMode;
  /** The project root. The ONLY thing `--abandon` needs: everything else comes from the journal. */
  readonly projectRoot: string;
  /** Absent in `--abandon`, which is bound to the journal rather than to a command line. */
  readonly request: CompleteRestoreRequest | null;
  readonly json: boolean;
  readonly confirm: string | null;
  readonly resume: string | null;
  readonly acceptDataLoss: string | null;
}

/**
 * Which value flags each mode may carry.
 *
 * -----------------------------------------------------------------------------------------------------
 * A FLAG THAT DOES NOTHING IS A FLAG SOMEBODY BELIEVES DID SOMETHING.
 * -----------------------------------------------------------------------------------------------------
 *
 * The first cut accepted `--accept-data-loss` alongside `--resume` and `--abandon` and silently ignored it in
 * both. An operator who typed it was entitled to believe they had authorised something, and had not — and in
 * the `--abandon` case they had also passed `--secrets` and `--sidecar-state` values that the command used to
 * decide which directories to rename, which is exactly the divergence a journal-bound abandon exists to
 * prevent. Every mode now declares what it accepts, and anything else is a usage error naming the mode.
 */
export const MODE_VALUE_FLAGS: Readonly<Record<RestoreCliMode, readonly string[]>> = Object.freeze({
  plan: ['project', 'set', 'custodian', 'destination', 'secrets', 'promotion-records', 'sidecar-state',
    'safety-set', 'accept-data-loss'],
  run: ['project', 'set', 'custodian', 'destination', 'secrets', 'promotion-records', 'sidecar-state',
    'safety-set', 'confirm', 'accept-data-loss'],
  // A RESUME IS BOUND TO THE JOURNAL. It re-derives the operation from what the interrupted run recorded, so
  // re-supplying paths could only ever contradict it.
  resume: ['project', 'resume'],
  abandon: ['project'],
});

export function parseCompleteRestoreArgs(argv: readonly string[]): ParsedRestoreArgs {
  const parsed = parseMaintenanceFlags(argv, {
    values: ['project', 'set', 'custodian', 'destination', 'secrets', 'promotion-records', 'sidecar-state',
      'safety-set', 'confirm', 'resume', 'accept-data-loss'],
    switches: ['plan', 'json', 'abandon'],
  });
  const project = parsed.values.project;
  if (project === undefined) throw new MaintenanceUsageError('--project is required');

  const planFlag = parsed.switches.has('plan');
  const abandonFlag = parsed.switches.has('abandon');
  const confirm = parsed.values.confirm ?? null;
  const resume = parsed.values.resume ?? null;

  // THE MODES ARE EXCLUSIVE. `--plan --confirm` reads as "show me and do it", and a command that guessed
  // which half was meant would either destroy an installation somebody wanted to read about, or print a plan
  // somebody believed had run.
  const chosen = [planFlag && 'plan', abandonFlag && 'abandon', resume !== null && 'resume',
    confirm !== null && 'confirm'].filter((value): value is string => typeof value === 'string');
  if (chosen.length > 1) {
    throw new MaintenanceUsageError(
      `--${chosen.join(', --')} were all given, and they are different operations. Choose one.`);
  }
  if (chosen.length === 0) {
    throw new MaintenanceUsageError(
      'nothing was asked for. Start with --plan, which verifies the set, classifies this installation and '
      + 'prints every step and a digest without changing anything.');
  }
  const mode: RestoreCliMode = planFlag ? 'plan' : abandonFlag ? 'abandon' : resume !== null ? 'resume' : 'run';

  const allowed = MODE_VALUE_FLAGS[mode];
  const given = Object.keys(parsed.values).filter((name) => !allowed.includes(name)).sort();
  if (given.length > 0) {
    throw new MaintenanceUsageError(
      `--${given.join(', --')} ${given.length === 1 ? 'is' : 'are'} not part of --${mode}, and this command will `
      + 'not accept a flag it would then ignore. A flag that does nothing is a flag somebody believes did '
      + `something. --${mode} takes: --${allowed.join(', --')}.`);
  }

  if (mode === 'abandon' || mode === 'resume') {
    return { mode, projectRoot: project, request: null, json: parsed.switches.has('json'), confirm, resume,
      acceptDataLoss: null };
  }

  const set = parsed.values.set;
  const custodian = parsed.values.custodian;
  if (set === undefined) throw new MaintenanceUsageError('--set is required');
  if (custodian !== 'inline' && custodian !== 'sidecar') {
    throw new MaintenanceUsageError('--custodian must be exactly "inline" or "sidecar"; this command will not guess');
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
    mode,
    projectRoot: project,
    request,
    json: parsed.switches.has('json'),
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
    if (args.mode === 'abandon') {
      // ABANDON TAKES THE PROJECT ROOT AND NOTHING ELSE. The operation it unwinds is the one the JOURNAL
      // recorded — not one re-described by whatever flags are typed now, which can differ from the run that
      // actually swapped those directories. Somebody abandoning a restore may also have moved the set away,
      // and a command that demanded it then would be one that could not be used at the moment it is for.
      const report = abandonRestore(args.projectRoot);
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`Restore abandoned — set ${report.setName}`);
        console.log(`  put back: ${report.restored.length === 0 ? 'nothing had been swapped yet' : report.restored.join(', ')}`);
        if (report.unresolved.length > 0) {
          console.log(`  STILL OUT OF PLACE: ${report.unresolved.join(', ')}`);
        }
        console.log(`  journal cleared: ${report.journalCleared}`);
        for (const note of report.notes) console.log(`  note: ${note}`);
      }
      // AN ABANDON THAT COULD NOT PUT EVERYTHING BACK DID NOT SUCCEED, and it says so with its exit code as
      // well as its text: the project is still part way through a restore.
      return report.ok ? COMPLETE_RESTORE_EXIT_OK : COMPLETE_RESTORE_EXIT_FAILED;
    }

    if (args.mode === 'plan') {
      // NOTHING IS STOPPED, NOTHING IS CREATED, NOTHING IS DESTROYED. The resolution refuses everything it
      // would refuse for real — including a set that does not verify and a topology that disagrees — so a plan
      // that prints is a plan that could run.
      const ledger = new CommandLedger();
      const resolved = resolveCompleteRestoreRequest(args.request!,
        composeOccupancyProbe(realCommandRunner(), ledger));
      const acceptDataLoss = args.acceptDataLoss !== null;
      const plan = planCompleteRestore(resolved, { safetySet: !acceptDataLoss, acceptDataLoss });
      console.log(renderRestorePlan(resolved, plan));
      return COMPLETE_RESTORE_EXIT_OK;
    }

    const mode: RestoreMode = args.mode === 'resume'
      ? { kind: 'resume', confirm: args.resume! }
      : { kind: 'run', confirm: args.confirm!, acceptDataLoss: args.acceptDataLoss };

    // A RESUME CARRIES NO REQUEST: the journal supplies the operation. The shape below is a placeholder the
    // run replaces field for field from what the interrupted run recorded.
    const request: CompleteRestoreRequest = args.request ?? {
      projectRoot: args.projectRoot, destination: 'backups', setName: 'resumed',
      custodian: 'inline', secrets: 'secrets',
    };

    const report = runCompleteRestore(request, {
      runner: realCommandRunner(),
      fileRunner: realFileInputRunner(),
      backupFileRunner: realFileOutputRunner(),
      ledger: new CommandLedger(),
    }, mode);

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderCompleteRestore(report));
      if (!report.ok || !report.custodyProven) {
        console.log('');
        console.log('THIS RESTORE DID NOT FULLY SUCCEED:');
        for (const step of report.steps) {
          if (step.outcome === 'failed') console.log(`  - ${step.id}: ${step.detail ?? 'it did not hold'}`);
        }
        if (!report.custodyProven && report.ok) {
          console.log('  Every step held and CUSTODY WAS NOT PROVEN: this installation did not demonstrate that');
          console.log('  it can decrypt its own catalog. Read the custody proof\'s own reason above.');
        }
        if (report.state === 'RESTORED_BUT_UNPROVEN') {
          console.log('  The installation IS restored and running. What did not hold is the EVIDENCE that it is');
          console.log('  correct — and one of those proofs is whether it can decrypt its own catalog, which is');
          console.log('  exactly what a keystore that did not arrive looks like. Do not put this into service on');
          console.log('  the strength of it having started.');
        }
      }
    }
    // `ok` IS THE STEPS; CUSTODY IS ITS OWN CLAIM. A restore whose every step held but which never proved it
    // could decrypt has not earned a zero exit, because a scheduler reading zero would put it into service.
    return report.ok && report.custodyProven ? COMPLETE_RESTORE_EXIT_OK : COMPLETE_RESTORE_EXIT_FAILED;
  } catch (err) {
    // A POST-DESTRUCTIVE FAILURE IS A STEP FAILURE, NOT A REFUSAL.
    //
    // THE DEFECT THIS CLOSES. `CompleteRestoreFailed` fell into the same catch as every pre-destructive
    // refusal and exited 3 — the code this command documents as "refused before anything was destroyed". A
    // scheduler watching for "nothing happened" was told nothing happened by a run that had already destroyed
    // the installation's volumes. It exits 1, with its report, like every other step failure.
    if (err instanceof CompleteRestoreFailed) {
      if (args.json) console.error(JSON.stringify(err.report, null, 2));
      else console.error(renderCompleteRestore(err.report));
      console.error('');
      console.error(err.message);
      return COMPLETE_RESTORE_EXIT_FAILED;
    }
    console.error(reportRefusal(err));
    return COMPLETE_RESTORE_EXIT_REFUSED;
  }
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
