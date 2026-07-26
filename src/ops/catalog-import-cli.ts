import { CatalogAuthority } from '../core/catalog/authority.js';
import { CatalogImportError } from '../core/catalog/import-snapshot.js';
import { createCustodian, loadCustodianConfig } from '../core/crypto/custodian-factory.js';
import { closePool, getPool } from '../db/pool.js';
import { isDirectRun } from './direct-run.js';
import {
  CATALOG_IMPORT_DIR_ENV,
  CatalogImportPathError,
  createExistingStateLookup,
  renderCatalogImportResult,
} from './catalog-import.js';
import { applyImport, previewImport, readCliSnapshot } from './catalog-import-service.js';
import { createImportHistoryStore } from './import-history.js';

// Phase 259 — `npm run ops:catalog-import`.
//
// DRY RUN IS THE DEFAULT. Without `--apply` this reads the file, checks it against the database and prints
// exactly what would happen, having written nothing. An operator's first contact with their own data going
// into a system should not be a command that has already done it.

export const CATALOG_IMPORT_EXIT_OK = 0;
export const CATALOG_IMPORT_EXIT_INCOMPLETE = 1;
export const CATALOG_IMPORT_EXIT_USAGE = 2;
export const CATALOG_IMPORT_EXIT_REJECTED = 3;

function usage(): string {
  return [
    'usage: npm run ops:catalog-import -- --file <snapshot.json> [--apply] [--update-existing] [--json]',
    '',
    'Imports an offline catalog snapshot into this installation\'s own database.',
    '',
    'options:',
    '  --file <name>       the snapshot to read. Relative names resolve inside ' + CATALOG_IMPORT_DIR_ENV + '.',
    '  --apply             actually write. Without it this is a preview and nothing is written.',
    '  --update-existing   rewrite the identity of records that are already present (default: leave them alone)',
    '  --continue-on-error keep going past a record that fails (default: stop and report)',
    '  --json              print the machine-readable report instead of the summary',
    '',
    'It reads one file and contacts no provider, media server, library or network endpoint.',
    'Output is redaction-safe: no title, provider ref value, external id or path is ever printed.',
    '',
    'exit codes: 0 complete | 1 applied with failures | 2 bad usage | 3 the snapshot was rejected',
  ].join('\n');
}

export interface ParsedImportArgs {
  readonly file: string;
  readonly apply: boolean;
  readonly updateExisting: boolean;
  readonly continueOnError: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

export class CatalogImportUsageError extends Error {
  readonly code = 'CATALOG_IMPORT_USAGE_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'CatalogImportUsageError';
  }
}

/** Strict: an unknown flag is a usage error, and a flag that needs a value never swallows the next flag. */
export function parseCatalogImportArgs(argv: readonly string[]): ParsedImportArgs {
  let file: string | undefined;
  let apply = false;
  let updateExisting = false;
  let continueOnError = false;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--apply': apply = true; break;
      case '--update-existing': updateExisting = true; break;
      case '--continue-on-error': continueOnError = true; break;
      case '--json': json = true; break;
      case '--help': case '-h': help = true; break;
      case '--file': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new CatalogImportUsageError('--file needs a value');
        file = value;
        i += 1;
        break;
      }
      default: throw new CatalogImportUsageError(`unknown option: ${arg}`);
    }
  }
  if (!help && (file === undefined || file.trim() === '')) throw new CatalogImportUsageError('--file is required');
  return { file: file ?? '', apply, updateExisting, continueOnError, json, help };
}

async function main(): Promise<number> {
  let args: ParsedImportArgs;
  try {
    args = parseCatalogImportArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error('');
    console.error(usage());
    return CATALOG_IMPORT_EXIT_USAGE;
  }
  if (args.help) {
    console.log(usage());
    return CATALOG_IMPORT_EXIT_OK;
  }

  // Resolve and validate the whole document BEFORE a database connection is opened. A rejected snapshot
  // should not have caused a connection, a custodian handshake, or any observable effect at all.
  let snapshot: ReturnType<typeof readCliSnapshot>;
  try {
    snapshot = readCliSnapshot(args.file);
  } catch (err) {
    if (err instanceof CatalogImportError) {
      console.error('The snapshot was rejected. Nothing was read into the database.');
      for (const problem of err.problems) console.error(`  - ${problem}`);
      return CATALOG_IMPORT_EXIT_REJECTED;
    }
    if (err instanceof CatalogImportPathError) {
      console.error(err.message);
      return CATALOG_IMPORT_EXIT_REJECTED;
    }
    throw err;
  }

  const pool = getPool();
  const lookup = createExistingStateLookup(pool);
  try {
    if (!args.apply) {
      // Phase 264. The SAME function the browser's preview calls. There is no second implementation of
      // "what would this do" for the two surfaces to drift apart on.
      const previewed = await previewImport({ text: snapshot.text, lookup, updateExisting: args.updateExisting });
      console.log(args.json ? JSON.stringify(previewed.result, null, 2) : renderCatalogImportResult(previewed.result));
      return CATALOG_IMPORT_EXIT_OK;
    }
    // The custodian is created only for a real apply: a preview provisions no key and holds no key material.
    const authority = new CatalogAuthority(pool, createCustodian(loadCustodianConfig()));
    const applied = await applyImport({
      text: snapshot.text,
      lookup,
      authority,
      // Phase 264. The command line records what it did in the same durable history the browser writes to,
      // so an operator who uses both surfaces has ONE answer to "what have I loaded", not two partial ones.
      history: createImportHistoryStore(pool),
      actor: 'cli',
      fileName: snapshot.fileName,
      updateExisting: args.updateExisting,
      continueOnError: args.continueOnError,
    });
    console.log(args.json ? JSON.stringify(applied.result, null, 2) : renderCatalogImportResult(applied.result));
    if (!applied.recorded) {
      // Said on stderr, and it does NOT change the exit code: the catalog write happened, and reporting an
      // import as failed because its audit row did not land would be a worse lie than an incomplete history.
      console.error('note: the records were imported, but this import could not be added to the import history.');
    }
    return applied.result.ok ? CATALOG_IMPORT_EXIT_OK : CATALOG_IMPORT_EXIT_INCOMPLETE;
  } finally {
    await closePool();
  }
}

// ONLY WHEN THIS FILE IS THE PROGRAM. `test/catalog-import.ts` imports `parseCatalogImportArgs` from here,
// and without this guard that import RAN the command: invoked as `tsx test/catalog-import.ts 5453`, the
// suite's own port argument reached this parser, which printed `unknown option: 5453` and its usage and set
// `process.exitCode = 2` on a passing run. Importing a module must not open a database, read a file, write to
// a stream or touch the exit code of somebody else's process. See direct-run.ts.
if (isDirectRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(async (err: unknown) => {
    await closePool().catch(() => undefined);
    // The message comes from the authority or the driver and carries no identity; the stack does not go to
    // stdout, where a report is read from.
    console.error((err as Error).message);
    process.exitCode = CATALOG_IMPORT_EXIT_INCOMPLETE;
  });
}
