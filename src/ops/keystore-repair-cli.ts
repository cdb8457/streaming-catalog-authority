import { isDirectRun } from './direct-run.js';
import {
  KeystoreRepairError,
  type KeystoreRepairResult,
  renderKeystoreRepairResult,
  repairKeystore,
  resolveKeystoreOwner,
} from './keystore-repair.js';

// Phase 263 — `npm run ops:keystore-check` and `npm run ops:keystore-repair`.
//
// TWO SCRIPT NAMES, ONE PROGRAM. The difference between them is a single flag, and the flag is the difference
// between "tell me" and "do it". A tool that repairs by default is a tool somebody runs to find out what is
// wrong and then has to undo.
//
// THE REPAIR IS THE ONLY THING IN THIS PRODUCT THAT WANTS ELEVATED FILESYSTEM AUTHORITY, and it is confined to
// a one-shot container that holds nothing else: no database URL, no secrets, no network, and only the keystore
// volume mounted. The long-running app is untouched — still non-root, still read-only rootfs, still every
// capability dropped. See docker-compose.runtime.yml's `keystore-prepare` service.
//
// IT NEVER READS OR WRITES KEY MATERIAL. Ownership and, on the keystore root, permission bits. That is all.

export const KEYSTORE_EXIT_OK = 0;
export const KEYSTORE_EXIT_REFUSED = 1;
export const KEYSTORE_EXIT_USAGE = 2;

export const KEYSTORE_DIR_ENV = 'CUSTODIAN_KEYSTORE_DIR';
export const KEYSTORE_OWNER_ENV = 'CATALOG_KEYSTORE_OWNER';
/** The user the shipped production image runs its long-running process as. */
export const KEYSTORE_DEFAULT_OWNER = 'node';

function usage(): string {
  return [
    'usage: npm run ops:keystore-check  [-- --dir <path>] [--owner <name|uid[:gid]>] [--json]',
    '       npm run ops:keystore-repair [-- --dir <path>] [--owner <name|uid[:gid]>] [--json]',
    '',
    'Checks — and, for ops:keystore-repair, fixes — the OWNERSHIP of the custodian keystore directory.',
    '',
    'Why it exists: Docker creates a fresh named volume owned by root, while the container runs as an',
    'unprivileged user. An installation created before this was fixed in the image still has a root-owned',
    'keystore that the app cannot write, and no image change can reach back into an existing volume.',
    '',
    'options:',
    `  --dir <path>    the keystore directory. Defaults to ${KEYSTORE_DIR_ENV}.`,
    `  --owner <who>   the user it must belong to. Defaults to ${KEYSTORE_OWNER_ENV}, then "${KEYSTORE_DEFAULT_OWNER}".`,
    '  --repair        change ownership. Without it this only reports, and writes nothing.',
    '  --json          print the machine-readable report instead of the summary',
    '',
    'It changes ownership and permissions ONLY. It never reads, writes, moves or deletes key material,',
    'never regenerates a secret, and never destroys or recreates a volume. An ownership or content state it',
    'does not understand is refused, with nothing changed.',
    '',
    'Output is redaction-safe: counts, uids and a mode. No file name, no path beyond the directory you named,',
    'and no file content is ever printed.',
    '',
    'exit codes: 0 correct (or repaired) | 1 refused, or a repair is needed and was not run | 2 bad usage',
  ].join('\n');
}

export interface ParsedKeystoreArgs {
  readonly dir: string;
  readonly owner: string;
  readonly repair: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

export class KeystoreUsageError extends Error {
  readonly code = 'KEYSTORE_USAGE_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'KeystoreUsageError';
  }
}

/** Strict: an unknown flag is a usage error, and a flag that needs a value never swallows the next flag. */
export function parseKeystoreArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedKeystoreArgs {
  let dir: string | undefined;
  let owner: string | undefined;
  let repair = false;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--repair': repair = true; break;
      case '--check': repair = false; break;
      case '--json': json = true; break;
      case '--help': case '-h': help = true; break;
      case '--dir': case '--owner': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new KeystoreUsageError(`${arg} needs a value`);
        if (arg === '--dir') dir = value; else owner = value;
        i += 1;
        break;
      }
      default: throw new KeystoreUsageError(`unknown option: ${arg}`);
    }
  }
  const resolvedDir = dir ?? env[KEYSTORE_DIR_ENV] ?? '';
  const resolvedOwner = owner ?? env[KEYSTORE_OWNER_ENV] ?? KEYSTORE_DEFAULT_OWNER;
  if (!help && resolvedDir.trim() === '') {
    throw new KeystoreUsageError(`no keystore directory: pass --dir or set ${KEYSTORE_DIR_ENV}`);
  }
  return { dir: resolvedDir, owner: resolvedOwner, repair, json, help };
}

/**
 * The exit code for a result.
 *
 * A CHECK that finds work to do exits non-zero on purpose. It is what makes the check usable as a gate: a
 * preflight that reports "your keystore is unwritable" and exits 0 is a preflight nothing can depend on.
 */
export function keystoreExitCode(result: KeystoreRepairResult): number {
  if (!result.ok) return KEYSTORE_EXIT_REFUSED;
  return result.action === 'NONE' ? KEYSTORE_EXIT_OK : KEYSTORE_EXIT_REFUSED;
}

export function runKeystoreCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  let args: ParsedKeystoreArgs;
  try {
    args = parseKeystoreArgs(argv, env);
  } catch (err) {
    console.error((err as Error).message);
    console.error('');
    console.error(usage());
    return KEYSTORE_EXIT_USAGE;
  }
  if (args.help) {
    console.log(usage());
    return KEYSTORE_EXIT_OK;
  }

  let result: KeystoreRepairResult;
  try {
    const owner = resolveKeystoreOwner(args.owner);
    result = repairKeystore(args.dir, owner, { mode: args.repair ? 'repair' : 'check' });
  } catch (err) {
    if (err instanceof KeystoreRepairError) {
      console.error(err.message);
      return KEYSTORE_EXIT_USAGE;
    }
    throw err;
  }

  console.log(args.json ? JSON.stringify(result, null, 2) : renderKeystoreRepairResult(result));
  return keystoreExitCode(result);
}

// ONLY WHEN THIS FILE IS THE PROGRAM — the suite imports the parser from here, and importing a module must
// not touch somebody else's exit code or filesystem. See direct-run.ts.
if (isDirectRun(import.meta.url)) {
  try {
    process.exitCode = runKeystoreCli(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = KEYSTORE_EXIT_REFUSED;
  }
}
