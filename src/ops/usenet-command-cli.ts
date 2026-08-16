import { readFileSync } from 'node:fs';

import {
  UsenetCommandError,
  parseUsenetConfig,
  preflight,
  renderPreflight,
  renderReconcile,
  renderStatusLines,
  runDiagnose,
  runReconcile,
  runStatus,
  runSubmit,
  type UsenetCommandConfig,
} from './usenet-command.js';
import { assertSealedSafe, sealedProblems } from '../core/usenet/sealed.js';

// Projection Phase 9 — the operator's entry point. Argv parsing, and nothing else.
//
// WHAT IS DELIBERATELY NOT AN ARGUMENT: the API key, the NZB or indexer URL, and the completed path. All
// three are read from files whose permissions are checked, because argv is visible to every process on the
// host through `/proc`, is recorded by every shell, and is printed in full by `docker inspect`. A tranche
// whose closure rule says those values appear in no preserved evidence cannot accept them on a command line.
//
// EVERY DOCUMENT IS SCANNED BEFORE IT IS PRINTED. `assertSealedSafe` runs over whatever is about to be
// written, whether as JSON or as lines, and throws rather than printing a structure that carries a URL, an
// absolute download path, an article id or a worker job id.

const USAGE = `usage: usenet-command-cli.ts <verb> --config <path> [options]

verbs
  preflight                       everything wrong that can be seen without contacting the worker
  submit --item <uuid> --source <path>
                                  submit one operator-approved NZB or indexer URL, exactly once, ever.
                                  The URL is read from <path>, never from this command line.
  status                          the closed-set lifecycle of every recorded job. Contacts nothing.
  reconcile [--job <prefix>]      the retry-safe verb: read the worker, advance every job, admit what is ready
  diagnose                        what every refusal means, what every bound is, what is still required

options
  --config <path>                 the usenet configuration document (required by every verb but diagnose)
  --json                          emit the document rather than the rendered lines
  --database-url <url>            override the control-plane connection string
`;

export interface ParsedArgs {
  readonly verb: 'preflight' | 'submit' | 'status' | 'reconcile' | 'diagnose';
  readonly configPath?: string;
  readonly itemId?: string;
  readonly sourceFile?: string;
  readonly job?: string;
  readonly json: boolean;
  readonly databaseUrl?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb.startsWith('-')) {
    throw new UsenetCommandError('USAGE', 'the first argument is the verb');
  }
  if (verb !== 'preflight' && verb !== 'submit' && verb !== 'status' && verb !== 'reconcile' && verb !== 'diagnose') {
    throw new UsenetCommandError('USAGE', `unknown verb: ${verb}`);
  }

  let configPath: string | undefined;
  let itemId: string | undefined;
  let sourceFile: string | undefined;
  let job: string | undefined;
  let databaseUrl: string | undefined;
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const takeValue = (): string => {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsenetCommandError('USAGE', `${String(flag)} needs a value`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case '--config': configPath = takeValue(); break;
      case '--item': itemId = takeValue(); break;
      case '--source': sourceFile = takeValue(); break;
      case '--job': job = takeValue(); break;
      case '--database-url': databaseUrl = takeValue(); break;
      case '--json': json = true; break;
      default: throw new UsenetCommandError('USAGE', `unknown option: ${String(flag)}`);
    }
  }

  if (verb !== 'diagnose' && configPath === undefined) {
    throw new UsenetCommandError('USAGE', `${verb} needs --config`);
  }
  if (verb === 'submit' && (itemId === undefined || sourceFile === undefined)) {
    throw new UsenetCommandError('USAGE', 'submit needs --item and --source');
  }

  return {
    verb,
    ...(configPath === undefined ? {} : { configPath }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(sourceFile === undefined ? {} : { sourceFile }),
    ...(job === undefined ? {} : { job }),
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    json,
  };
}

export function loadConfig(path: string): UsenetCommandConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new UsenetCommandError('CONFIG_UNREADABLE', 'the usenet configuration could not be read as JSON');
  }
  return parseUsenetConfig(raw);
}

/**
 * The one line this command writes that it did not compose itself, held to the same rule as the ones it did.
 *
 * `emit` scans every DOCUMENT before printing it, and that was the whole of the guarantee — which left the
 * error path, the one path whose text this project does not write. A `node:fs` rejection carries the absolute
 * path it failed on; a driver error can carry a connection string; a `JSON.parse` failure quotes the input.
 * Every one of those is exactly the shape closure rule 9 says appears in no preserved evidence, and an
 * operator's terminal scrollback is where this tranche's evidence is collected from.
 *
 * So a message that carries one of the shapes `sealedProblems` recognises is REPLACED, not rewritten: the
 * code still names what went wrong, and the codes are constants. Silently trimming the offending substring
 * would leave a reader believing they had been told everything.
 */
function safeErrorMessage(error: unknown): string {
  const message = typeof (error as Error | undefined)?.message === 'string' ? (error as Error).message : '';
  if (message.length === 0) return 'the command failed without a message';
  if (sealedProblems(message).length > 0) {
    return 'the command failed, and its message carried a path, a URL or a worker identifier, so it was '
      + 'withheld rather than printed';
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

  try {
    if (args.verb === 'diagnose') {
      const document = runDiagnose();
      emit(document, [
        'projection phase 9 — usenet diagnostics',
        '',
        'lifecycle',
        ...document.lifecycle.map((row) => `  ${row.state.padEnd(15)} ${row.meaning}`),
        '',
        'refusals',
        ...document.refusals.map((row) => `  ${row.reason.padEnd(32)} ${row.transient ? '[retryable]' : '[operator]'} ${row.meaning}`),
        '',
        'bounds',
        ...Object.entries(document.bounds).map(([key, value]) => `  ${key.padEnd(20)} ${value}`),
        '',
        'this phase will never',
        ...document.hardRefusals.map((rule) => `  - ${rule}`),
        '',
        'still required from the operator before the provider half can run',
        ...document.operatorInputsStillRequired.map((input) => `  - ${input}`),
      ], args.json);
      return 0;
    }

    const config = loadConfig(args.configPath as string);

    if (args.verb === 'preflight') {
      const problems = await preflight(config);
      emit(problems, renderPreflight(problems), args.json);
      return problems.length === 0 ? 0 : 1;
    }

    if (args.verb === 'status') {
      const document = runStatus(config);
      emit(document, renderStatusLines(document), args.json);
      return 0;
    }

    if (args.verb === 'submit') {
      const outcome = await runSubmit(config, {
        sourceFile: args.sourceFile as string,
        itemId: args.itemId as string,
      }, args.databaseUrl);
      emit(outcome, [
        `submission ${outcome.key.slice(0, 11)}: ${outcome.outcome}`,
        `  state=${outcome.state} source=${outcome.sourceFingerprint}`,
        ...(outcome.reason === undefined ? [] : [`  ${outcome.reason}: ${outcome.detail ?? ''}`]),
      ], args.json);
      return outcome.outcome === 'refused' ? 1 : 0;
    }

    const outcomes = await runReconcile(config, args.job, args.databaseUrl);
    emit(outcomes, ['projection phase 9 — reconciliation', ...renderReconcile(outcomes)], args.json);
    // A REFUSAL THAT NEEDS AN OPERATOR IS A NON-ZERO EXIT; a transient one is not. Reconciliation runs on a
    // timer, and a timer that reports failure every time a download is still downloading is a timer nobody
    // reads.
    return outcomes.some((outcome) => outcome.state === 'refused') ? 1 : 0;
  } catch (error) {
    console.error(`${(error as UsenetCommandError).code ?? 'ERROR'}: ${safeErrorMessage(error)}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('usenet-command-cli.ts');
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`ERROR: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
