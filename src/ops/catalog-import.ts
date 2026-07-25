import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import type { CatalogAuthority } from '../core/catalog/authority.js';
import {
  CatalogImportError,
  IMPORT_MAX_BYTES,
  type NormalizedSnapshot,
  type NormalizedSnapshotItem,
  externalIdDigest,
  parseCatalogSnapshot,
} from '../core/catalog/import-snapshot.js';

// Phase 259 — importing an offline catalog snapshot into this installation's own database.
//
// THE PRODUCT STEP. Everything up to Phase 258 installs Catalog Authority. This is the first thing an
// operator does WITH it: put a file of their own catalog records on disk, look at what would happen, then
// commit it.
//
// IT READS ONE FILE THE OPERATOR NAMED, AND NOTHING ELSE. No directory is walked, no media path is scanned,
// no provider, media server or network endpoint is contacted, and no process is spawned. When
// CATALOG_IMPORT_DIR is set — which the shipped Compose stack does, mounting the folder READ-ONLY — the file
// must resolve inside it after symlinks, so a snapshot cannot name a path outside the folder the operator
// mounted for this purpose.
//
// NOTHING IS WRITTEN UNTIL EVERYTHING IS VALID. The document is parsed and normalized whole before the first
// database call. A malformed file is a no-op, not a half-import — there is no state in which some records
// from a rejected file were persisted.
//
// EVERY WRITE GOES THROUGH CatalogAuthority.addItem. That is the only ingestion path, so imported identity is
// encrypted in this process with a per-item key from the custodian exactly like every other write, and the
// database only ever sees ciphertext. This module does not reimplement, bypass or widen that path.
//
// A REPEAT IMPORT IS A NO-OP. Item ids are derived from (source, externalId), and `cat_add_item_ct` treats a
// second write to an existing active item as an idempotent no-op. Re-running the same file changes nothing
// and reports so.
//
// AN IMPORT CANNOT UNDO AN ERASURE. An item that has been forgotten is reported BLOCKED and skipped. The
// database would refuse it anyway ("item is forgotten; use restore()"), but detecting it during planning
// means an operator sees it in the preview rather than as a failure part-way through a run.
//
// IT IS NOT PROMOTION EVIDENCE. Nothing here reads, writes, references or implies a promotion record.

export const CATALOG_IMPORT_DIR_ENV = 'CATALOG_IMPORT_DIR';
export const CATALOG_IMPORT_CONTAINER_DIR = '/var/lib/catalog/import';

export class CatalogImportPathError extends Error {
  readonly code = 'CATALOG_IMPORT_PATH_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'CatalogImportPathError';
  }
}

/**
 * Resolve the snapshot file the operator asked for.
 *
 * Messages name the CONSTRAINT, never the path. A rejected path is often a mount that is not where somebody
 * thought it was, and echoing host paths into a report that gets pasted into an issue is how a filesystem
 * layout leaves the machine.
 */
export function resolveImportFile(requested: string, env: NodeJS.ProcessEnv = process.env): string {
  if (requested.trim() === '') throw new CatalogImportPathError('no snapshot file was named');
  if (requested.includes('\u0000')) throw new CatalogImportPathError('the snapshot file name is not a usable path');

  const configuredDir = env[CATALOG_IMPORT_DIR_ENV];
  if (configuredDir === undefined || configuredDir.trim() === '') {
    // No import directory configured: a developer or a bare CLI run. The operator names any path they can
    // already read; this process has their privileges and grants itself none.
    return resolve(requested);
  }

  const root = realpathSync(resolve(configuredDir));
  // A relative name is relative to the import directory — that is the ergonomic an operator expects when
  // they have mounted a folder for exactly this. An absolute name is allowed, but only inside the folder.
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new CatalogImportPathError('the snapshot file does not exist inside the configured import directory');
  }
  // Containment is checked AFTER symlinks are resolved on both sides, so a symlink inside the folder cannot
  // point at something outside it and be read anyway.
  const rel = relative(root, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new CatalogImportPathError(`the snapshot file must be inside the directory named by ${CATALOG_IMPORT_DIR_ENV}`);
  }
  return real;
}

/** Read a snapshot file, refusing anything that is not a bounded regular file, then parse and normalize it. */
export function readCatalogSnapshot(path: string): NormalizedSnapshot {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    throw new CatalogImportPathError('the snapshot file could not be read');
  }
  if (!stats.isFile()) throw new CatalogImportPathError('the snapshot path is not a regular file');
  // Checked BEFORE the read, so an enormous file is refused rather than pulled into memory and then refused.
  if (stats.size > IMPORT_MAX_BYTES) {
    throw new CatalogImportError([`the snapshot is ${stats.size} bytes, over the ${IMPORT_MAX_BYTES}-byte limit`]);
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CatalogImportPathError('the snapshot file could not be read');
  }
  return parseCatalogSnapshot(text);
}

export type ImportAction = 'create' | 'update' | 'unchanged' | 'blocked';

export interface PlannedImportItem {
  readonly itemId: string;
  /** A stable, non-reversible label. The external id itself is never in a report. */
  readonly digest: string;
  readonly action: ImportAction;
  /** Present only for `blocked`. Names the state, never any content. */
  readonly reason?: string;
}

export interface CatalogImportPlan {
  readonly source: string;
  readonly snapshotDigest: string;
  readonly items: readonly PlannedImportItem[];
  readonly counts: Readonly<Record<ImportAction, number>>;
  readonly total: number;
  /** True when applying this plan would write nothing. */
  readonly noop: boolean;
}

export interface ExistingItemState {
  readonly itemId: string;
  readonly present: boolean;
  readonly forgotten: boolean;
  readonly shredState: string | null;
}

export type ExistingStateLookup = (itemIds: readonly string[]) => Promise<readonly ExistingItemState[]>;

/** How many ids are asked about in one query. Bounded so a 10,000-item snapshot cannot build one huge statement. */
export const IMPORT_LOOKUP_BATCH = 500;

/**
 * Ask the database which of these items already exist, in bounded batches.
 *
 * Parameterised (`= ANY($1::text[])`) — the ids are data, never interpolated text, so nothing derived from a
 * snapshot can reach the query as syntax. It reads three boolean-ish columns and no ciphertext at all.
 */
export function createExistingStateLookup(pool: Pool): ExistingStateLookup {
  return async (itemIds) => {
    const out: ExistingItemState[] = [];
    for (let i = 0; i < itemIds.length; i += IMPORT_LOOKUP_BATCH) {
      const batch = itemIds.slice(i, i + IMPORT_LOOKUP_BATCH);
      const { rows } = await pool.query(
        `SELECT i.id, i.present, i.forgotten, k.shred_state
           FROM items i LEFT JOIN item_key_control k ON k.item_id = i.id
          WHERE i.id = ANY($1::text[])`,
        [batch],
      );
      for (const row of rows) {
        out.push({
          itemId: row.id as string,
          present: row.present === true,
          forgotten: row.forgotten === true,
          shredState: (row.shred_state as string | null) ?? null,
        });
      }
    }
    return out;
  };
}

export interface PlanOptions {
  /** Rewrite the identity of items that already exist. Off by default: an import creates, it does not edit. */
  readonly updateExisting?: boolean;
}

/**
 * Decide, for every record in the snapshot, what applying it would do — before anything is applied.
 *
 * This is the whole of the dry run. `previewCatalogImport` and `applyCatalogImport` share it, so the preview
 * an operator reads is produced by the same code that then does the work, not by a description of it.
 */
export async function planCatalogImport(
  snapshot: NormalizedSnapshot,
  lookup: ExistingStateLookup,
  options: PlanOptions = {},
): Promise<CatalogImportPlan> {
  const existing = new Map<string, ExistingItemState>();
  for (const state of await lookup(snapshot.items.map((i) => i.itemId))) existing.set(state.itemId, state);

  const items: PlannedImportItem[] = snapshot.items.map((item) => {
    const digest = externalIdDigest(snapshot.source, item.externalId);
    const state = existing.get(item.itemId);
    if (state === undefined || (!state.present && state.shredState === null)) {
      return { itemId: item.itemId, digest, action: 'create' };
    }
    if (state.forgotten || (state.shredState !== null && state.shredState !== 'active')) {
      // An erasure is a decision. An import is not allowed to quietly reverse one; `restore()` is the
      // deliberate, separate operation for that.
      return {
        itemId: item.itemId,
        digest,
        action: 'blocked',
        reason: 'this item was forgotten; importing cannot undo an erasure',
      };
    }
    return { itemId: item.itemId, digest, action: options.updateExisting === true ? 'update' : 'unchanged' };
  });

  const counts: Record<ImportAction, number> = { create: 0, update: 0, unchanged: 0, blocked: 0 };
  for (const item of items) counts[item.action] += 1;
  return {
    source: snapshot.source,
    snapshotDigest: snapshot.digest,
    items,
    counts,
    total: items.length,
    noop: counts.create === 0 && counts.update === 0,
  };
}

export interface AppliedImportItem {
  readonly digest: string;
  readonly action: ImportAction;
  readonly outcome: 'applied' | 'skipped' | 'failed' | 'not-attempted';
  /** A failure reason with no content in it. */
  readonly reason?: string;
}

export interface CatalogImportResult {
  readonly ok: boolean;
  readonly report: 'phase-259-catalog-import';
  readonly mode: 'preview' | 'apply';
  readonly source: string;
  readonly snapshotDigest: string;
  readonly total: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly blocked: number;
  readonly failed: number;
  readonly notAttempted: number;
  readonly items: readonly AppliedImportItem[];
  /** Guidance an operator can act on, with no content and no path in it. */
  readonly notes: readonly string[];
}

export function previewCatalogImportResult(plan: CatalogImportPlan): CatalogImportResult {
  const notes: string[] = [];
  if (plan.counts.blocked > 0) {
    notes.push(`${plan.counts.blocked} record(s) address items that were forgotten; an import cannot undo an erasure and they will be skipped.`);
  }
  if (plan.noop) {
    notes.push('Nothing would change: every record in this snapshot is already present and active.');
  }
  notes.push('This was a preview. Nothing was written. Re-run with --apply to commit it.');
  return {
    // A preview is `ok` when the snapshot is applicable. Blocked records are a fact to read, not a rejection:
    // the remaining records still import, and the preview exists so that is a decision rather than a surprise.
    ok: true,
    report: 'phase-259-catalog-import',
    mode: 'preview',
    source: plan.source,
    snapshotDigest: plan.snapshotDigest,
    total: plan.total,
    created: plan.counts.create,
    updated: plan.counts.update,
    unchanged: plan.counts.unchanged,
    blocked: plan.counts.blocked,
    failed: 0,
    notAttempted: 0,
    items: plan.items.map((item) => ({
      digest: item.digest,
      action: item.action,
      outcome: item.action === 'create' || item.action === 'update' ? 'not-attempted' : 'skipped',
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    })),
    notes,
  };
}

export interface ApplyOptions extends PlanOptions {
  /** Keep going after a record fails. Off by default: the first failure stops the run and is reported. */
  readonly continueOnError?: boolean;
}

/**
 * Apply a plan.
 *
 * PER-RECORD ATOMICITY IS THE DATABASE'S. `addItem` is one `cat_add_item_ct` call, which takes the per-item
 * lock, writes the lifecycle events, the ciphertext and the refs, and either commits all of that or none of
 * it. A record that fails leaves no partial row behind.
 *
 * WHOLE-RUN ATOMICITY IS NOT CLAIMED, AND IS NOT NEEDED. Wrapping every record in one transaction would mean
 * holding a key-custodian provisioning across it, which is exactly the failure matrix `provisionAndWrite`
 * exists to avoid. Instead the run is RESUMABLE: identities are derived, so re-running the same file after a
 * failure re-attempts only what did not land and leaves what did alone. The report says which is which.
 */
export async function applyCatalogImport(
  snapshot: NormalizedSnapshot,
  plan: CatalogImportPlan,
  authority: Pick<CatalogAuthority, 'addItem' | 'updateIdentity'>,
  options: ApplyOptions = {},
): Promise<CatalogImportResult> {
  const byId = new Map<string, NormalizedSnapshotItem>(snapshot.items.map((i) => [i.itemId, i]));
  const results: AppliedImportItem[] = [];
  let created = 0;
  let updated = 0;
  let failed = 0;
  let stopped = false;

  for (const planned of plan.items) {
    if (planned.action === 'unchanged' || planned.action === 'blocked') {
      results.push({
        digest: planned.digest,
        action: planned.action,
        outcome: 'skipped',
        ...(planned.reason === undefined ? {} : { reason: planned.reason }),
      });
      continue;
    }
    if (stopped) {
      // Reported, never omitted: "we stopped before this one" and "this one is already there" are different
      // facts and the report must not blur them.
      results.push({ digest: planned.digest, action: planned.action, outcome: 'not-attempted', reason: 'the run stopped at an earlier failure' });
      continue;
    }
    const item = byId.get(planned.itemId)!;
    const identity = {
      title: item.title,
      year: item.year,
      externalIds: { [snapshot.source]: item.externalId },
      metadata: Object.keys(item.metadata).length > 0 ? { ...item.metadata } : null,
      providerRefs: item.providerRefs.map((r) => ({ type: r.type, value: r.value })),
    };
    try {
      if (planned.action === 'create') { await authority.addItem(planned.itemId, identity); created += 1; }
      else { await authority.updateIdentity(planned.itemId, identity); updated += 1; }
      results.push({ digest: planned.digest, action: planned.action, outcome: 'applied' });
    } catch (err) {
      failed += 1;
      // The message is the authority's own, which never contains identity. It is passed through rather than
      // re-worded so an operator can match it against the database's own vocabulary.
      results.push({ digest: planned.digest, action: planned.action, outcome: 'failed', reason: (err as Error).message });
      if (options.continueOnError !== true) stopped = true;
    }
  }

  const notAttempted = results.filter((r) => r.outcome === 'not-attempted').length;
  const notes: string[] = [];
  if (plan.counts.blocked > 0) notes.push(`${plan.counts.blocked} record(s) were skipped because those items were forgotten; an import cannot undo an erasure.`);
  if (failed > 0) notes.push('Re-running the same snapshot re-attempts only what did not land: item ids are derived, and a record that is already present is left alone.');
  if (failed === 0 && created === 0 && updated === 0) notes.push('Nothing changed: every record in this snapshot was already present and active.');

  return {
    ok: failed === 0 && notAttempted === 0,
    report: 'phase-259-catalog-import',
    mode: 'apply',
    source: snapshot.source,
    snapshotDigest: snapshot.digest,
    total: plan.total,
    created,
    updated,
    unchanged: plan.counts.unchanged,
    blocked: plan.counts.blocked,
    failed,
    notAttempted,
    items: results,
    notes,
  };
}

/**
 * The human-readable summary.
 *
 * Counts, a per-record digest and an action. No title, no provider ref value, no metadata value, no external
 * id and no filesystem path appears anywhere in it, so the whole thing is safe to paste into an issue.
 */
export function renderCatalogImportResult(result: CatalogImportResult): string {
  const lines: string[] = [];
  lines.push(`Catalog import — ${result.mode === 'preview' ? 'PREVIEW (nothing was written)' : 'APPLIED'}`);
  lines.push(`  source            ${result.source}`);
  lines.push(`  snapshot digest   ${result.snapshotDigest.slice(0, 16)}`);
  lines.push(`  records           ${result.total}`);
  lines.push(`  create            ${result.created}`);
  lines.push(`  update            ${result.updated}`);
  lines.push(`  already present   ${result.unchanged}`);
  lines.push(`  blocked           ${result.blocked}`);
  if (result.mode === 'apply') {
    lines.push(`  failed            ${result.failed}`);
    lines.push(`  not attempted     ${result.notAttempted}`);
  }
  const problems = result.items.filter((i) => i.outcome === 'failed' || i.action === 'blocked' || i.outcome === 'not-attempted');
  if (problems.length > 0) {
    lines.push('  records needing attention:');
    for (const item of problems.slice(0, 25)) {
      lines.push(`    ${item.digest}  ${item.outcome}${item.reason === undefined ? '' : ` — ${item.reason}`}`);
    }
    if (problems.length > 25) lines.push(`    ... and ${problems.length - 25} more`);
  }
  for (const note of result.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${result.ok ? 'OK' : 'INCOMPLETE'}`);
  return lines.join('\n');
}
