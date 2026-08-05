import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { findRedactionProblems, type GateResult } from '../core/projection/media-server-dataplane.js';
import {
  LIFECYCLE_SERVERS, additionResults, deletionResults, refusalResults, seedResults, sequenceResults,
  stillPresentResults, watchStateObservations,
  type InventoryItem, type ServerInventory,
} from '../core/projection/path-lifecycle.js';
import * as jellyfin from './projection-jellyfin-dataplane.js';
import * as plex from './projection-plex-dataplane.js';
import * as emby from './projection-emby-dataplane.js';

// Projection Phase 1 — G27's three-server half, from the command line.
//
// THE SHELL DRIVES THE WORLD AND THIS DECIDES WHAT IT MEANT. The gate script publishes generations and forges
// the illegal one, because those are the control plane; every verdict is taken here against the rules in
// `core/projection/path-lifecycle.ts`.
//
// IT BUILDS ITS OWN INVENTORY RATHER THAN REUSING G18'S CATALOGUE, and the reason is one field. G18's
// `CatalogueEntry` carries a path, a size and an ordinary-file verdict — everything a concurrency gate needs.
// G27 is about IDENTITY across a delete and an add, so it needs each server's own item id too, and adding a
// field to G18's shared type would be an executable change to a gate that has already run three times.
//
//   scan        --state-<id> F x3 --out F            scan all three, then inventory all three
//   inventory   --state-<id> F x3 --out F            inventory all three WITHOUT scanning
//   seed        --after F --path A --generation G [--gate NAME]
//   refusal     --before F --after F --path-a A --path-b B --generation-before G --generation-after G
//   still-there --before F --after F --path A --generation G --readable B
//   deletion    --before F --after F --path A --generation G
//   addition    --before F --after F --path B --generation G --size N --digest-ok B
//   watch-state --observations F
//   sequence    --generations F
//   report      --results F [--json F]

class GateFailure extends Error {}

function fail(message: string): never {
  console.error(`projection-path-lifecycle: ${message}`);
  process.exit(1);
}

interface Args { readonly command: string; readonly flags: ReadonlyMap<string, string> }

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0] ?? '';
  const flags = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const eq = token.indexOf('=');
    if (eq !== -1) { flags.set(token.slice(2, eq), token.slice(eq + 1)); continue; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { flags.set(token.slice(2), 'true'); continue; }
    flags.set(token.slice(2), next);
    index += 1;
  }
  return { command, flags };
}

function need(args: Args, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined || value === '') fail(`--${name} is required`);
  return value;
}

const boolFlag = (args: Args, name: string): boolean => need(args, name) === 'true';

function appendResult(path: string, result: GateResult): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = `${JSON.stringify(result)}\n`;
  writeFileSync(path, existsSync(path) ? readFileSync(path, 'utf8') + line : line);
}

function record(args: Args, result: GateResult): void {
  const path = args.flags.get('results');
  if (path !== undefined) appendResult(path, result);
  const measured = result.measured === undefined ? '' : ` measured=${result.measured} budget=${result.budget}`;
  console.log(`  ${result.verdict.toUpperCase()}  ${result.gate}${measured}`
    + `${result.note ? ` — ${result.note}` : ''}`);
  if (result.verdict === 'fail') throw new GateFailure(`${result.gate} failed`);
}

const recordAll = (args: Args, results: readonly GateResult[]): void => {
  for (const result of results) record(args, result);
};

// ---------------------------------------------------------------------------------------------------------
// THREE ORDINARY-FILE PREDICATES, ONE PER SERVER, DELIBERATELY NOT SHARED.
//
// `projection-three-server-concurrency.ts` explains why at length and the reasoning is unchanged here:
// Jellyfin reads `locationType === 'FileSystem'`, a field Emby omits entirely; Emby reads a media-source type
// instead; Plex has neither and reads `accessible`/`exists` off a `checkFiles=1` response. The one time this
// repository flattened them, the flattened predicate matched zero of two correctly catalogued entries.
// ---------------------------------------------------------------------------------------------------------

function jellyfinProblems(item: jellyfin.ItemRecord): string[] {
  const problems: string[] = [];
  if (item.protocol !== 'File') problems.push(`protocol is "${item.protocol}", not File`);
  if (item.isRemote) problems.push('the server calls the media source remote');
  if (item.key.endsWith('.strm')) problems.push('a .strm placeholder is not a projected file');
  if (item.locationType !== 'FileSystem') problems.push(`locationType is "${item.locationType}"`);
  if (!item.supportsDirectPlay) problems.push('the server says it cannot direct-play the file');
  return problems;
}

function embyProblems(item: emby.ItemRecord): string[] {
  const problems: string[] = [];
  if (item.protocol !== 'File') problems.push(`protocol is "${item.protocol}", not File`);
  if (item.isRemote) problems.push('the server calls the media source remote');
  if (item.key.endsWith('.strm')) problems.push('a .strm placeholder is not a projected file');
  if (!item.supportsDirectPlay) problems.push('the server says it cannot direct-play the file');
  return problems;
}

function plexProblems(item: plex.ItemRecord): string[] {
  const problems: string[] = [];
  if (!item.accessible) problems.push('the server could not stat the file through the mount');
  if (!item.exists) problems.push('the server says the file does not exist');
  if (item.key.endsWith('.strm')) problems.push('a .strm placeholder is not a projected file');
  return problems;
}

// THE STATE FILE IS NAMED EXPLICITLY PER SERVER, not derived from a directory, and the missing case has its
// own message. A gate that derived `${dir}/${server}.json` and found nothing would report "0 items" — which
// is indistinguishable from a server that scanned correctly and catalogued nothing, and would pass a
// deletion assertion for the wrong reason.
function statePath(args: Args, server: string): string {
  const path = need(args, `state-${server}`);
  if (!existsSync(path)) fail(`the ${server} state file is missing; its own bootstrap did not run`);
  return path;
}

async function inventoryOf(server: string, path: string): Promise<ServerInventory> {
  let items: InventoryItem[];
  if (server === 'jellyfin') {
    const state = jellyfin.readState(path);
    items = (await jellyfin.listMovies(state)).map((item) => ({
      key: item.key, itemId: item.itemId, sizeBytes: item.sizeBytes,
      ordinaryFile: jellyfinProblems(item).length === 0, problems: jellyfinProblems(item),
    }));
  } else if (server === 'emby') {
    const state = emby.readState(path);
    items = (await emby.listMovies(state)).map((item) => ({
      key: item.key, itemId: item.itemId, sizeBytes: item.sizeBytes,
      ordinaryFile: embyProblems(item).length === 0, problems: embyProblems(item),
    }));
  } else {
    const state = plex.readState(path);
    // PLEX'S STABLE IDENTITY IS ITS ratingKey, which is what its own churn assertions are measured on.
    items = (await plex.listMovies(state)).map((item) => ({
      key: item.key, itemId: item.ratingKey, sizeBytes: item.sizeBytes,
      ordinaryFile: plexProblems(item).length === 0, problems: plexProblems(item),
    }));
  }
  return { server, generationId: '', items };
}

async function scanOne(server: string, path: string): Promise<void> {
  if (server === 'jellyfin') {
    await jellyfin.scanLibrary(jellyfin.readState(path));
  } else if (server === 'emby') {
    await emby.scanLibrary(emby.readState(path));
  } else {
    await plex.scanLibrary(plex.readState(path));
  }
}

async function gather(args: Args, scan: boolean): Promise<void> {
  const generationId = args.flags.get('generation') ?? '';
  const inventories: ServerInventory[] = [];
  for (const server of LIFECYCLE_SERVERS) {
    const path = statePath(args, server);
    // EACH SERVER'S OWN COMPLETION BARRIER, one at a time. G27 is a sequence, not a concurrency gate: what
    // matters is that the scan the gate asked for FINISHED before the listing is taken, so a stale inventory
    // cannot be read as a fresh one.
    if (scan) await scanOne(server, path);
    const inventory = await inventoryOf(server, path);
    inventories.push({ ...inventory, generationId });
    console.log(`  ${server}: ${inventory.items.length} item(s)`);
  }
  writeFileSync(need(args, 'out'), `${JSON.stringify(inventories, null, 2)}\n`);
}

const readInventories = (path: string): ServerInventory[] =>
  JSON.parse(readFileSync(path, 'utf8')) as ServerInventory[];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'scan': { await gather(args, true); return; }
    case 'inventory': { await gather(args, false); return; }

    case 'seed': {
      recordAll(args, seedResults(args.flags.get('gate') ?? 'L1-seed', readInventories(need(args, 'after')),
        { pathA: need(args, 'path'), generationId: need(args, 'generation') }));
      return;
    }

    case 'refusal': {
      recordAll(args, refusalResults('L2-refusal', readInventories(need(args, 'before')),
        readInventories(need(args, 'after')), {
          generationBefore: need(args, 'generation-before'),
          generationAfter: need(args, 'generation-after'),
          pathA: need(args, 'path-a'), pathB: need(args, 'path-b'),
        }));
      return;
    }

    case 'still-there': {
      recordAll(args, stillPresentResults(need(args, 'gate'), readInventories(need(args, 'before')),
        readInventories(need(args, 'after')), {
          pathA: need(args, 'path'), generationId: need(args, 'generation'),
          readable: boolFlag(args, 'readable'),
        }));
      return;
    }

    case 'deletion': {
      recordAll(args, deletionResults('L5-deletion', readInventories(need(args, 'before')),
        readInventories(need(args, 'after')),
        { pathA: need(args, 'path'), generationId: need(args, 'generation') }));
      return;
    }

    case 'addition': {
      recordAll(args, additionResults('L6-addition', readInventories(need(args, 'before')),
        readInventories(need(args, 'after')), {
          pathB: need(args, 'path'), generationId: need(args, 'generation'),
          sizeBytes: Number(need(args, 'size')), digestMatched: boolFlag(args, 'digest-ok'),
        }));
      return;
    }

    case 'watch-state': {
      const observations = JSON.parse(readFileSync(need(args, 'observations'), 'utf8')) as
        { server: string; preserved: boolean | undefined; detail: string }[];
      recordAll(args, watchStateObservations('L7', observations));
      return;
    }

    case 'sequence': {
      const generations = JSON.parse(readFileSync(need(args, 'generations'), 'utf8')) as string[];
      recordAll(args, sequenceResults('L8', generations));
      return;
    }

    case 'report': {
      const path = need(args, 'results');
      if (!existsSync(path)) fail('there are no results to report, which is itself a failure');
      const results = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as GateResult);
      if (results.length === 0) fail('there are no results to report, which is itself a failure');

      const failed = results.filter((result) => result.verdict === 'fail');
      const skipped = results.filter((result) => result.verdict === 'skip');
      const problems = findRedactionProblems(results);
      if (problems.length > 0) {
        console.error('the gate report would have leaked:');
        for (const problem of problems.slice(0, 20)) console.error(`  ${problem.kind} at ${problem.at}`);
        fail('the report is not redaction-safe');
      }

      console.log('');
      console.log(`Projection Phase 1 — G27 path lifecycle: ${results.length} assertions, `
        + `${failed.length} failed, ${skipped.length} skipped.`);
      for (const result of results) {
        const measured = result.measured === undefined ? '' : ` ${result.measured}/${result.budget}`;
        console.log(`  ${result.verdict.padEnd(4)} ${result.gate}${measured}`);
      }
      const jsonOut = args.flags.get('json');
      if (jsonOut !== undefined) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
      if (failed.length > 0) process.exit(1);
      return;
    }

    default:
      fail(`unknown command: ${args.command || '(none)'}`);
  }
}

main().catch((error: unknown) => {
  console.error(`projection-path-lifecycle: ${(error as Error).message}`);
  process.exit(1);
});
