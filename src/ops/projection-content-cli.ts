import { readFileSync } from 'node:fs';

import {
  ContentCommandError,
  addLocalObjects,
  addTorboxObjects,
  contentPreflight,
  contentStatus,
  createRealContentHost,
  holdContentEntry,
  parseContentConfig,
  publishContent,
  reconcileContent,
  releaseContentEntry,
  renderAdd,
  renderContentPreflight,
  renderHold,
  renderPublish,
  renderReconcile,
  renderStatus,
  type ContentPlaneConfig,
} from './projection-content.js';
import { assertSealedSafe, sealedProblems } from '../core/usenet/sealed.js';

// Projection Phase 10 D10.3 — the operator's entry point for the content plane. Argv parsing, and nothing else.
//
// WHAT IS DELIBERATELY NOT AN ARGUMENT: the opaque provider object reference. It arrives in a file whose mode
// is checked, because argv is visible to every process on the host through `/proc`, is recorded by every
// shell, and is printed in full by `docker inspect`.
// `deploy/real-provider-objects.template.json` calls that field unprintable and this command agrees with it.
//
// WHAT IS AN ARGUMENT: a PROJECTED PATH, for `hold` and `release`. That is namespace identity rather than
// content identity — the same distinction `status-report.ts` draws for an admitted entry — and it is the only
// handle an operator has for the entry they mean.
//
// EVERY DOCUMENT IS SCANNED BEFORE IT IS PRINTED, and so is the error path, which is the one path whose text
// this project does not write.

const USAGE = `usage: projection-content-cli.ts <verb> --config <path> [options]

verbs
  preflight                       everything wrong that can be seen before anything is written
  add-torbox --file <path>        register provider-backed objects from a 0600 file in
                                  deploy/real-provider-objects.template.json's shape. DOES NOT PUBLISH.
  add-local --file <path>         register local files under the media root. Their size, mtime and probe
                                  digests are READ FROM THE FILES, not typed. DOES NOT PUBLISH.
  publish                         mint a generation from what is registered. The only verb that publishes.
  reconcile                       report every divergence. IT CHANGES NOTHING.
  hold --path <projected path>    degrade one entry with operator-hold. It stays in the namespace.
  release --path <projected path> restore one held entry.
  status                          what is registered, what is published, and what is neither.

options
  --config <path>                 the content-plane configuration document (required by every verb)
  --file <path>                   the objects file, for add-torbox and add-local
  --path <projected path>         the entry, for hold and release
  --publish                       on add-torbox or add-local: publish afterwards, explicitly
  --since <timestamp>             on hold: when the hold was declared. Defaults to now.
  --json                          emit the document rather than the rendered lines
  --database-url <url>            override the control-plane connection string

NOTHING PUBLISHES IMPLICITLY. A registered entry is in the control plane and in no generation, so no media
server can see it until \`publish\` runs. Phase 9's runbook said otherwise and Phase 10 §2.2 is the correction.
`;

const VERBS = ['preflight', 'add-torbox', 'add-local', 'publish', 'reconcile', 'hold', 'release', 'status'] as const;
export type ContentVerb = (typeof VERBS)[number];

export interface ParsedArgs {
  readonly verb: ContentVerb;
  readonly configPath: string;
  readonly file?: string;
  readonly path?: string;
  readonly since?: string;
  readonly publish: boolean;
  readonly json: boolean;
  readonly databaseUrl?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb.startsWith('-')) {
    throw new ContentCommandError('USAGE', 'the first argument is the verb');
  }
  if (!(VERBS as readonly string[]).includes(verb)) {
    throw new ContentCommandError('USAGE', `unknown verb: ${verb}`);
  }

  let configPath: string | undefined;
  let file: string | undefined;
  let entryPath: string | undefined;
  let since: string | undefined;
  let databaseUrl: string | undefined;
  let publish = false;
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const takeValue = (): string => {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ContentCommandError('USAGE', `${String(flag)} needs a value`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case '--config': configPath = takeValue(); break;
      case '--file': file = takeValue(); break;
      case '--path': entryPath = takeValue(); break;
      case '--since': since = takeValue(); break;
      case '--database-url': databaseUrl = takeValue(); break;
      case '--publish': publish = true; break;
      case '--json': json = true; break;
      default: throw new ContentCommandError('USAGE', `unknown option: ${String(flag)}`);
    }
  }

  if (configPath === undefined) throw new ContentCommandError('USAGE', `${verb} needs --config`);
  if ((verb === 'add-torbox' || verb === 'add-local') && file === undefined) {
    throw new ContentCommandError('USAGE', `${verb} needs --file; an object reference is never an argument`);
  }
  if ((verb === 'hold' || verb === 'release') && entryPath === undefined) {
    throw new ContentCommandError('USAGE', `${verb} needs --path`);
  }
  // `--publish` ON A VERB THAT CANNOT PUBLISH IS A REFUSAL RATHER THAN A NO-OP. An operator who typed it
  // believed it would do something, and a flag silently ignored is a belief left in place.
  if (publish && verb !== 'add-torbox' && verb !== 'add-local') {
    throw new ContentCommandError('USAGE', `--publish means nothing on ${verb}; publishing is its own verb`);
  }

  return {
    verb: verb as ContentVerb,
    configPath,
    ...(file === undefined ? {} : { file }),
    ...(entryPath === undefined ? {} : { path: entryPath }),
    ...(since === undefined ? {} : { since }),
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    publish,
    json,
  };
}

export function loadConfig(path: string): ContentPlaneConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ContentCommandError('CONFIG_UNREADABLE', 'the content configuration could not be read as JSON');
  }
  return parseContentConfig(raw);
}

/**
 * The one line this command writes that it did not compose itself, held to the same rule as the ones it did.
 *
 * The reasoning is `usenet-command-cli.ts`'s, imported rather than re-derived: a `node:fs` rejection carries
 * the absolute path it failed on, a driver error can carry a connection string, and a `JSON.parse` failure
 * quotes its input. A message carrying one of those shapes is REPLACED rather than trimmed, because silently
 * removing the offending substring would leave a reader believing they had been told everything.
 */
function safeErrorMessage(error: unknown): string {
  const message = typeof (error as Error | undefined)?.message === 'string' ? (error as Error).message : '';
  if (message.length === 0) return 'the command failed without a message';
  if (sealedProblems(message).length > 0) {
    return 'the command failed, and its message carried a path, a URL or an identifier, so it was withheld '
      + 'rather than printed';
  }
  return message;
}

function emit(document: unknown, lines: readonly string[], json: boolean): void {
  assertSealedSafe(document, 'output');
  assertSealedSafe(lines, 'output');
  if (json) console.log(JSON.stringify(document, null, 2));
  else for (const line of lines) console.log(line);
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    return 2;
  }

  const host = createRealContentHost();

  try {
    const config = loadConfig(args.configPath);

    if (args.verb === 'preflight') {
      const problems = await contentPreflight(config, host, args.databaseUrl);
      emit(problems, renderContentPreflight(problems), args.json);
      return problems.length === 0 ? 0 : 1;
    }

    if (args.verb === 'status') {
      const document = await contentStatus(config, host, args.databaseUrl);
      emit(document, renderStatus(document), args.json);
      return 0;
    }

    if (args.verb === 'reconcile') {
      const report = await reconcileContent(config, host, args.databaseUrl);
      emit(report, renderReconcile(report), args.json);
      // A DIVERGENCE IS A NON-ZERO EXIT, because `reconcile` is what an operator puts on a timer and a timer
      // that reports success while the disk and the namespace disagree is a timer nobody reads. It still
      // changed nothing: the exit status is the report, not an action.
      return report.divergences.length === 0 ? 0 : 1;
    }

    if (args.verb === 'publish') {
      const report = await publishContent(config, args.databaseUrl);
      emit(report, renderPublish(report), args.json);
      return report.problems.length === 0 ? 0 : 1;
    }

    if (args.verb === 'hold' || args.verb === 'release') {
      const outcome = args.verb === 'hold'
        ? await holdContentEntry(args.path as string, args.since ?? new Date().toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z'), args.databaseUrl)
        : await releaseContentEntry(args.path as string, args.databaseUrl);
      emit(outcome, renderHold(outcome, args.verb), args.json);
      return 0;
    }

    const outcomes = args.verb === 'add-torbox'
      ? await addTorboxObjects(config, host, args.file as string, args.databaseUrl)
      : await addLocalObjects(config, host, args.file as string, args.databaseUrl);
    const lines = [...renderAdd(outcomes)];

    if (!args.publish) {
      emit(outcomes, lines, args.json);
      return 0;
    }

    // THE EXPLICIT PUBLISH. It is one flag and it is on the command the operator typed, which is the whole of
    // the difference between this and publishing implicitly.
    const report = await publishContent(config, args.databaseUrl);
    emit({ registered: outcomes, published: report }, [...lines, '', ...renderPublish(report)], args.json);
    return report.problems.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`${(error as ContentCommandError).code ?? 'ERROR'}: ${safeErrorMessage(error)}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('projection-content-cli.ts');
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`ERROR: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
