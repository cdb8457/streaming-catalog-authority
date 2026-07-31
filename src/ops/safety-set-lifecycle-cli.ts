import {
  MaintenanceUsageError,
  parseMaintenanceFlags,
  reportRefusal,
} from './maintenance-cli-shared.js';
import {
  SAFETY_SET_REPORT,
  SAFETY_SET_VERSION,
  SafetySetAbandonFailed,
  SafetySetFailed,
  abandonSafetySetLifecycle,
  planSafetySetLifecycle,
  renderSafetySetAbandon,
  renderSafetySetPlan,
  renderSafetySetRun,
  resolveSafetySetRequest,
  runSafetySetLifecycle,
  type SafetySetDeps,
  type SafetySetMode,
  type SafetySetRequest,
} from './safety-set-lifecycle.js';
import { DEFAULT_SAFETY_SET_POLICY, type SafetySetPolicy } from './safety-set-model.js';
import { isDirectRun } from './direct-run.js';

// Phase 319 — `npm run ops:safety-set-lifecycle`.
//
// THE FOURTH COMMAND IN THE BACKUP FAMILY, and the one that closes the pile nothing else could see. Every
// `ops:complete-restore` publishes a verified safety set inside a claim directory it owns exclusively;
// `ops:backup-retention` classifies every dot-prefixed name as RESERVED and never descends into one, which is
// correct and is not changed here. So safety sets accumulated one per restore, forever. This removes them —
// and only ones whose ownership marker proves a restore of this build created them.
//
// IT IS READ BEFORE IT IS RUN. `--plan` inventories every claim, verifies the safety set inside each one,
// inventories the ordinary sets beside them, prints one decision per claim with a closed reason and the
// evidence behind its class, and ends with a digest over the whole list. Running requires that digest back,
// and the digest is recomputed UNDER THE LOCK over a fresh inventory before a single directory is renamed.
//
// THERE IS NO `--force`, NO `--yes` AND NO SCHEDULE. The protections are not defaults, and the Unraid example
// gained a mode that prints this plan and has no mode that acts on it.
//
// `--json` MEANS EXACTLY ONE JSON DOCUMENT, ON ONE STREAM, ON EVERY PATH. Ordinary reports go to stdout; a
// failure that arrives after claims have moved, a pre-effect refusal and a usage error go to stderr — the
// same stream ownership `ops:complete-restore` and `ops:backup-retention` use, so all three automate the
// same way. Every remediation sentence dropped from JSON mode is already inside the report's own `notes`,
// and a refusal or a usage error becomes a `SafetySetRefusalDocument` rather than prose. `--help` is the one
// documented exception and stays human text.

export const SAFETY_SET_EXIT_OK = 0;
export const SAFETY_SET_EXIT_FAILED = 1;
export const SAFETY_SET_EXIT_USAGE = 2;
export const SAFETY_SET_EXIT_REFUSED = 3;

/**
 * What `--json` emits when this command refuses or is misused.
 *
 * -----------------------------------------------------------------------------------------------------
 * A FLAG THAT MEANS "MACHINE-READABLE" HAS TO HOLD ON THE PATHS A MACHINE ACTUALLY MEETS.
 * -----------------------------------------------------------------------------------------------------
 *
 * THE DEFECT THIS CLOSES. The usage text and this command's own acceptance suite both promised exactly one
 * JSON document on every path, and two paths emitted plain prose instead: a pre-effect refusal (exit 3) and
 * a usage error (exit 2, followed by the whole usage text). Those are not rare paths — a refusal is the
 * ordinary outcome of a scheduled `--plan` against a project that is mid-restore, and anything reading this
 * command's output would have had to sniff whether the bytes were JSON before parsing them. A contract that
 * holds on the success paths and breaks on the failure paths is not a contract.
 *
 * It carries the same `report`/`version` header as the real reports so one parser handles every document,
 * and `state` distinguishes them: no reader has to infer the outcome from which fields are missing.
 */
export interface SafetySetRefusalDocument {
  readonly report: typeof SAFETY_SET_REPORT;
  readonly version: typeof SAFETY_SET_VERSION;
  readonly ok: false;
  readonly state: 'REFUSED' | 'USAGE';
  /** The exit code this document is emitted with, so a reader that only has the bytes still knows. */
  readonly exitCode: typeof SAFETY_SET_EXIT_REFUSED | typeof SAFETY_SET_EXIT_USAGE;
  /** This product's own words, redacted the way every other surface is. Never a host path. */
  readonly message: string;
  readonly commands: 'none';
  readonly network: 'none';
}

export function refusalDocument(
  state: 'REFUSED' | 'USAGE',
  message: string,
): SafetySetRefusalDocument {
  return {
    report: SAFETY_SET_REPORT,
    version: SAFETY_SET_VERSION,
    ok: false,
    state,
    exitCode: state === 'REFUSED' ? SAFETY_SET_EXIT_REFUSED : SAFETY_SET_EXIT_USAGE,
    message,
    commands: 'none',
    network: 'none',
  };
}

function usage(): string {
  return [
    'usage: npm run ops:safety-set-lifecycle -- --project <dir> --plan [options]',
    '',
    'Removes the safety sets ops:complete-restore leaves behind. Every restore takes a verified backup of the',
    'installation it is about to destroy and publishes it inside a claim directory it owns exclusively:',
    '<destination>/.pre-restore-claim-<nonce>/pre-restore-<set>. Those accumulate one per restore.',
    '',
    'It issues NO command of any kind: no docker, no network, no container. It is filesystem work under the',
    'same project lock ops:complete-backup and ops:complete-restore take, and the same backup-destination',
    'lock ops:backup-retention takes — in that order, so the two cannot deadlock.',
    '',
    'ops:backup-retention STILL NEVER DESCENDS INTO A CLAIM. That rule is what keeps it away from a backup',
    'staging tree, a restore in progress, a lock directory and its own quarantine, and it is not weakened.',
    'This is a separate command with a separate ownership proof: a claim is removable only when the marker',
    'INSIDE it proves ops:complete-restore of this build created it, and its own name agrees with the nonce',
    'in that marker.',
    '',
    'required:',
    '  --project <dir>          the Compose project directory, absolute',
    '',
    'FOUR MODES, and each one accepts only its own flags — a flag this command would ignore is refused rather',
    'than accepted, because a flag that does nothing is a flag somebody believes did something.',
    '',
    '  --plan                   inventory every claim, verify every safety set, print every decision and the',
    '                           digest — and stop.',
    '  --confirm <digest>       run it. Takes the same policy flags as --plan, and the digest --plan printed.',
    '  --resume <digest>        continue an interrupted run. TAKES ONLY --project: the operation comes from',
    '                           the journal the interrupted run left, not from this command line.',
    '  --abandon                put back every claim that was renamed aside and not yet deleted. TAKES ONLY',
    '                           --project, for the same reason.',
    '',
    'policy, for --plan and --confirm:',
    '  --destination <rel>      where sets are kept, relative to the project (default: backups)',
    `  --keep-last <n>          keep the newest n complete safety sets (default: ${DEFAULT_SAFETY_SET_POLICY.keepLast})`,
    `  --min-age-days <n>       never remove anything younger than this (default: ${DEFAULT_SAFETY_SET_POLICY.minAgeDays})`,
    '  --include-unverified     also consider claims whose safety set does NOT verify. Off by default: a set',
    '                           that failed to verify may have failed for a transient reason, and it is also',
    '                           the evidence.',
    '  --include-empty-claims   also consider claims that hold no safety set at all. Off by default, and even',
    '                           then their age comes from the directory\'s modification time, which is weaker',
    '                           evidence than a manifest — the plan says so beside every such decision.',
    '  --keep-minimum-restorable <n>  refuse the whole run if it would leave fewer restorable sets ACROSS THIS',
    `                           WHOLE DESTINATION than this (default: ${DEFAULT_SAFETY_SET_POLICY.keepMinimumRestorable})`,
    '  --json                   print exactly one JSON document and NOTHING else on that stream, on every',
    '                           path: plan, run, resume, abandon, an incomplete or post-effect failure, a',
    '                           refusal and a usage error. --help stays human text.',
    '',
    'WHAT NO POLICY CAN REMOVE. The newest safety set this build could restore, and the newest safety set from',
    'BEFORE this build\'s schema. A claim with work in flight, one holding anything this build does not',
    'publish, one from another build, one that cannot prove it is ours, one that has been MOVED, a link at a',
    'claim-shaped name, and every ordinary backup set in the destination. A destination that could be restored',
    'from nothing at all — top level or safety set — refuses the whole run.',
    '',
    'THE FLOOR IS COUNTED OVER THE WHOLE DESTINATION and is proved again from live disk immediately before the',
    'first deletion, because a resume continues an operation planned before a crash and anything can have',
    'happened in between.',
    '',
    'NOTHING IS DELETED IN PLACE. Every claim is renamed into a private quarantine directory first and only',
    'then removed. An interrupted run leaves a journal, refuses a fresh run, and is continued with --resume or',
    'unwound with --abandon.',
    '',
    'A PROJECT PART WAY THROUGH A RESTORE, OR THROUGH ops:backup-retention, REFUSES THIS COMMAND ENTIRELY.',
    '',
    'Serialised per destination: this command, ops:complete-backup, ops:complete-restore and',
    'ops:backup-retention run one command at a time per backup destination — including',
    'across PROJECTS. A second project pointed at the same physical directory is refused, never',
    'interleaved.',
    '',
    'exit codes: 0 every planned removal completed and the protected safety set still verifies | 1 a removal',
    '            did not complete, or the protected set could not be verified afterwards | 2 bad usage | 3',
    '            refused before anything was moved',
  ].join('\n');
}

export type SafetySetCliMode = 'plan' | 'run' | 'resume' | 'abandon';

export const SAFETY_SET_MODE_VALUE_FLAGS: Readonly<Record<SafetySetCliMode, readonly string[]>> = Object.freeze({
  plan: ['project', 'destination', 'keep-last', 'min-age-days', 'keep-minimum-restorable'],
  run: ['project', 'destination', 'keep-last', 'min-age-days', 'keep-minimum-restorable', 'confirm'],
  // BOUND TO THE JOURNAL. Re-supplying a policy or a destination could only ever contradict what the
  // interrupted run actually did, and the claims it already renamed are named in the journal and nowhere else.
  resume: ['project', 'resume'],
  abandon: ['project'],
});

export const SAFETY_SET_MODE_SWITCH_FLAGS: Readonly<Record<SafetySetCliMode, readonly string[]>> = Object.freeze({
  plan: ['plan', 'json', 'include-unverified', 'include-empty-claims'],
  run: ['json', 'include-unverified', 'include-empty-claims'],
  resume: ['json'],
  abandon: ['abandon', 'json'],
});

export interface ParsedSafetySetArgs {
  readonly mode: SafetySetCliMode;
  readonly projectRoot: string;
  readonly destination: string;
  readonly policy: SafetySetPolicy;
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

export function parseSafetySetArgs(argv: readonly string[]): ParsedSafetySetArgs {
  const parsed = parseMaintenanceFlags(argv, {
    values: ['project', 'destination', 'keep-last', 'min-age-days', 'keep-minimum-restorable', 'confirm',
      'resume'],
    switches: ['plan', 'json', 'abandon', 'include-unverified', 'include-empty-claims'],
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
      'nothing was asked for. Start with --plan, which inventories every restore claim, verifies the safety '
      + 'set inside each one, prints what it would remove and why, and changes nothing.');
  }
  const mode: SafetySetCliMode = planFlag ? 'plan'
    : abandonFlag ? 'abandon' : resume !== null ? 'resume' : 'run';

  const allowedSwitches = SAFETY_SET_MODE_SWITCH_FLAGS[mode];
  const givenSwitches = [...parsed.switches].filter((name) => !allowedSwitches.includes(name)).sort();
  if (givenSwitches.length > 0) {
    throw new MaintenanceUsageError(
      `--${givenSwitches.join(', --')} ${givenSwitches.length === 1 ? 'is' : 'are'} not part of --${mode}. `
      + `--${mode} takes the switches: --${allowedSwitches.join(', --')}.`);
  }
  const allowed = SAFETY_SET_MODE_VALUE_FLAGS[mode];
  const given = Object.keys(parsed.values).filter((name) => !allowed.includes(name)).sort();
  if (given.length > 0) {
    throw new MaintenanceUsageError(
      `--${given.join(', --')} ${given.length === 1 ? 'is' : 'are'} not part of --${mode}, and this command will `
      + 'not accept a flag it would then ignore. A flag that does nothing is a flag somebody believes did '
      + `something. --${mode} takes: --${allowed.join(', --')}.`);
  }

  const policy: SafetySetPolicy = {
    keepLast: wholeNumberFlag('keep-last', parsed.values['keep-last'], DEFAULT_SAFETY_SET_POLICY.keepLast),
    minAgeDays: wholeNumberFlag('min-age-days', parsed.values['min-age-days'],
      DEFAULT_SAFETY_SET_POLICY.minAgeDays),
    includeUnverified: parsed.switches.has('include-unverified'),
    includeEmptyClaims: parsed.switches.has('include-empty-claims'),
    keepMinimumRestorable: wholeNumberFlag('keep-minimum-restorable',
      parsed.values['keep-minimum-restorable'], DEFAULT_SAFETY_SET_POLICY.keepMinimumRestorable),
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
 * real clock, the real suffix, the real journal writer and the real remover. It exists because the failures
 * that arrive AFTER claims have moved are precisely the ones whose CLI behaviour matters most — which stream,
 * which exit code, is the JSON still one document — and precisely the ones that cannot be produced from
 * outside without one.
 */
export function main(argv: readonly string[] = process.argv.slice(2), deps: SafetySetDeps = {}): number {
  // `--help` IS HUMAN TEXT, EVEN BESIDE `--json`, and that is the one documented exception: it is a request
  // for the manual, not for a report, and there is no report of a manual to emit.
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return SAFETY_SET_EXIT_OK; }
  let args: ParsedSafetySetArgs;
  try {
    args = parseSafetySetArgs(argv);
  } catch (err) {
    // THE FLAG IS READ FROM THE RAW ARGUMENTS, because the parse is what just failed. A usage error is the
    // first thing an automated caller meets when it gets a flag wrong, and it is the last place that should
    // hand back something it cannot parse.
    if (argv.includes('--json')) {
      console.error(JSON.stringify(refusalDocument('USAGE', reportRefusal(err)), null, 2));
      return SAFETY_SET_EXIT_USAGE;
    }
    console.error(reportRefusal(err));
    console.error('');
    console.error(usage());
    return SAFETY_SET_EXIT_USAGE;
  }

  try {
    if (args.mode === 'abandon') {
      const report = abandonSafetySetLifecycle(args.projectRoot, deps);
      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
        return report.ok ? SAFETY_SET_EXIT_OK : SAFETY_SET_EXIT_FAILED;
      }
      console.log(renderSafetySetAbandon(report));
      // A CLEAN UNWIND IS THE ONLY ZERO. An abandon that put one claim back while another is gone for good is
      // not a success, and the exit code is the thing a reader trusts.
      if (!report.ok) {
        console.log('');
        if (report.state === 'ABANDONED_WITH_LOSS') {
          console.log('THIS WAS NOT A CLEAN UNWIND. Everything that could be put back was, and the claims named');
          console.log('above as GONE FOREVER had already been deleted before you asked. A rename cannot bring');
          console.log('them back; another backup can.');
        } else {
          console.log('THIS ABANDON DID NOT PUT EVERYTHING BACK. The journal was kept and the destination is');
          console.log('part way through. Deal with what is named above, then run --abandon again.');
        }
      }
      return report.ok ? SAFETY_SET_EXIT_OK : SAFETY_SET_EXIT_FAILED;
    }

    if (args.mode === 'plan') {
      // NOTHING IS LOCKED, CREATED, MOVED OR REMOVED. The plan refuses everything a run would refuse — a
      // destination with no restorable set, a floor that cannot be met, a project part way through a restore
      // or a prune — so a plan that prints is a plan that could run.
      const resolved = resolveSafetySetRequest({ projectRoot: args.projectRoot, destination: args.destination });
      const plan = planSafetySetLifecycle(resolved, args.policy, new Date());
      if (args.json) console.log(JSON.stringify(plan, null, 2));
      else console.log(renderSafetySetPlan(plan));
      return SAFETY_SET_EXIT_OK;
    }

    const request: SafetySetRequest = { projectRoot: args.projectRoot, destination: args.destination };
    const mode: SafetySetMode = args.mode === 'resume'
      ? { kind: 'resume', confirm: args.resume! }
      : { kind: 'run', confirm: args.confirm! };
    const report = runSafetySetLifecycle(request, args.policy, deps, mode);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? SAFETY_SET_EXIT_OK : SAFETY_SET_EXIT_FAILED;
    }
    console.log(renderSafetySetRun(report));
    if (!report.ok) {
      console.log('');
      if (report.state === 'REMOVED_BUT_UNPROVEN') {
        console.log('EVERY PLANNED REMOVAL COMPLETED AND THE SAFETY SET THIS RUN PROMISED TO KEEP DID NOT');
        console.log('VERIFY afterwards. That is not a success: this destination is not demonstrably a recovery');
        console.log('point. Look at it before you rely on it, and take a fresh backup.');
      } else if (report.haltedBeforeDeleting !== null) {
        console.log('THIS RUN STOPPED BEFORE ITS FIRST DELETION. Nothing was destroyed: every claim it set');
        console.log('aside is whole in the quarantine directory. Put them back with --abandon, take a backup,');
        console.log('and plan again.');
      } else {
        console.log('THIS RUN DID NOT FINISH. The journal was kept and the destination is part way through.');
        console.log('Continue it with --resume, or put the quarantined claims back with --abandon.');
      }
    }
    return report.ok ? SAFETY_SET_EXIT_OK : SAFETY_SET_EXIT_FAILED;
  } catch (err) {
    // A FAILURE AFTER CLAIMS HAVE MOVED IS NOT A REFUSAL, and it must not exit with the code this command
    // documents as "refused before anything was moved".
    if (err instanceof SafetySetFailed) {
      if (args.json) {
        console.error(JSON.stringify(err.report, null, 2));
        return SAFETY_SET_EXIT_FAILED;
      }
      console.error(renderSafetySetRun(err.report));
      console.error('');
      console.error(err.message);
      return SAFETY_SET_EXIT_FAILED;
    }
    if (err instanceof SafetySetAbandonFailed) {
      if (args.json) {
        console.error(JSON.stringify(err.report, null, 2));
        return SAFETY_SET_EXIT_FAILED;
      }
      console.error(renderSafetySetAbandon(err.report));
      console.error('');
      console.error(err.message);
      return SAFETY_SET_EXIT_FAILED;
    }
    if (args.json) {
      console.error(JSON.stringify(refusalDocument('REFUSED', reportRefusal(err)), null, 2));
      return SAFETY_SET_EXIT_REFUSED;
    }
    console.error(reportRefusal(err));
    return SAFETY_SET_EXIT_REFUSED;
  }
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
