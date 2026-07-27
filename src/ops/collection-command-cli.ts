import { CatalogAuthority } from '../core/catalog/authority.js';
import { createCustodian, loadCustodianConfig } from '../core/crypto/custodian-factory.js';
import { closePool, getPool } from '../db/pool.js';
import { isDirectRun } from './direct-run.js';
import { createCatalogReader } from './operator-ui-catalog-browse.js';
import { createCollectionHistoryStore } from './collection-history.js';
import { resolveJellyfinTransport } from './operator-ui-jellyfin-endpoint.js';
import {
  COLLECTION_EXIT_INCOMPLETE,
  COLLECTION_EXIT_OK,
  COLLECTION_EXIT_USAGE,
  CollectionCommandUsageError,
  collectionCommandUsage,
  parseCollectionArgs,
  renderCollectionOutcome,
  runCollectionCommand,
  type ParsedCollectionArgs,
} from './collection-command.js';

// Phase 272 — `npm run ops:collections`.
//
// THIS FILE IS THE PROGRAM AND NOTHING ELSE. Every decision lives in `collection-command.ts`, which takes its
// pool, its catalog reader, its authority and its TRANSPORT as parameters. This entrypoint is the one place
// that turns those into real things, and it is the only reason a packet can exist:
// `resolveJellyfinTransport` returns `undefined` unless `JELLYFIN_ENABLE_NETWORK` is exactly `"true"`, so with
// the switch off there is no transport object in the process at all — not a disabled one, not a stubbed one.
//
// PREVIEW IS THE ONLY COMMAND THAT NEEDS NOTHING. `preview`, `status` and `history` never construct a
// transport; `apply` constructs none either, because queuing contacts nothing. Only `reconcile`, `revoke`,
// `audit` and `repair` can reach a media server, and each of them checks its own switches inside the command
// module before it does.

async function main(): Promise<number> {
  let args: ParsedCollectionArgs;
  try {
    args = parseCollectionArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CollectionCommandUsageError) {
      console.error(err.message);
      console.error('');
      console.error(collectionCommandUsage());
      return COLLECTION_EXIT_USAGE;
    }
    throw err;
  }
  if (args.help) {
    console.log(collectionCommandUsage());
    return COLLECTION_EXIT_OK;
  }

  const pool = getPool();
  try {
    // The custodian handshake happens for every command, because even a preview decrypts identity to decide
    // what a record's references are. It is the same authority the operator UI uses, with the same fail-closed
    // behaviour on a forgotten or shredded record.
    const authority = new CatalogAuthority(pool, createCustodian(loadCustodianConfig()));
    const transport = resolveJellyfinTransport();
    const result = await runCollectionCommand(args, {
      pool,
      reader: createCatalogReader(pool, authority),
      authority,
      history: createCollectionHistoryStore(pool),
      ...(transport === undefined ? {} : { fetch: transport }),
    });
    const text = renderCollectionOutcome(result.outcome, args.json);
    // A REFUSAL GOES TO STDERR AND A REPORT GOES TO STDOUT, so a script that pipes stdout into a file gets a
    // report or an empty file, never a refusal that reads like one.
    if (result.outcome.kind === 'refused') console.error(text);
    else console.log(text);
    return result.exitCode;
  } finally {
    await closePool();
  }
}

// ONLY WHEN THIS FILE IS THE PROGRAM. `test/collection-cli.ts` imports the parser and the renderers from the
// command module, and a suite's own arguments must never reach this parser. See direct-run.ts.
if (isDirectRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(async (err: unknown) => {
    await closePool().catch(() => undefined);
    // The message comes from the authority or the driver and carries no identity; the stack does not go to
    // stdout, where a report is read from.
    console.error((err as Error).message);
    process.exitCode = COLLECTION_EXIT_INCOMPLETE;
  });
}
