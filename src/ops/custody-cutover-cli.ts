import { CommandLedger, MaintenanceRefused } from './maintenance-safety.js';
import { realCommandRunner } from './maintenance-cli-shared.js';
import {
  CustodyCutoverFailed,
  planCustodyCutover,
  runCustodyCutover,
  type CustodyCutoverRequest,
} from './custody-cutover.js';
import { isDirectRun } from './direct-run.js';

// Phase 290 — `npm run ops:custody-cutover`.
//
// The static-to-ring cutover as a plan and a confirmation. It reimplements no cryptography: the ring is
// written by `ops:kek-ring migrate` inside the one-shot custody-maintenance container, and this command is
// the transaction around it — quiesce, migrate, switch the runtime selection, restart, prove the handshake,
// and put the RUNTIME back if any of that fails.
//
// NO KEY REACHES A COMMAND LINE, IN EITHER DIRECTION. Every key input is a file the compose files mount; the
// only things named here are a project directory, a stack name and a backup set NAME.

export const CUTOVER_EXIT_OK = 0;
export const CUTOVER_EXIT_FAILED = 1;
export const CUTOVER_EXIT_USAGE = 2;
export const CUTOVER_EXIT_REFUSED = 3;

function usage(): string {
  return [
    'usage: npm run ops:custody-cutover -- --project <dir> --project-name <name> --backup-set <name>',
    '                                     [--appdata <dir>] (--plan | --confirm-digest <hex>)',
    '',
    'Move an installation from STATIC bootstrap custody onto the sidecar-managed KEK ring, and leave the',
    'stack in the canonical steady state: one compose file, the root wrapping key, and no static KEK mounted',
    'anywhere. Nothing here contacts a network, pulls an image or builds one.',
    '',
    '  --project <dir>        the project directory holding the compose files and the mode marker',
    '  --project-name <name>  the compose project name, so every command addresses one stack',
    '  --backup-set <name>    the set INSIDE the backups directory the stack already mounts. It is verified',
    '                         and proved to restore custody before anything is changed.',
    '  --appdata <dir>        the appdata directory (default: /mnt/user/appdata/catalog)',
    '  --plan                 print what would happen and the digest that confirms it. It changes nothing',
    '                         about this installation: it renders the compose configuration and runs the',
    '                         migration planner in a one-shot container that is removed on exit. No',
    '                         service is stopped or started and no ring is written.',
    '  --confirm-digest <hex> perform the cutover the plan with that digest described',
    '',
    'ROLLBACK, STATED HONESTLY. On failure this puts the RUNTIME back on the selection it was running and',
    'proves the sidecar answers there. It does NOT undo a migration that already completed: once a ring is',
    'written, a ring exists, and the way back from that is the verified backup this command is gated on.',
    '',
    'exit codes: 0 done | 1 did not complete | 2 bad usage | 3 refused before anything changed',
  ].join('\n');
}

export interface ParsedCutoverArgs extends CustodyCutoverRequest {
  readonly plan: boolean;
  readonly confirmDigest: string | null;
}

export const DEFAULT_APPDATA_DIR = '/mnt/user/appdata/catalog';

export function parseCutoverArgs(argv: readonly string[]): ParsedCutoverArgs {
  let projectRoot: string | undefined;
  let projectName: string | undefined;
  let backupSetName: string | undefined;
  let appdata = DEFAULT_APPDATA_DIR;
  let plan = false;
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
      case '--project': projectRoot = value(); break;
      case '--project-name': projectName = value(); break;
      case '--backup-set': backupSetName = value(); break;
      case '--appdata': appdata = value(); break;
      case '--confirm-digest': confirmDigest = value(); break;
      default: throw new Error(`unknown option: ${argument}`);
    }
  }
  if (projectRoot === undefined) throw new Error('--project is required');
  if (projectName === undefined) throw new Error('--project-name is required');
  if (backupSetName === undefined) throw new Error('--backup-set is required');
  if (plan === (confirmDigest !== null)) throw new Error('give exactly one of --plan or --confirm-digest');
  if (confirmDigest !== null && !/^[0-9a-f]{64}$/.test(confirmDigest)) {
    throw new Error('--confirm-digest must be the 64-character digest the plan printed');
  }
  return {
    projectRoot,
    projectName,
    backupSetName,
    appdata,
    plan,
    confirmDigest,
    hostStateDir: `${appdata}/sidecar/state`,
    hostRootKeyFile: `${appdata}/secrets/custodian_root_key`,
    hostStaticKeyFile: `${appdata}/secrets/custodian_kek`,
    hostBackupsDir: `${appdata}/backups`,
  } as ParsedCutoverArgs & { readonly appdata: string };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(usage());
    return argv.length === 0 ? CUTOVER_EXIT_USAGE : CUTOVER_EXIT_OK;
  }
  let args: ParsedCutoverArgs;
  try {
    args = parseCutoverArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error('');
    console.error(usage());
    return CUTOVER_EXIT_USAGE;
  }
  const deps = { runner: realCommandRunner(), ledger: new CommandLedger() };
  try {
    if (args.plan) {
      const planned = planCustodyCutover(args, deps);
      console.log('This would move this installation from STATIC bootstrap custody onto the sidecar-managed');
      console.log('KEK ring, and leave the stack on the canonical steady-state compose file.');
      console.log('');
      console.log(`  from custody mode  ${planned.fromMode}`);
      console.log(`  to custody mode    ${planned.toMode}`);
      console.log(`  backup set         ${planned.backupSetName} (verified, and proved to restore custody)`);
      console.log(`  stage              ${planned.stage === 'switch-only'
        ? 'RESUME: a ring is already there; this finishes the runtime switch only'
        : 'migrate, then switch the runtime selection'}`);
      console.log(`  migration digest   ${planned.migrationPlanDigest ?? 'none: no migration is left to run'}`);
      console.log('');
      console.log('NOTHING ABOUT THIS INSTALLATION HAS BEEN CHANGED BY PRINTING THIS. A one-shot container');
      console.log('was created to run the migration planner and was removed when it exited; no service was');
      console.log('stopped or started, no ring was written and no key file was touched.');
      console.log('');
      console.log('AFTER THIS, ROTATE. Adoption changes the custody MECHANISM, not the key: every wrapped key');
      console.log('stays under the key that was in a file until a rotation moves it.');
      console.log('');
      console.log(`plan digest: ${planned.planDigest}`);
      return CUTOVER_EXIT_OK;
    }
    const report = runCustodyCutover({ ...args, confirmDigest: args.confirmDigest }, deps);
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? CUTOVER_EXIT_OK : CUTOVER_EXIT_FAILED;
  } catch (err) {
    if (err instanceof CustodyCutoverFailed) {
      console.error(err.message);
      return CUTOVER_EXIT_FAILED;
    }
    if (err instanceof MaintenanceRefused) {
      console.error(err.message);
      return CUTOVER_EXIT_REFUSED;
    }
    // A MESSAGE, NEVER A STACK. A stack carries paths, and this command runs where the paths are the host's.
    console.error((err as Error).message);
    return CUTOVER_EXIT_FAILED;
  }
}

if (isDirectRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = CUTOVER_EXIT_FAILED; });
}
