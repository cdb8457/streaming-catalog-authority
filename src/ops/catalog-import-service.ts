import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { CatalogAuthority } from '../core/catalog/authority.js';
import { type NormalizedSnapshot, parseCatalogSnapshot } from '../core/catalog/import-snapshot.js';
import {
  type CatalogImportPlan,
  type CatalogImportResult,
  type ExistingStateLookup,
  applyCatalogImport,
  planCatalogImport,
  previewCatalogImportResult,
  readCatalogSnapshotText,
  resolveImportFile,
} from './catalog-import.js';
import type { ImportActor, ImportHistoryStore } from './import-history.js';

// Phase 264 — the ONE implementation of "preview an import" and "apply an import".
//
// WHY THIS FILE EXISTS. Adding a browser path to a workflow that already had a command-line path is how two
// implementations of the same operation come into being, and how they then drift: a bound tightened in one,
// a blocked-item rule fixed in the other, and an operator whose preview and apply disagree depending on
// which surface they used. `ops:catalog-import` and the `/api/import/*` routes call the functions here and
// nothing else, so the preview a person reads in a terminal and the preview they read in a browser are
// produced by the same code, and so is the apply behind each.
//
// WHAT IS SHARED, PRECISELY. Parsing and validation (`parseCatalogSnapshot`), planning against the database
// (`planCatalogImport`), the preview projection, the apply loop, and the history record. What is NOT shared
// is how the file was CHOSEN — the CLI takes a path from an operator who already has shell access, the UI
// takes a name from a closed listing of one read-only folder — because those are genuinely different
// questions with genuinely different threat models, and pretending otherwise would mean the browser could
// name a path.
//
// A PREVIEW WRITES NOTHING, STRUCTURALLY. `previewImport` takes a lookup function and no authority and no
// history store. There is no object in its scope that could write a catalog row, an event or a history row,
// so "the preview wrote nothing" is a property of what it was handed rather than a claim about what it did.

/** The digest of the exact bytes on disk. What binds a preview to the apply that follows it. */
export function contentDigestOf(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export interface PreviewedImport {
  readonly snapshot: NormalizedSnapshot;
  readonly plan: CatalogImportPlan;
  readonly result: CatalogImportResult;
  readonly contentDigest: string;
  readonly bytes: number;
}

export interface PreviewImportInput {
  /** The snapshot document, already read as text by whoever resolved it. */
  readonly text: string;
  readonly lookup: ExistingStateLookup;
  readonly updateExisting?: boolean;
}

/**
 * Parse, validate, plan — and produce the preview.
 *
 * Throws `CatalogImportError` with every problem it found when the document is not valid, before it has
 * asked the database anything at all.
 */
export async function previewImport(input: PreviewImportInput): Promise<PreviewedImport> {
  const snapshot = parseCatalogSnapshot(input.text);
  const plan = await planCatalogImport(snapshot, input.lookup, { updateExisting: input.updateExisting === true });
  return {
    snapshot,
    plan,
    result: previewCatalogImportResult(plan),
    contentDigest: contentDigestOf(input.text),
    bytes: Buffer.byteLength(input.text, 'utf8'),
  };
}

export interface ApplyImportInput extends PreviewImportInput {
  /**
   * The digest of the exact BYTES on disk, when the caller already has it.
   *
   * The HTTP path verified a confirmation against the raw bytes; recomputing the digest here from the decoded
   * text would record a different value in the history for any file that is not clean UTF-8, so the digest
   * that was CHECKED and the digest that is RECORDED would be two different numbers describing one file.
   * Omitted by callers that only ever had the text.
   */
  readonly contentDigest?: string;
  readonly authority: Pick<CatalogAuthority, 'addItem' | 'updateIdentity'>;
  /** Where the durable record goes. Omitted only where there is no database to write it to. */
  readonly history?: ImportHistoryStore;
  readonly actor: ImportActor;
  /** The base name of the file, for the history row. Never a path — the store's schema refuses one. */
  readonly fileName: string;
  readonly continueOnError?: boolean;
}

export interface AppliedImport {
  readonly snapshot: NormalizedSnapshot;
  readonly plan: CatalogImportPlan;
  readonly result: CatalogImportResult;
  readonly contentDigest: string;
  /** True when the durable history row was written. False means the import happened and the record did not. */
  readonly recorded: boolean;
}

/**
 * Plan and apply, then record what happened.
 *
 * THE PLAN IS RECOMPUTED HERE rather than carried from the preview. The preview's plan describes the
 * database as it was when the preview ran; between then and now another import, a forget or a restore may
 * have moved a record. Re-planning means the apply acts on what is true now, and the confirmation binding
 * (which pins the FILE) plus the plan (which pins the DATABASE) together are what make the outcome the one
 * the operator was shown — or a smaller one, never a larger one, because every action is derived per record.
 *
 * THE HISTORY ROW IS BEST-EFFORT AND SAYS SO. An import that succeeded and a history row that failed is an
 * honest `recorded: false`, not a failed import: the catalog write already happened and pretending it did
 * not would be worse than an incomplete audit trail. The caller surfaces it.
 */
export async function applyImport(input: ApplyImportInput): Promise<AppliedImport> {
  const snapshot = parseCatalogSnapshot(input.text);
  const plan = await planCatalogImport(snapshot, input.lookup, { updateExisting: input.updateExisting === true });
  const result = await applyCatalogImport(snapshot, plan, input.authority, {
    updateExisting: input.updateExisting === true,
    continueOnError: input.continueOnError === true,
  });

  const contentDigest = input.contentDigest ?? contentDigestOf(input.text);
  let recorded = false;
  if (input.history !== undefined) {
    try {
      await input.history.record({
        actor: input.actor,
        source: result.source,
        // `basename` is belt-and-braces: the callers already pass a base name, and the column's own CHECK
        // would reject anything with a separator in it. Three independent places, none of them relying on
        // the other two being right.
        fileName: basename(input.fileName),
        snapshotDigest: result.snapshotDigest,
        contentDigest,
        total: result.total,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        blocked: result.blocked,
        failed: result.failed,
        outcome: result.ok ? 'complete' : 'incomplete',
      });
      recorded = true;
    } catch {
      recorded = false;
    }
  }

  return { snapshot, plan, result, contentDigest, recorded };
}

/**
 * Read a snapshot the way the COMMAND LINE resolves one: a path the operator named, contained inside
 * `CATALOG_IMPORT_DIR` when one is configured.
 *
 * Kept here so the CLI and the routes share one notion of "the text and its digest", while keeping their
 * genuinely different resolution rules apart. `readCatalogSnapshot` is still what validates; this adds only
 * the raw text, which the CLI needs for the content digest that goes into the history row.
 */
export function readCliSnapshot(requested: string, env: NodeJS.ProcessEnv = process.env): {
  readonly path: string; readonly fileName: string; readonly text: string; readonly snapshot: NormalizedSnapshot;
} {
  const path = resolveImportFile(requested, env);
  // ONE read. `readCatalogSnapshotText` applies the same regular-file and size guards the CLI has always
  // had, and the parse below works on exactly the bytes that were read — so the text, the digest and the
  // document all describe the same moment.
  const text = readCatalogSnapshotText(path);
  return { path, fileName: basename(path), text, snapshot: parseCatalogSnapshot(text) };
}
