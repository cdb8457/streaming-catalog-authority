import { CommandLedger, MaintenanceRefused } from './maintenance-safety.js';
import { realCommandRunner } from './maintenance-cli-shared.js';
import {
  launcherComposeArgs,
  planCustodyTransition,
  runCustodyTransition,
  type CustodyTransitionRequest,
} from './custody-transition.js';
import { isDirectRun } from './direct-run.js';

// Phase 293 — `npm run ops:custody-transition`.
//
// The upgrade step a v1.1.4 installation needs before anything else: work out, from its own key material,
// which custody it is actually on, and select the runtime that supports it. It is the command that stops an
// upgrade from stranding an installation whose keys are all under a static KEK on a stack that has no static
// KEK in it.
//
// `--compose-args` exists for the shipped host scripts: it prints the `-f` arguments for the mode this
// project is in, so a launcher cannot silently start the wrong stack.

export const TRANSITION_EXIT_OK = 0;
export const TRANSITION_EXIT_FAILED = 1;
export const TRANSITION_EXIT_USAGE = 2;
export const TRANSITION_EXIT_REFUSED = 3;

export const DEFAULT_APPDATA_DIR = '/mnt/user/appdata/catalog';

function usage(): string {
  return [
    'usage: npm run ops:custody-transition -- --project <dir> --project-name <name>',
    '                                        [--backup-set <name>] [--appdata <dir>]',
    '                                        (--plan | --confirm-digest <hex> | --compose-args)',
    '',
    'Classify this installation by its own key material and select the runtime custody that evidence',
    'supports. Nothing here contacts a network, pulls an image or builds one.',
    '',
    '  --plan            print the verdict, the mode it selects and the digest that confirms it. It renders',
    '                    the compose configuration and reads key material; it starts nothing and writes',
    '                    nothing.',
    '  --confirm-digest  re-prove everything under the custody locks and write or remove the mode marker',
    '  --compose-args    print the -f arguments this project must be started with, for a host script',
    '',
    'verdicts: legacy-static (-> bootstrap) | interrupted-adoption (-> bootstrap) | managed-ring (-> root-only)',
    '',
    'exit codes: 0 done | 1 did not complete | 2 bad usage | 3 refused before anything changed',
  ].join('\n');
}

export interface ParsedTransitionArgs extends CustodyTransitionRequest {
  readonly plan: boolean;
  readonly composeArgs: boolean;
  readonly confirmDigest: string | null;
}

export function parseTransitionArgs(argv: readonly string[]): ParsedTransitionArgs {
  let projectRoot: string | undefined;
  let projectName = 'catalogauthority';
  let backupSetName = '';
  let appdata = DEFAULT_APPDATA_DIR;
  let plan = false;
  let composeArgs = false;
  let confirmDigest: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };
    switch (argument) {
      case '--plan': plan = true; break;
      case '--compose-args': composeArgs = true; break;
      case '--project': projectRoot = value(); break;
      case '--project-name': projectName = value(); break;
      case '--backup-set': backupSetName = value(); break;
      case '--appdata': appdata = value(); break;
      case '--confirm-digest': confirmDigest = value(); break;
      default: throw new Error(`unknown option: ${argument}`);
    }
  }
  if (projectRoot === undefined) throw new Error('--project is required');
  const modes = [plan, composeArgs, confirmDigest !== null].filter(Boolean).length;
  if (modes !== 1) throw new Error('give exactly one of --plan, --confirm-digest or --compose-args');
  if (confirmDigest !== null && !/^[0-9a-f]{64}$/.test(confirmDigest)) {
    throw new Error('--confirm-digest must be the 64-character digest the plan printed');
  }
  return {
    projectRoot,
    projectName,
    backupSetName,
    plan,
    composeArgs,
    confirmDigest,
    hostStateDir: `${appdata}/sidecar/state`,
    hostRootKeyFile: `${appdata}/secrets/custodian_root_key`,
    hostStaticKeyFile: `${appdata}/secrets/custodian_kek`,
    hostBackupsDir: `${appdata}/backups`,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(usage());
    return argv.length === 0 ? TRANSITION_EXIT_USAGE : TRANSITION_EXIT_OK;
  }
  let args: ParsedTransitionArgs;
  try {
    args = parseTransitionArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error('');
    console.error(usage());
    return TRANSITION_EXIT_USAGE;
  }
  try {
    if (args.composeArgs) {
      // ONE LINE, FOR A SHELL TO READ. No classification, no proof, no lock: this answers "which files is
      // this project on right now", which is what a launcher needs before every command.
      console.log(launcherComposeArgs(args.projectRoot).join(' '));
      return TRANSITION_EXIT_OK;
    }
    const deps = { runner: realCommandRunner(), ledger: new CommandLedger() };
    if (args.plan) {
      const planned = planCustodyTransition(args, deps);
      console.log('This installation was classified by its own key material, not by a marker or a filename.');
      console.log('');
      console.log(`  verdict            ${planned.evidence.verdict}`);
      console.log(`  wrapped keys proved ${planned.evidence.keysProved}`);
      console.log(`  active generation  ${planned.evidence.ringGeneration ?? 'no ring on this installation'}`);
      console.log(`  runtime now        ${planned.currentMode}${planned.currentModeDeclared ? '' : ' (defaulted: no marker)'}`);
      console.log(`  runtime selected   ${planned.evidence.selectedMode}`);
      console.log('');
      console.log(planned.changes
        ? 'NOTHING HAS BEEN CHANGED BY PRINTING THIS. Confirm it to write the selection.'
        : 'NOTHING WOULD CHANGE: this installation already runs the mode its key material supports.');
      console.log('');
      console.log(`plan digest: ${planned.planDigest}`);
      return TRANSITION_EXIT_OK;
    }
    const outcome = runCustodyTransition({ ...args, confirmDigest: args.confirmDigest }, deps);
    console.log(JSON.stringify(outcome, null, 2));
    return outcome.ok ? TRANSITION_EXIT_OK : TRANSITION_EXIT_FAILED;
  } catch (err) {
    if (err instanceof MaintenanceRefused) {
      console.error(err.message);
      return TRANSITION_EXIT_REFUSED;
    }
    console.error((err as Error).message);
    return TRANSITION_EXIT_FAILED;
  }
}

if (isDirectRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = TRANSITION_EXIT_FAILED; });
}
