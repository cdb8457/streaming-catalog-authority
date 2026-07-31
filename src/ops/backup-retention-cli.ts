import {
  MaintenanceUsageError,
  parseMaintenanceFlags,
  reportRefusal,
} from './maintenance-cli-shared.js';
import {
  RetentionAbandonFailed,
  RetentionFailed,
  abandonRetention,
  planRetention,
  renderRetention,
  renderRetentionAbandon,
  renderRetentionPlan,
  resolveRetentionRequest,
  runRetention,
  type RetentionDeps,
  type RetentionMode,
  type RetentionRequest,
} from './backup-retention.js';
import { DEFAULT_RETENTION_POLICY, type RetentionPolicy } from './retention-model.js';
import { isDirectRun } from './direct-run.js';

// Phase 311 — `npm run ops:backup-retention`.
//
// THE THIRD COMMAND IN THE BACKUP FAMILY, and the one this product had only ever described. It removes backup
// sets — the single most dangerous thing an operator does in this product's folders, and the one thing they
// were previously told to do with `rm -rf`.
//
// IT IS READ BEFORE IT IS RUN. `--plan` inventories the destination, VERIFIES every set in it, prints one
// decision per set with a closed reason, and ends with a digest over the whole list. Running requires that
// digest back, and the digest is recomputed UNDER THE LOCK over a fresh inventory before a single directory
// is renamed. A backup taken since the plan was read changes the digest and refuses the confirmation.
//
// THERE IS NO `--force` AND NO `--yes`. The protections are not defaults.
//
// -----------------------------------------------------------------------------------------------------
// `--json` MEANS EXACTLY ONE JSON DOCUMENT, ON ONE STREAM.
// -----------------------------------------------------------------------------------------------------
//
// THE DEFECT THIS CLOSES. The first cut printed the report as JSON and then appended blank lines and human
// remediation prose to the SAME stream for every outcome that was not a success — `INCOMPLETE`,
// `REMOVED_BUT_UNPROVEN`, `ABANDONED_WITH_LOSS`, `PARTIAL` and both post-effect failures. So `--json` was
// parseable on exactly the runs nobody needs to parse, and produced trailing garbage on the ones somebody
// automating this would actually have to read. A flag whose whole purpose is machine-readability has to
// hold on the failure paths or it is decoration.
//
// The report goes to STDOUT on the ordinary paths and to STDERR on a post-effect failure — the same stream
// ownership `ops:complete-restore` uses, so the two commands can be automated the same way. Whichever
// stream carries it carries one document and nothing after it. Every remediation sentence dropped from JSON
// mode is already inside the report's own `notes`, so nothing is lost, it is merely no longer smuggled out
// beside the thing that was supposed to be parseable.

export const RETENTION_EXIT_OK = 0;
export const RETENTION_EXIT_FAILED = 1;
export const RETENTION_EXIT_USAGE = 2;
export const RETENTION_EXIT_REFUSED = 3;

function usage(): string {
  return [
    'usage: npm run ops:backup-retention -- --project <dir> --plan [options]',
    '',
    'Removes old backup sets from a destination, according to a policy you state and a list you read.',
    'It issues NO command of any kind: no docker, no network, no container. It is filesystem work under the',
    'same maintenance lock ops:complete-backup and ops:complete-restore take.',
    '',
    'required:',
    '  --project <dir>          the Compose project directory, absolute',
    '',
    'FOUR MODES, and each one accepts only its own flags — a flag this command would ignore is refused',
    'rather than accepted, because a flag that does nothing is a flag somebody believes did something.',
    '',
    '  --plan                   inventory, verify every set, print every decision and the digest — and stop.',
    '  --confirm <digest>       run it. Takes the same policy flags as --plan, and the digest --plan printed.',
    '  --resume <digest>        continue an interrupted prune. TAKES ONLY --project: the operation comes from',
    '                           the journal the interrupted run left, not from this command line.',
    '  --abandon                put back every set that was renamed aside and not yet deleted. TAKES ONLY',
    '                           --project, for the same reason.',
    '',
    'policy, for --plan and --confirm:',
    `  --destination <rel>      where sets are kept, relative to the project (default: backups)`,
    `  --keep-last <n>          keep the newest n VERIFIED sets (default: ${DEFAULT_RETENTION_POLICY.keepLast})`,
    `  --min-age-days <n>       never remove anything younger than this (default: ${DEFAULT_RETENTION_POLICY.minAgeDays})`,
    '  --include-unverified     also consider sets that do NOT verify. Off by default: a set that failed to',
    '                           verify may have failed for a transient reason, and it is also the evidence.',
    `  --keep-minimum-restorable <n>  refuse the whole run if it would leave fewer restorable sets than this`,
    `                           (default: ${DEFAULT_RETENTION_POLICY.keepMinimumRestorable})`,
    '  --json                   print the machine-readable report, and NOTHING else on that stream',
    '',
    'WHAT NO POLICY CAN REMOVE. The newest verified set this build could restore, and the newest verified set',
    'from BEFORE this build\'s schema — the only thing that can roll this installation back. A destination',
    'with no restorable set at all refuses the whole run: a retention decision is one made while holding a',
    'good backup. Directories with no manifest of ours, unreadable ones, dot-prefixed in-flight artifacts and',
    'anything that is not a directory are reported and never touched.',
    '',
    'NOTHING IS DELETED IN PLACE. Every set is renamed into a private quarantine directory first and only',
    'then removed, so a set name in the destination always holds a whole set or nothing. An interrupted run',
    'leaves a journal, refuses a fresh prune, and is continued with --resume or unwound with --abandon.',
    '',
    'A PROJECT PART WAY THROUGH A RESTORE REFUSES THIS COMMAND ENTIRELY.',
    '',
    'Serialised per destination: this command, ops:complete-backup, ops:complete-restore and',
    'ops:safety-set-lifecycle run one command at a time per backup destination — including',
    'across PROJECTS. A second project pointed at the same physical directory is refused, never',
    'interleaved.',
    '',
    'exit codes: 0 every planned removal completed and the protected set still verifies | 1 a removal did not',
    '            complete, or the protected set could not be verified afterwards | 2 bad usage | 3 refused',
    '            before anything was moved',
  ].join('\n');
}

export type RetentionCliMode = 'plan' | 'run' | 'resume' | 'abandon';

export const RETENTION_MODE_VALUE_FLAGS: Readonly<Record<RetentionCliMode, readonly string[]>> = Object.freeze({
  plan: ['project', 'destination', 'keep-last', 'min-age-days', 'keep-minimum-restorable'],
  run: ['project', 'destination', 'keep-last', 'min-age-days', 'keep-minimum-restorable', 'confirm'],
  // BOUND TO THE JOURNAL. Re-supplying a policy or a destination could only ever contradict what the
  // interrupted run actually did, and the sets it already renamed are named in the journal and nowhere else.
  resume: ['project', 'resume'],
  abandon: ['project'],
});

export const RETENTION_MODE_SWITCH_FLAGS: Readonly<Record<RetentionCliMode, readonly string[]>> = Object.freeze({
  plan: ['plan', 'json', 'include-unverified'],
  run: ['json', 'include-unverified'],
  resume: ['json'],
  abandon: ['abandon', 'json'],
});

export interface ParsedRetentionArgs {
  readonly mode: RetentionCliMode;
  readonly projectRoot: string;
  readonly destination: string;
  readonly policy: RetentionPolicy;
  readonly json: boolean;
  readonly confirm: string | null;
  readonly resume: string | null;
}

/** A whole, non-negative number, or a usage error naming the flag. No coercion, no rounding, no NaN. */
export function wholeNumberFlag(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw)) {
    throw new MaintenanceUsageError(
      `--${name} must be a whole number written in digits. "${raw}" is not one, and this command will not `
      + 'guess what was meant on an operation that removes backups.');
  }
  return Number.parseInt(raw, 10);
}

export function parseRetentionArgs(argv: readonly string[]): ParsedRetentionArgs {
  const parsed = parseMaintenanceFlags(argv, {
    values: ['project', 'destination', 'keep-last', 'min-age-days', 'keep-minimum-restorable', 'confirm',
      'resume'],
    switches: ['plan', 'json', 'abandon', 'include-unverified'],
  });
  const project = parsed.values.project;
  if (project === undefined) throw new MaintenanceUsageError('--project is required');

  const planFlag = parsed.switches.has('plan');
  const abandonFlag = parsed.switches.has('abandon');
  const confirm = parsed.values.confirm ?? null;
  const resume = parsed.values.resume ?? null;

  const chosen = [planFlag && 'plan', abandonFlag && 'abandon', resume !== null && 'resume',
    confirm !== null && 'confirm'].filter((value): value is string => typeof value === 'string');
  if (chosen.length > 1) {
    throw new MaintenanceUsageError(
      `--${chosen.join(', --')} were all given, and they are different operations. Choose one.`);
  }
  if (chosen.length === 0) {
    throw new MaintenanceUsageError(
      'nothing was asked for. Start with --plan, which verifies every set in the destination, prints what it '
      + 'would remove and why, and changes nothing.');
  }
  const mode: RetentionCliMode = planFlag ? 'plan' : abandonFlag ? 'abandon' : resume !== null ? 'resume' : 'run';

  const allowedSwitches = RETENTION_MODE_SWITCH_FLAGS[mode];
  const givenSwitches = [...parsed.switches].filter((name) => !allowedSwitches.includes(name)).sort();
  if (givenSwitches.length > 0) {
    throw new MaintenanceUsageError(
      `--${givenSwitches.join(', --')} ${givenSwitches.length === 1 ? 'is' : 'are'} not part of --${mode}. `
      + `--${mode} takes the switches: --${allowedSwitches.join(', --')}.`);
  }
  const allowed = RETENTION_MODE_VALUE_FLAGS[mode];
  const given = Object.keys(parsed.values).filter((name) => !allowed.includes(name)).sort();
  if (given.length > 0) {
    throw new MaintenanceUsageError(
      `--${given.join(', --')} ${given.length === 1 ? 'is' : 'are'} not part of --${mode}, and this command will `
      + 'not accept a flag it would then ignore. A flag that does nothing is a flag somebody believes did '
      + `something. --${mode} takes: --${allowed.join(', --')}.`);
  }

  const policy: RetentionPolicy = {
    keepLast: wholeNumberFlag('keep-last', parsed.values['keep-last'], DEFAULT_RETENTION_POLICY.keepLast),
    minAgeDays: wholeNumberFlag('min-age-days', parsed.values['min-age-days'], DEFAULT_RETENTION_POLICY.minAgeDays),
    includeUnverified: parsed.switches.has('include-unverified'),
    keepMinimumRestorable: wholeNumberFlag('keep-minimum-restorable', parsed.values['keep-minimum-restorable'],
      DEFAULT_RETENTION_POLICY.keepMinimumRestorable),
  };

  return {
    mode,
    projectRoot: project,
    destination: parsed.values.destination ?? 'backups',
    policy,
    json: parsed.switches.has('json'),
    confirm,
    resume,
  };
}

/**
 * `deps` is a TEST SEAM and nothing else. The entry point below passes none, so production always gets the
 * real clock, the real suffix, the real journal writer and the real remover.
 *
 * It exists for the same reason `RetentionDeps` does: the failures that arrive AFTER sets have moved — a
 * journal that cannot be written, a clear that will not complete — are precisely the ones whose CLI
 * behaviour matters most (which stream, which exit code, is the JSON still one document) and precisely the
 * ones that cannot be produced from outside without one.
 */
export function main(argv: readonly string[] = process.argv.slice(2), deps: RetentionDeps = {}): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return RETENTION_EXIT_OK; }
  let args: ParsedRetentionArgs;
  try {
    args = parseRetentionArgs(argv);
  } catch (err) {
    console.error(reportRefusal(err));
    console.error('');
    console.error(usage());
    return RETENTION_EXIT_USAGE;
  }

  try {
    if (args.mode === 'abandon') {
      const report = abandonRetention(args.projectRoot, deps);
      if (args.json) {
        // EXACTLY ONE JSON DOCUMENT, AND NOTHING ELSE ON THIS STREAM. See the header note.
        console.log(JSON.stringify(report, null, 2));
        return report.ok ? RETENTION_EXIT_OK : RETENTION_EXIT_FAILED;
      }
      console.log(renderRetentionAbandon(report));
      // A CLEAN UNWIND IS THE ONLY ZERO. An abandon that put one set back while another is gone for good is
      // not a success, and the exit code is the thing a scheduler reads: `ABANDONED_WITH_LOSS` and `PARTIAL`
      // both exit 1, because in both cases this destination is not what the operator asked to have back.
      if (!report.ok) {
        console.log('');
        if (report.state === 'ABANDONED_WITH_LOSS') {
          console.log('THIS WAS NOT A CLEAN UNWIND. Everything that could be put back was, and the sets named');
          console.log('above as GONE FOREVER had already been deleted before you asked. A rename cannot bring');
          console.log('them back; another backup can.');
        } else {
          console.log('THIS ABANDON DID NOT PUT EVERYTHING BACK. The journal was kept and the destination is');
          console.log('part way through. Deal with what is named above, then run --abandon again.');
        }
      }
      return report.ok ? RETENTION_EXIT_OK : RETENTION_EXIT_FAILED;
    }

    if (args.mode === 'plan') {
      // NOTHING IS LOCKED, CREATED, MOVED OR REMOVED. The plan refuses everything a run would refuse —
      // a destination with no restorable set, a floor that cannot be met, a project part way through a
      // restore — so a plan that prints is a plan that could run.
      const resolved = resolveRetentionRequest({ projectRoot: args.projectRoot, destination: args.destination });
      const plan = planRetention(resolved, args.policy, new Date());
      if (args.json) console.log(JSON.stringify(plan, null, 2));
      else console.log(renderRetentionPlan(plan));
      return RETENTION_EXIT_OK;
    }

    const request: RetentionRequest = { projectRoot: args.projectRoot, destination: args.destination };
    const mode: RetentionMode = args.mode === 'resume'
      ? { kind: 'resume', confirm: args.resume! }
      : { kind: 'run', confirm: args.confirm! };
    const report = runRetention(request, args.policy, deps, mode);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? RETENTION_EXIT_OK : RETENTION_EXIT_FAILED;
    }
    console.log(renderRetention(report));
    if (!report.ok) {
      console.log('');
      if (report.state === 'REMOVED_BUT_UNPROVEN') {
        console.log('EVERY PLANNED REMOVAL COMPLETED AND THE SET THIS RUN PROMISED TO KEEP DID NOT VERIFY');
        console.log('afterwards. That is not a retention success: this destination is not demonstrably a');
        console.log('recovery point. Look at it before you rely on it, and take a fresh backup.');
      } else {
        console.log('THIS PRUNE DID NOT FINISH. The journal was kept and the destination is part way through.');
        console.log('Continue it with --resume, or put the quarantined sets back with --abandon.');
      }
    }
    return report.ok ? RETENTION_EXIT_OK : RETENTION_EXIT_FAILED;
  } catch (err) {
    // A FAILURE AFTER SETS HAVE MOVED IS NOT A REFUSAL, and it must not exit with the code this command
    // documents as "refused before anything was moved". Anything reading that code would be told nothing
    // happened by a run that had already deleted backups.
    if (err instanceof RetentionFailed) {
      if (args.json) {
        console.error(JSON.stringify(err.report, null, 2));
        return RETENTION_EXIT_FAILED;
      }
      console.error(renderRetention(err.report));
      console.error('');
      console.error(err.message);
      return RETENTION_EXIT_FAILED;
    }
    if (err instanceof RetentionAbandonFailed) {
      if (args.json) {
        console.error(JSON.stringify(err.report, null, 2));
        return RETENTION_EXIT_FAILED;
      }
      console.error(renderRetentionAbandon(err.report));
      console.error('');
      console.error(err.message);
      return RETENTION_EXIT_FAILED;
    }
    console.error(reportRefusal(err));
    return RETENTION_EXIT_REFUSED;
  }
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
