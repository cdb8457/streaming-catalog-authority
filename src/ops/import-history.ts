import type { Pool } from 'pg';

// Phase 264 — the durable, identity-free record of what was imported into this installation.
//
// WHY IT EXISTS. Once applying an import is something a person does from a browser, "what did I already
// load, and when?" becomes a question the product has to be able to answer. The in-memory log buffer cannot:
// it holds 200 entries and dies with the container. The answer has to outlive both, so it lives in the
// database, in a table whose shape makes an unsafe row impossible rather than merely unwritten.
//
// WHAT A ROW CONTAINS. Counts, an outcome, two digests, the snapshot's own `source` label and the base NAME
// of the file. That is the complete list. There is no title, no year, no provider ref value, no external id,
// no metadata value, no item id, no ciphertext and no path — `file_name` is CHECK-constrained to a single
// path-free component in the schema itself, so a directory cannot reach the column even if a caller tried.
//
// HOW IT IS WRITTEN. Through `cat_import_record`, a SECURITY DEFINER function, exactly like the publish
// ledger. The runtime role holds SELECT on the table and EXECUTE on that one function: it can append and
// read, and it has no UPDATE or DELETE path at all.

export const IMPORT_HISTORY_MAX_ROWS = 50;

export type ImportActor = 'cli' | 'operator-ui';
export type ImportOutcome = 'complete' | 'incomplete';

export interface ImportHistoryEntry {
  readonly id: string;
  readonly appliedAt: string;
  readonly actor: ImportActor;
  readonly source: string;
  readonly fileName: string;
  /** Short, non-reversible, and enough to tell two imports apart at a glance. */
  readonly snapshotDigest: string;
  readonly contentDigest: string;
  readonly total: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly blocked: number;
  readonly failed: number;
  readonly outcome: ImportOutcome;
}

export interface ImportHistoryRecord {
  readonly actor: ImportActor;
  readonly source: string;
  readonly fileName: string;
  readonly snapshotDigest: string;
  readonly contentDigest: string;
  readonly total: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly blocked: number;
  readonly failed: number;
  readonly outcome: ImportOutcome;
}

export interface ImportHistoryStore {
  record(entry: ImportHistoryRecord): Promise<void>;
  list(limit: number): Promise<readonly ImportHistoryEntry[]>;
}

/**
 * The database-backed store.
 *
 * Two statements, both parameterised. The write is the SECURITY DEFINER function and nothing else; the read
 * is one bounded SELECT with a deterministic order (newest first, id as the tie-break so two imports in the
 * same millisecond still have one fixed order).
 */
export function createImportHistoryStore(pool: Pool): ImportHistoryStore {
  return {
    record: async (entry) => {
      await pool.query(
        'SELECT cat_import_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [
          entry.actor, entry.source, entry.fileName, entry.snapshotDigest, entry.contentDigest,
          entry.total, entry.created, entry.updated, entry.unchanged, entry.blocked, entry.failed, entry.outcome,
        ],
      );
    },
    list: async (limit) => {
      const bounded = Math.max(1, Math.min(Math.trunc(limit), IMPORT_HISTORY_MAX_ROWS));
      const { rows } = await pool.query(
        `SELECT id, applied_at, actor, source, file_name, snapshot_digest, content_digest,
                total, created, updated, unchanged, blocked, failed, outcome
           FROM import_history ORDER BY applied_at DESC, id DESC LIMIT $1`,
        [bounded],
      );
      return rows.map((row) => ({
        id: String(row.id),
        appliedAt: (row.applied_at as Date).toISOString(),
        actor: row.actor as ImportActor,
        source: row.source as string,
        fileName: row.file_name as string,
        snapshotDigest: row.snapshot_digest as string,
        contentDigest: row.content_digest as string,
        total: Number(row.total),
        created: Number(row.created),
        updated: Number(row.updated),
        unchanged: Number(row.unchanged),
        blocked: Number(row.blocked),
        failed: Number(row.failed),
        outcome: row.outcome as ImportOutcome,
      }));
    },
  };
}

/** One line per import, for a CLI or a support report. Counts and digests only. */
export function renderImportHistory(entries: readonly ImportHistoryEntry[]): string {
  if (entries.length === 0) return '  no imports have been applied to this installation';
  return entries.map((entry) =>
    `  ${entry.appliedAt}  ${entry.actor.padEnd(11)}  ${entry.source}  ${entry.fileName}  `
    + `create=${entry.created} update=${entry.updated} same=${entry.unchanged} `
    + `blocked=${entry.blocked} failed=${entry.failed}  ${entry.outcome.toUpperCase()} `
    + `(${entry.snapshotDigest.slice(0, 12)})`).join('\n');
}
