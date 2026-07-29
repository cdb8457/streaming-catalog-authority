import { CatalogExportError } from '../core/catalog/external-export.js';
import { CatalogImportError } from '../core/catalog/import-snapshot.js';
import {
  CATALOG_IMPORT_DIR_ENV,
  CatalogImportPathError,
  readCatalogSnapshotText,
  resolveImportFile,
} from './catalog-import.js';
import {
  SNAPSHOT_OUT_DIR_ENV,
  SnapshotProducePathError,
  produceSnapshotFile,
  renderSnapshotProduction,
  resolveProducedSnapshotPath,
} from './catalog-snapshot-produce.js';
import { isDirectRun } from './direct-run.js';

// Phase 274 — `npm run ops:catalog-snapshot-produce`.
//
// THE STEP BEFORE THE IMPORT. Phase 259 gave an operator a file format and told them to write it. This turns
// a file their OTHER system already produced into that format, deterministically, without either system
// contacting the other.
//
// IT READS ONE FILE THE OPERATOR NAMED AND WRITES ONE FILE THE OPERATOR NAMED. No directory is walked, no
// media path is scanned, no provider, media server, download client or network endpoint is contacted, and no
// process is spawned. This CLI opens exactly two paths and imports nothing that could open a third.
//
// PREVIEW IS AVAILABLE AND WRITING IS EXPLICIT. `--preview` produces the whole document in memory and prints
// its digests, having written nothing — so an operator can see what an export would become, and compare the
// content digest, before a file exists anywhere.
//
// NOTHING IS IMPORTED. Producing a snapshot puts a file on disk. Reading it into the catalog is
// `ops:catalog-import`, unchanged, with its own preview and its own apply. Two commands, because "produce"
// and "commit to the database" are different decisions and a single command would make the second one
// invisible.

export const SNAPSHOT_PRODUCE_EXIT_OK = 0;
export const SNAPSHOT_PRODUCE_EXIT_FAILED = 1;
export const SNAPSHOT_PRODUCE_EXIT_USAGE = 2;
export const SNAPSHOT_PRODUCE_EXIT_REJECTED = 3;

function usage(): string {
  return [
    'usage: npm run ops:catalog-snapshot-produce -- --from <export.json> (--out <snapshot.json> | --preview)',
    '',
    'Turns a local export from an external system into the canonical Catalog Authority import snapshot.',
    '',
    'options:',
    '  --from <name>   the export to read. Relative names resolve inside ' + CATALOG_IMPORT_DIR_ENV + '.',
    '  --out <name>    where to write the snapshot. A plain .json name when ' + SNAPSHOT_OUT_DIR_ENV + ' is set.',
    '  --preview       produce the document in memory and print its digests. Writes nothing.',
    '  --overwrite     replace an existing file of that name (default: refuse).',
    '  --json          print the machine-readable report instead of the summary',
    '',
    'It contacts no provider, media server, download client, library or network endpoint, downloads nothing,',
    'and creates no symbolic link. An export carrying acquisition data — a download URL, an NZB or torrent',
    'identifier, a tracker, or an absolute media path — is REFUSED whole rather than filtered.',
    '',
    'The snapshot is written atomically: the name holds either the previous file or the complete new one.',
    'Output is redaction-safe: no title, reference value, attribute value or path is ever printed.',
    '',
    'exit codes: 0 produced | 1 the write failed | 2 bad usage | 3 the export or the path was rejected',
  ].join('\n');
}

export interface ParsedProduceArgs {
  readonly from: string;
  readonly out: string | null;
  readonly preview: boolean;
  readonly overwrite: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

export class SnapshotProduceUsageError extends Error {
  readonly code = 'CATALOG_SNAPSHOT_USAGE_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'SnapshotProduceUsageError';
  }
}

/** Strict: an unknown flag is a usage error, and a flag that needs a value never swallows the next flag. */
export function parseProduceArgs(argv: readonly string[]): ParsedProduceArgs {
  let from: string | undefined;
  let out: string | null = null;
  let preview = false;
  let overwrite = false;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--preview': preview = true; break;
      case '--overwrite': overwrite = true; break;
      case '--json': json = true; break;
      case '--help': case '-h': help = true; break;
      case '--from': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new SnapshotProduceUsageError('--from needs a value');
        from = value;
        i += 1;
        break;
      }
      case '--out': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new SnapshotProduceUsageError('--out needs a value');
        out = value;
        i += 1;
        break;
      }
      default: throw new SnapshotProduceUsageError(`unknown option: ${arg}`);
    }
  }
  if (!help) {
    if (from === undefined || from.trim() === '') throw new SnapshotProduceUsageError('--from is required');
    // EXACTLY ONE of the two, so "I meant to write it" and "I meant to look at it" can never be the same
    // command with a flag somebody forgot.
    if (preview && out !== null) throw new SnapshotProduceUsageError('--preview writes nothing, so it takes no --out');
    if (!preview && out === null) throw new SnapshotProduceUsageError('--out is required (or use --preview, which writes nothing)');
    if (preview && overwrite) throw new SnapshotProduceUsageError('--preview writes nothing, so --overwrite means nothing');
  }
  return { from: from ?? '', out, preview, overwrite, json, help };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: ParsedProduceArgs;
  try {
    args = parseProduceArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error('');
    console.error(usage());
    return SNAPSHOT_PRODUCE_EXIT_USAGE;
  }
  if (args.help) {
    console.log(usage());
    return SNAPSHOT_PRODUCE_EXIT_OK;
  }

  try {
    // The INPUT is resolved exactly as an import file is: contained inside CATALOG_IMPORT_DIR when one is
    // configured, and read through the same bounded regular-file guard. An operator's export arrives in the
    // same read-only folder their snapshots do, because it is the same kind of thing — a file they put there.
    const inputPath = resolveImportFile(args.from);
    const text = readCatalogSnapshotText(inputPath);
    // The OUTPUT path is resolved BEFORE the document is produced, so a bad destination costs nothing and a
    // produced document is never held while waiting to find out where it goes.
    const output = args.out === null ? undefined : resolveProducedSnapshotPath(args.out);
    const result = produceSnapshotFile({
      text,
      ...(output === undefined ? {} : { output }),
      overwrite: args.overwrite,
    });
    console.log(args.json ? JSON.stringify(result, null, 2) : renderSnapshotProduction(result));
    return SNAPSHOT_PRODUCE_EXIT_OK;
  } catch (err) {
    if (err instanceof CatalogExportError) {
      console.error('The export was rejected. Nothing was written.');
      for (const problem of err.problems) console.error(`  - ${problem}`);
      return SNAPSHOT_PRODUCE_EXIT_REJECTED;
    }
    if (err instanceof CatalogImportError) {
      // The export's SIZE guard, or the produced document failing the importer's own parse. Either way the
      // problems are field-and-position only.
      console.error('The export was rejected. Nothing was written.');
      for (const problem of err.problems) console.error(`  - ${problem}`);
      return SNAPSHOT_PRODUCE_EXIT_REJECTED;
    }
    if (err instanceof CatalogImportPathError || err instanceof SnapshotProducePathError) {
      console.error(err.message);
      return SNAPSHOT_PRODUCE_EXIT_REJECTED;
    }
    throw err;
  }
}

// ONLY WHEN THIS FILE IS THE PROGRAM. Importing this module must not read a file, write one, or touch the
// exit code of somebody else's process. See direct-run.ts.
if (isDirectRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = SNAPSHOT_PRODUCE_EXIT_FAILED;
  });
}
