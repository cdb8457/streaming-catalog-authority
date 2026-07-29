import type { Pool } from 'pg';
import type { CatalogAuthority } from '../core/catalog/authority.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';
import { ITEM_ID_RE } from '../core/catalog/events.js';
import { createManagedCollectionReader } from '../core/publish/collection-model.js';
import type { CatalogReader } from './operator-ui-catalog-browse.js';
import {
  COLLECTION_NAME_MAX_LENGTH,
  buildCollectionPlan,
  createLedgerReader,
  isUsableCollectionName,
  type CollectionPlan,
} from './collection-plan.js';
import { COLLECTION_DIGEST_RE, digestEchoMatches } from './collection-confirmation.js';
import {
  createCollectionAuditRuntime,
  createCollectionRuntime,
  checkCollectionWriteGates,
  describeCollectionWriteGates,
  queueCollectionPlan,
  readCollectionStatus,
  runCollectionReconcile,
  runCollectionRevocation,
  type CollectionQueueResult,
  type CollectionStatus,
} from './collection-execution.js';
import {
  applyCollectionRepair,
  auditCollectionDrift,
  buildCollectionRepairPlan,
  type CollectionDriftReport,
  type CollectionRepairPlan,
  type CollectionRepairResult,
} from './collection-drift.js';
import {
  COLLECTION_HISTORY_MAX_ROWS,
  renderCollectionHistory,
  type CollectionHistoryStore,
} from './collection-history.js';
import {
  matchCatalogToLibrary,
  renderLibraryMatch,
  type LibraryMatchReport,
} from './jellyfin-library-match.js';

// Phase 272 — the collection lifecycle from a terminal, with the same gates and the same services.
//
// IT IS NOT A SECOND IMPLEMENTATION, AND THAT IS THE WHOLE POINT. Every command below calls the function the
// HTTP route calls: `checkCollectionWriteGates`, `buildCollectionPlan`, `queueCollectionPlan`,
// `runCollectionReconcile`, `runCollectionRevocation`, `auditCollectionDrift`, `buildCollectionRepairPlan`,
// `applyCollectionRepair`. There is no CLI-only path into the durable model, no CLI-only transport, and no
// switch a CLI may skip. A command line that could do what a browser may not would make every gate in this
// product advisory.
//
// THE DIGEST ECHO IS REQUIRED HERE TOO, AND IT IS THE SAME COMPARISON. `--confirm-digest` must equal the plan
// digest of the plan this command just computed, compared with `digestEchoMatches` — the function the route
// uses. What the CLI deliberately does NOT carry is the signed confirmation TOKEN: that exists to bind a
// preview performed in one HTTP request to an execute performed in another, across a browser that could replay
// it. Here the preview and the apply are the same process, microseconds apart, with no intermediary — the
// token would be this process signing a note to itself. The part a human states on purpose is the digest, and
// the digest is enforced. The plan is then RECOMPUTED and both digests re-checked before anything is written,
// exactly as the route does, so a catalog that moved between the two still refuses.
//
// OUTPUT IS REDACTION-SAFE, AND STRICTER THAN THE BROWSER'S ON PURPOSE. The panel shows an authenticated
// operator a title in their own browser; a terminal writes to scrollback, to a CI log, to a support bundle
// somebody pastes into an issue. So this surface prints the opaque record id — which is what the next command
// takes as input, and which the operator already holds — and never a title, a year, a provider reference of
// any kind, a Jellyfin id, an external handle, a correlation token, an api key or an address. `--json` prints
// the same plan with its titles removed rather than a different, fuller document.

export const COLLECTION_COMMAND_REPORT = 'phase-272-collection-command';

export const COLLECTION_EXIT_OK = 0;
export const COLLECTION_EXIT_INCOMPLETE = 1;
export const COLLECTION_EXIT_USAGE = 2;
export const COLLECTION_EXIT_REFUSED = 3;

export type CollectionCommandName =
  | 'preview' | 'apply' | 'status' | 'match' | 'audit' | 'repair' | 'reconcile' | 'revoke' | 'history';

const COMMANDS: readonly CollectionCommandName[] =
  ['preview', 'apply', 'status', 'match', 'audit', 'repair', 'reconcile', 'revoke', 'history'];

export class CollectionCommandUsageError extends Error {
  readonly code = 'COLLECTION_COMMAND_USAGE_REJECTED';
  constructor(message: string) { super(message); this.name = 'CollectionCommandUsageError'; }
}

export interface ParsedCollectionArgs {
  readonly command: CollectionCommandName;
  readonly name: string | null;
  readonly itemIds: readonly string[];
  readonly search: string | null;
  readonly revoke: boolean;
  readonly confirmDigest: string | null;
  readonly json: boolean;
  readonly help: boolean;
}

/** Strict: an unknown flag is a usage error, and a flag that needs a value never swallows the next flag. */
export function parseCollectionArgs(argv: readonly string[]): ParsedCollectionArgs {
  if (argv.length === 0) throw new CollectionCommandUsageError('a command is required');
  const first = argv[0]!;
  if (first === '--help' || first === '-h') {
    return { command: 'status', name: null, itemIds: [], search: null, revoke: false, confirmDigest: null, json: false, help: true };
  }
  if (!COMMANDS.includes(first as CollectionCommandName)) {
    throw new CollectionCommandUsageError(`unknown command: ${first}`);
  }
  const command = first as CollectionCommandName;

  let name: string | null = null;
  let search: string | null = null;
  let confirmDigest: string | null = null;
  let revoke = false;
  let json = false;
  let help = false;
  const itemIds: string[] = [];

  const value = (argv: readonly string[], index: number, flag: string): string => {
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith('--')) throw new CollectionCommandUsageError(`${flag} needs a value`);
    return raw;
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--revoke': revoke = true; break;
      case '--json': json = true; break;
      case '--help': case '-h': help = true; break;
      case '--name': name = value(argv, i, '--name'); i += 1; break;
      case '--search': search = value(argv, i, '--search'); i += 1; break;
      case '--confirm-digest': confirmDigest = value(argv, i, '--confirm-digest'); i += 1; break;
      case '--item': itemIds.push(value(argv, i, '--item')); i += 1; break;
      default: throw new CollectionCommandUsageError(`unknown option: ${arg}`);
    }
  }

  if (!help) {
    // VALIDATED BEFORE A CONNECTION IS OPENED. A malformed command should not have caused a database
    // connection, a custodian handshake, or any observable effect at all.
    if ((command === 'preview' || command === 'apply') && !isUsableCollectionName(name)) {
      throw new CollectionCommandUsageError(
        `--name is required and must be 1-${COLLECTION_NAME_MAX_LENGTH} characters of letters, digits, spaces and . , - _ ' & ( ) + :`);
    }
    if (command === 'apply' && (confirmDigest === null || !COLLECTION_DIGEST_RE.test(confirmDigest))) {
      throw new CollectionCommandUsageError('--confirm-digest is required and must be the 64-character plan digest the preview printed');
    }
    if (command === 'repair' && (confirmDigest === null || !COLLECTION_DIGEST_RE.test(confirmDigest))) {
      throw new CollectionCommandUsageError('--confirm-digest is required and must be the 64-character repair digest the audit printed');
    }
    for (const id of itemIds) {
      if (!ITEM_ID_RE.test(id)) throw new CollectionCommandUsageError(`--item is not a record identifier: ${id}`);
    }
    if (revoke && itemIds.length > 0) {
      throw new CollectionCommandUsageError('--revoke removes the whole collection, so it takes no --item');
    }
    if (revoke && search !== null) {
      throw new CollectionCommandUsageError('--revoke removes the whole collection, so it takes no --search');
    }
    if (!revoke && (command === 'preview' || command === 'apply') && itemIds.length === 0 && search === null) {
      throw new CollectionCommandUsageError('give the records with one or more --item, or a --search, or use --revoke');
    }
  }

  return { command, name, itemIds, search, revoke, confirmDigest, json, help };
}

export function collectionCommandUsage(): string {
  return [
    'usage: npm run ops:collections -- <command> [options]',
    '',
    'One operator plan is one managed collection on your media server, holding the records you chose.',
    '',
    'commands:',
    '  preview    compute what would happen and print the digest. Writes nothing, contacts nothing.',
    '  apply      queue a previewed plan. Requires --confirm-digest. Contacts nothing.',
    '  status     what this installation currently believes about its managed collections.',
    '  match      which imported records your media server\'s library actually holds. READ-ONLY.',
    '  audit      compare that belief with the media server. READ-ONLY.',
    '  repair     apply a digest-confirmed repair. Writes durable state only.',
    '  reconcile  carry out queued work: create, adopt by token, make membership match.',
    '  revoke     take forgotten records back out and delete the collections that must go.',
    '  history    the durable record of what was previewed, queued, reconciled and revoked.',
    '',
    'options:',
    '  --name <text>            the collection. It names the collection on your media server.',
    '  --item <record-id>       a record to put in it. Repeatable.',
    '  --search <text>          choose records by a bounded catalog search instead of listing them.',
    '  --revoke                 with preview/apply: remove the whole collection rather than define it.',
    '  --confirm-digest <hex>   the digest the preview (or audit) printed. Required by apply and repair.',
    '  --json                   print the machine-readable report instead of the summary.',
    '',
    'Every command enforces the same four deployment switches as the operator UI, and apply and repair',
    'additionally require the digest you type to match a plan recomputed at the moment of the write.',
    'Output never contains a title, a provider reference, a Jellyfin id, an external handle or an api key.',
    '',
    'exit codes: 0 done | 1 completed with failures | 2 bad usage | 3 refused (a switch, or a stale digest)',
  ].join('\n');
}

export interface CollectionCommandDeps {
  readonly pool: Pool;
  readonly reader: CatalogReader;
  readonly authority: CatalogAuthority;
  readonly history?: CollectionHistoryStore;
  /** INJECTED. Absent means this process has no transport at all, whatever any switch says. */
  readonly fetch?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
}

export type CollectionCommandOutcome =
  | { readonly kind: 'plan'; readonly plan: CollectionPlan }
  | { readonly kind: 'queued'; readonly plan: CollectionPlan; readonly queued: CollectionQueueResult }
  | { readonly kind: 'status'; readonly status: CollectionStatus }
  | { readonly kind: 'match'; readonly match: LibraryMatchReport }
  | { readonly kind: 'audit'; readonly drift: CollectionDriftReport; readonly repair: CollectionRepairPlan }
  | { readonly kind: 'repaired'; readonly repair: CollectionRepairPlan; readonly result: CollectionRepairResult }
  | { readonly kind: 'reconciled'; readonly result: Awaited<ReturnType<typeof runCollectionReconcile>> }
  | { readonly kind: 'revoked'; readonly result: Awaited<ReturnType<typeof runCollectionRevocation>> }
  | { readonly kind: 'history'; readonly text: string }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string };

export interface CollectionCommandResult {
  readonly exitCode: number;
  readonly outcome: CollectionCommandOutcome;
}

const refused = (code: string, message: string): CollectionCommandResult =>
  ({ exitCode: COLLECTION_EXIT_REFUSED, outcome: { kind: 'refused', code, message } });

/**
 * Run one command.
 *
 * ALL DEPENDENCIES ARE INJECTED, INCLUDING THE TRANSPORT. This function cannot reach the network on its own,
 * so a suite can exercise every branch against a fake media server and an embedded database, and the running
 * command line is the only thing that ever hands it a real socket.
 */
export async function runCollectionCommand(
  args: ParsedCollectionArgs,
  deps: CollectionCommandDeps,
): Promise<CollectionCommandResult> {
  const env = deps.env ?? process.env;
  const planDeps = {
    reader: deps.reader,
    ledger: createLedgerReader(deps.pool),
    managed: createManagedCollectionReader(deps.pool),
  };
  const selection = {
    name: args.name,
    mode: args.revoke ? 'revoke' : 'sync',
    ...(args.revoke ? {} : args.itemIds.length > 0 ? { itemIds: [...args.itemIds] } : { search: args.search }),
  };

  if (args.command === 'status') {
    return { exitCode: COLLECTION_EXIT_OK, outcome: { kind: 'status', status: await readCollectionStatus(deps.pool) } };
  }

  if (args.command === 'history') {
    if (deps.history === undefined) return refused('HISTORY_UNAVAILABLE', 'The collection history could not be read.');
    const entries = await deps.history.list(COLLECTION_HISTORY_MAX_ROWS);
    return { exitCode: COLLECTION_EXIT_OK, outcome: { kind: 'history', text: renderCollectionHistory(entries) } };
  }

  if (args.command === 'match') {
    // A READ, ON ONE SWITCH. It borrows the AUDIT runtime — whose target's create/add/remove/delete methods
    // throw — so this command has no write path in its object graph whatever the other three switches say.
    // Their state is REPORTED rather than required: an operator asking "what would be found?" must not have
    // to turn writing on to get an answer, and a report that did not say which switches were open would be a
    // report somebody could misread as having been taken under a closed installation.
    const built = createCollectionAuditRuntime({
      pool: deps.pool, authority: deps.authority, fetch: deps.fetch ?? unavailableFetch, env,
    });
    if (!built.ok) return refused(built.refusal, built.message);
    const match = await matchCatalogToLibrary({
      reader: deps.reader,
      authority: deps.authority,
      target: built.runtime.target,
      requires: built.runtime.requires,
      gates: describeCollectionWriteGates(env),
    });
    // DELIBERATELY NOT RECORDED IN THE DURABLE HISTORY. Every other entry in that table describes a DECISION
    // about a collection — planned, queued, audited, repaired, reconciled, revoked. This command names no
    // collection and authorises nothing, so a row for it would put a read with no subject into a ledger whose
    // rows are read as intent. It also keeps the claim simple: this command writes nothing, anywhere.
    return { exitCode: COLLECTION_EXIT_OK, outcome: { kind: 'match', match } };
  }

  if (args.command === 'preview') {
    const result = await buildCollectionPlan(planDeps, selection);
    if (!result.ok) return refused(`PLAN_${result.rejection}`, result.message);
    // The command line records its preview in the SAME durable history the browser writes to, so an operator
    // who uses both surfaces has one answer to "what have I asked this installation to do", not two partial
    // ones. A failure to record never fails the preview: the preview still wrote nothing.
    await recordSafely(deps.history, {
      actor: 'cli', action: 'planned', target: result.plan.target, name: result.plan.name,
      planDigest: result.plan.planDigest, basisDigest: result.plan.basisDigest,
      selected: result.plan.counts.selected, created: 0, updated: 0, unchanged: result.plan.counts.keep,
      revoked: 0, blocked: result.plan.counts.blocked, failed: 0, outcome: 'preview',
    });
    return { exitCode: COLLECTION_EXIT_OK, outcome: { kind: 'plan', plan: result.plan } };
  }

  if (args.command === 'apply') {
    // THE SWITCHES FIRST, exactly as the route checks them, and in the same order an operator would fix them.
    const gates = checkCollectionWriteGates(env);
    if (!gates.ok) return refused(gates.refusal, gates.message);

    const first = await buildCollectionPlan(planDeps, selection);
    if (!first.ok) return refused(`PLAN_${first.rejection}`, first.message);
    if (!digestEchoMatches(args.confirmDigest, first.plan.planDigest)) {
      return refused('DIGEST_MISMATCH',
        'The digest you confirmed is not the digest of the plan this command just computed. Nothing was queued. '
        + 'Run preview again and copy the digest from the plan you actually read.');
    }
    // RECOMPUTED BEFORE THE WRITE, for the same reason the route recomputes: the digest proves what was read,
    // and the recomputation proves the world has not moved since. A record forgotten in between, a competing
    // import, or another operator's execute all change the basis without changing anything visible here.
    const second = await buildCollectionPlan(planDeps, selection);
    if (!second.ok) return refused(`PLAN_${second.rejection}`, second.message);
    if (second.plan.planDigest !== first.plan.planDigest || second.plan.basisDigest !== first.plan.basisDigest) {
      return refused('PLAN_STALE',
        'The catalog or this collection\'s durable state changed while the plan was being confirmed, so what '
        + 'would be queued is no longer what you read. Nothing was queued.');
    }

    const queued = await queueCollectionPlan({ pool: deps.pool }, second.plan);
    await recordSafely(deps.history, {
      actor: 'cli', action: 'queued', target: second.plan.target, name: second.plan.name,
      planDigest: second.plan.planDigest, basisDigest: second.plan.basisDigest,
      selected: second.plan.counts.selected, created: queued.added, updated: queued.kept,
      unchanged: second.plan.counts.keep, revoked: queued.removing, blocked: queued.blocked,
      failed: queued.failed, outcome: queued.failed === 0 ? 'complete' : 'incomplete',
    });
    return {
      exitCode: queued.failed === 0 ? COLLECTION_EXIT_OK : COLLECTION_EXIT_INCOMPLETE,
      outcome: { kind: 'queued', plan: second.plan, queued },
    };
  }

  if (args.command === 'audit' || args.command === 'repair') {
    // A REPAIR IS A WRITE. It needs the write switches; the audit needs only the network switch, because it
    // changes nothing and an operator should not have to turn writing on to find out whether something is
    // wrong.
    if (args.command === 'repair') {
      const gates = checkCollectionWriteGates(env);
      if (!gates.ok) return refused(gates.refusal, gates.message);
    }
    const built = createCollectionAuditRuntime({
      pool: deps.pool, authority: deps.authority, fetch: deps.fetch ?? unavailableFetch, env,
    });
    if (!built.ok) return refused(built.refusal, built.message);

    const drift = await auditCollectionDrift(built.runtime);
    const repair = buildCollectionRepairPlan(drift);
    if (args.command === 'audit') {
      await recordSafely(deps.history, {
        actor: 'cli', action: 'audited', target: drift.target, name: 'audit',
        planDigest: repair.planDigest, basisDigest: repair.basisDigest,
        selected: drift.counts.scanned, created: 0, updated: drift.counts.drifted, unchanged: drift.counts.ok,
        revoked: 0, blocked: drift.counts.unknown, failed: 0, outcome: 'preview',
      });
      return { exitCode: COLLECTION_EXIT_OK, outcome: { kind: 'audit', drift, repair } };
    }

    if (!digestEchoMatches(args.confirmDigest, repair.planDigest)) {
      return refused('DIGEST_MISMATCH',
        'The digest you confirmed is not the digest of the repair this command just computed against your media '
        + 'server. Nothing was changed. Run audit again and copy the digest from the plan you actually read.');
    }
    const result = await applyCollectionRepair(deps.pool, repair);
    await recordSafely(deps.history, {
      actor: 'cli', action: 'repaired', target: drift.target, name: 'repair',
      planDigest: repair.planDigest, basisDigest: repair.basisDigest,
      selected: repair.actions.length, created: result.rearmed, updated: result.scheduled, unchanged: 0,
      revoked: result.queuedRevoke, blocked: 0, failed: result.failed, outcome: result.failed === 0 ? 'complete' : 'incomplete',
    });
    return {
      exitCode: result.failed === 0 ? COLLECTION_EXIT_OK : COLLECTION_EXIT_INCOMPLETE,
      outcome: { kind: 'repaired', repair, result },
    };
  }

  // reconcile | revoke — the two passes that change a media server.
  const built = createCollectionRuntime({
    pool: deps.pool, authority: deps.authority, fetch: deps.fetch ?? unavailableFetch, env,
  });
  if (!built.ok) return refused(built.refusal, built.message);

  if (args.command === 'reconcile') {
    const result = await runCollectionReconcile(built.runtime);
    const g = result.grouped;
    await recordSafely(deps.history, {
      actor: 'cli', action: 'reconciled', target: 'jellyfin', name: 'reconcile',
      planDigest: ZERO_DIGEST, basisDigest: ZERO_DIGEST,
      selected: g.created + g.adopted + g.updated + g.unchanged + g.deferred + g.unresolved + g.failed + g.queuedRevoke,
      created: g.created, updated: g.adopted + g.updated, unchanged: g.unchanged, revoked: g.queuedRevoke,
      blocked: g.deferred + g.unresolved, failed: g.failed,
      outcome: g.failed === 0 && g.deferred === 0 ? 'complete' : 'incomplete',
    });
    return {
      exitCode: g.failed === 0 && result.legacy.failed === 0 ? COLLECTION_EXIT_OK : COLLECTION_EXIT_INCOMPLETE,
      outcome: { kind: 'reconciled', result },
    };
  }

  const result = await runCollectionRevocation(deps.pool, built.runtime);
  const g = result.grouped;
  await recordSafely(deps.history, {
    actor: 'cli', action: 'revoked', target: 'jellyfin', name: 'revoke',
    planDigest: ZERO_DIGEST, basisDigest: ZERO_DIGEST,
    selected: g.queued + result.legacy.queued, created: 0, updated: 0, unchanged: 0,
    revoked: g.revoked + result.legacy.revoked, blocked: g.pending + result.legacy.pending,
    failed: g.failed + result.legacy.failed,
    outcome: g.failed === 0 && g.pending === 0 && result.legacy.failed === 0 && result.legacy.pending === 0
      ? 'complete' : 'incomplete',
  });
  return {
    exitCode: g.failed === 0 && result.legacy.failed === 0 ? COLLECTION_EXIT_OK : COLLECTION_EXIT_INCOMPLETE,
    outcome: { kind: 'revoked', result },
  };
}

const ZERO_DIGEST = '0'.repeat(64);

const unavailableFetch: FetchLike = () => {
  throw new Error('jellyfin: no network transport is available to this process');
};

async function recordSafely(
  store: CollectionHistoryStore | undefined,
  entry: Parameters<CollectionHistoryStore['record']>[0],
): Promise<void> {
  if (store === undefined) return;
  try { await store.record(entry); } catch { /* an unwritten audit row never fails the operation it describes */ }
}

/**
 * A plan, with everything a terminal must not print taken out.
 *
 * IT REMOVES RATHER THAN REPLACES. `title` and `year` are dropped from every member — not blanked, not
 * truncated — so a report that is later diffed, pasted or archived cannot carry them by having been rendered
 * from a document that still held them.
 */
export function redactPlanForCli(plan: CollectionPlan): Record<string, unknown> {
  return {
    ...plan,
    members: plan.members.map(({ title: _title, year: _year, ...rest }) => rest),
  };
}

/** The human summary. Counts, digests, opaque record ids and closed-set words. */
export function renderCollectionPlan(plan: CollectionPlan): string {
  const lines: string[] = [];
  lines.push(`collection: ${plan.name}   (${plan.mode})`);
  lines.push(`  key            ${plan.collectionKey}`);
  lines.push(`  action         ${plan.collection.action.toUpperCase()} (${plan.collection.reason})`);
  lines.push(`  now            state=${plan.collection.state} settled=${plan.collection.settled} members=${plan.collection.members}`);
  lines.push(`  would hold     ${plan.counts.resulting} record(s): +${plan.counts.add} add, ${plan.counts.keep} keep, -${plan.counts.remove} remove, ${plan.counts.blocked} blocked`);
  lines.push(`  plan digest    ${plan.planDigest}`);
  lines.push(`  basis digest   ${plan.basisDigest}`);
  if (plan.legacy.perItemLive > 0) {
    lines.push(`  legacy         ${plan.legacy.perItemLive} per-record collection(s) from before schema v9, untouched by this plan`);
  }
  if (plan.truncated) lines.push('  NOTE           the search stopped at its scan bound and may not have seen everything');
  lines.push('');
  lines.push('  records (opaque ids only — no title is ever printed by this command):');
  for (const member of plan.members) {
    lines.push(`    ${member.itemId}  ${member.action.padEnd(7)} ${member.reason.padEnd(17)} refs=${member.refCount}`);
  }
  lines.push('');
  lines.push(`  ${plan.guidance}`);
  return lines.join('\n');
}

export function renderCollectionStatus(status: CollectionStatus): string {
  const lines: string[] = [];
  lines.push(`target: ${status.target}`);
  lines.push(`  managed collections   ${Object.entries(status.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  lines.push(`  outstanding           ${status.outstanding}   awaiting deletion ${status.unrevoked}`);
  lines.push(`  legacy per-record     ${Object.entries(status.legacy.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  lines.push(`  recovery proof        ${status.recoveryProof ?? 'none recorded'}`);
  lines.push('');
  if (status.collections.length === 0) {
    lines.push('  no managed collection exists on this installation yet');
  } else {
    for (const row of status.collections) {
      lines.push(`    ${row.name.padEnd(32)} ${row.status.padEnd(15)} members=${row.members} removing=${row.removing} synced=${row.synced} needsSync=${row.needsSync}`);
      lines.push(`      key ${row.collectionKey}`);
    }
  }
  lines.push('');
  lines.push(`  ${status.guidance}`);
  return lines.join('\n');
}

export function renderCollectionDrift(drift: CollectionDriftReport, repair: CollectionRepairPlan): string {
  const lines: string[] = [];
  lines.push(`drift audit: ${drift.target}   (read-only — nothing was changed)`);
  lines.push(`  ${Object.entries(drift.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  lines.push(`  recovery proof        ${drift.recoveryProof ?? 'none recorded'}`);
  lines.push('');
  for (const finding of drift.findings) {
    lines.push(`    ${finding.name.padEnd(32)} ${finding.verdict.padEnd(19)} ${finding.reason.padEnd(22)} `
      + `expected=${finding.expected} present=${finding.present ?? '?'} missing=${finding.missing ?? '?'} extra=${finding.extra ?? '?'} `
      + `repair=${finding.repair}`);
  }
  lines.push('');
  lines.push(`  repair digest  ${repair.planDigest}`);
  lines.push(`  repair basis   ${repair.basisDigest}`);
  lines.push(`  would ${repair.counts.recreate} re-arm, ${repair.counts.sync} sync, ${repair.counts.revoke} revoke`);
  lines.push('');
  lines.push(`  ${drift.guidance}`);
  lines.push(`  ${repair.guidance}`);
  return lines.join('\n');
}

/** The final rendering step. Chooses JSON or text, and JSON is the REDACTED document, never a fuller one. */
export function renderCollectionOutcome(outcome: CollectionCommandOutcome, json: boolean): string {
  switch (outcome.kind) {
    case 'plan':
      return json ? JSON.stringify(redactPlanForCli(outcome.plan), null, 2) : renderCollectionPlan(outcome.plan);
    case 'queued':
      return json
        ? JSON.stringify({ report: COLLECTION_COMMAND_REPORT, queued: outcome.queued, plan: redactPlanForCli(outcome.plan) }, null, 2)
        : [
          `queued: ${outcome.queued.action}`,
          `  collection     ${outcome.plan.name}`,
          `  key            ${outcome.queued.collectionKey}`,
          `  members        ${outcome.queued.members}  (+${outcome.queued.added} added, ${outcome.queued.kept} kept, -${outcome.queued.removing} queued to come out)`,
          `  blocked        ${outcome.queued.blocked}`,
          `  erasure sweep  ${outcome.queued.forgottenQueued} membership row(s), ${outcome.queued.legacyForgottenQueued} legacy per-record copy/copies`,
          `  failed writes  ${outcome.queued.failed}`,
          '',
          '  Nothing has been sent to a media server. Run `reconcile` to carry this out.',
        ].join('\n');
    case 'status':
      return json ? JSON.stringify(outcome.status, null, 2) : renderCollectionStatus(outcome.status);
    case 'match':
      // The JSON is the SAME document the text is rendered from, and it already carries no title, no
      // reference value and no media-server id — so there is nothing to redact out of it on the way past.
      return json
        ? JSON.stringify({ report: COLLECTION_COMMAND_REPORT, match: outcome.match }, null, 2)
        : renderLibraryMatch(outcome.match);
    case 'audit':
      return json
        ? JSON.stringify({ report: COLLECTION_COMMAND_REPORT, drift: outcome.drift, repair: outcome.repair }, null, 2)
        : renderCollectionDrift(outcome.drift, outcome.repair);
    case 'repaired':
      return json
        ? JSON.stringify({ report: COLLECTION_COMMAND_REPORT, repair: outcome.repair, result: outcome.result }, null, 2)
        : [
          'repaired (durable state only — nothing was created or deleted on your media server):',
          `  re-armed       ${outcome.result.rearmed}`,
          `  scheduled      ${outcome.result.scheduled}`,
          `  queued revoke  ${outcome.result.queuedRevoke}`,
          `  failed         ${outcome.result.failed}`,
          '',
          '  Run `reconcile` and then `revoke` to carry this out under their own gates.',
        ].join('\n');
    case 'reconciled':
      return json
        ? JSON.stringify({ report: COLLECTION_COMMAND_REPORT, ...outcome.result }, null, 2)
        : [
          'reconcile pass:',
          `  grouped  ${Object.entries(outcome.result.grouped).map(([k, v]) => `${k}=${v}`).join(' ')}`,
          `  legacy   ${Object.entries(outcome.result.legacy).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        ].join('\n');
    case 'revoked':
      return json
        ? JSON.stringify({ report: COLLECTION_COMMAND_REPORT, ...outcome.result }, null, 2)
        : [
          'revoke pass:',
          `  grouped  ${Object.entries(outcome.result.grouped).map(([k, v]) => `${k}=${v}`).join(' ')}`,
          `  legacy   ${Object.entries(outcome.result.legacy).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        ].join('\n');
    case 'history':
      return outcome.text;
    case 'refused':
      return json
        ? JSON.stringify({ report: COLLECTION_COMMAND_REPORT, ok: false, code: outcome.code, message: outcome.message }, null, 2)
        : `refused (${outcome.code}): ${outcome.message}`;
  }
}
