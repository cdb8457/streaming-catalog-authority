import type { IncomingMessage } from 'node:http';
import { CatalogImportError } from '../core/catalog/import-snapshot.js';
import type { CatalogAuthority } from '../core/catalog/authority.js';
import type { ExistingStateLookup } from './catalog-import.js';
import {
  CatalogInboxError,
  CatalogInboxUnsupportedPlatformError,
  listImportInbox,
  readInboxFile,
} from './catalog-import-inbox.js';
import { ImportConfirmations } from './catalog-import-confirmation.js';
import {
  checkWriteRequestHeaders,
  readJsonRequestBody,
  writeBodyRejectionStatus,
  type WriteBodyRejection,
  type WriteBodyResult,
} from './operator-ui-request-body.js';
import { applyImport, previewImport } from './catalog-import-service.js';
import type { ImportHistoryStore } from './import-history.js';
import { IMPORT_HISTORY_MAX_ROWS } from './import-history.js';

// Phase 264 — the authenticated, controlled-WRITE import surface of the operator UI.
//
// THIS IS THE ONE PLACE IN THIS UI THAT CAN WRITE ANYTHING, and everything about it is built to make that
// obvious and bounded. Every other route in the service is a GET that ends in a SELECT. These four are
// deliberately separated: a distinct path prefix, distinct methods, a distinct panel, and a two-step flow in
// which the first step is structurally incapable of writing.
//
// WHERE A SNAPSHOT MAY COME FROM: one read-only mounted folder, and nowhere else. The browser sends a NAME
// from a listing this service produced, never a path. No URL is fetched, no file is uploaded, no provider,
// media server or library is contacted, no directory is walked, and no host or container path is accepted.
// See catalog-import-inbox.ts for the four independent containment checks.
//
// PREVIEW IS MANDATORY AND PROVABLY WRITES NOTHING. `previewImport` is handed a read-only lookup function
// and no authority and no history store — there is no object in its scope that could write a catalog row, an
// event or a history row. "The preview wrote nothing" is therefore a property of what it was given, not a
// claim about what it did.
//
// APPLY IS BOUND TO THE EXACT PREVIEWED BYTES. A preview issues a signed, single-use, expiring confirmation
// naming the file, its size and the sha256 of its contents. The apply re-reads the file, recomputes that
// digest, and refuses when anything differs — a substituted file, a different row, a stale tab, a replay, or
// a confirmation from a different process. See catalog-import-confirmation.ts.
//
// CSRF AND THE CONFUSED DEPUTY. This service holds NO ambient credential: there is no cookie, no session and
// no browser-managed authenticator, so a cross-site request carries no authority to abuse. On top of that
// structural fact, three checks make an accidental or forged cross-origin write fail before it reaches any
// logic: the operator token must arrive in a CUSTOM header (which a cross-origin page cannot set without a
// CORS preflight this service never approves — it sends no CORS headers at all), the body must be declared
// `application/json` (which excludes every "simple request" a plain HTML form can make), and an `Origin` or
// `Sec-Fetch-Site` that says the request came from somewhere else is refused outright.
//
// EVERYTHING FAILS CLOSED. A body that is too large, not JSON, the wrong shape, or arrives slowly is refused
// without being parsed further. A snapshot that does not validate is refused whole, before the database is
// asked anything. A confirmation that does not verify is refused before a single record is written.

export const IMPORT_INBOX_ROUTE = '/api/import/inbox';
export const IMPORT_PREVIEW_ROUTE = '/api/import/preview';
export const IMPORT_APPLY_ROUTE = '/api/import/apply';
export const IMPORT_HISTORY_ROUTE = '/api/import/history';

export const IMPORT_ROUTES: readonly string[] = [
  IMPORT_INBOX_ROUTE, IMPORT_PREVIEW_ROUTE, IMPORT_APPLY_ROUTE, IMPORT_HISTORY_ROUTE,
];

/** The request body carries a file name and a confirmation. Nothing legitimate is anywhere near this big. */
export const IMPORT_REQUEST_MAX_BYTES = 4096;

export const IMPORT_REPORT = 'phase-264-catalog-import-workflow';

export interface ImportEndpointResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * The import's own names for the shared write-body machinery.
 *
 * Phase 267 moved the implementation to `operator-ui-request-body.ts` so the second write surface (the
 * collection control plane) could not grow a second copy of the cross-origin, content-type and size checks.
 * These aliases keep the import's public API exactly as it was.
 */
export type ImportBodyRejection = WriteBodyRejection;
export type ImportBodyResult = WriteBodyResult;

export { checkWriteRequestHeaders };

/** Read the import's bounded JSON body. A file name and a confirmation, and nothing else, fits easily. */
export function readImportRequestBody(req: IncomingMessage): Promise<ImportBodyResult> {
  return readJsonRequestBody(req, IMPORT_REQUEST_MAX_BYTES);
}

export function importBodyRejectionResponse(result: Extract<ImportBodyResult, { ok: false }>): ImportEndpointResponse {
  return {
    status: writeBodyRejectionStatus(result.rejection),
    body: {
      ok: false,
      code: `OPERATOR_UI_IMPORT_${result.rejection}`,
      report: IMPORT_REPORT,
      message: result.message,
    },
  };
}

export interface ImportEndpointDeps {
  /** How the plan asks the database what already exists. A read; there is no write in this function. */
  readonly lookup: ExistingStateLookup;
  /** Present only on the apply path. A preview is never given one. */
  readonly authority?: Pick<CatalogAuthority, 'addItem' | 'updateIdentity'>;
  readonly history?: ImportHistoryStore;
  readonly confirmations: ImportConfirmations;
  readonly env?: NodeJS.ProcessEnv;
}

/** GET the inbox. A read of one configured directory; the request contributes nothing to it. */
export function importInboxResponse(env: NodeJS.ProcessEnv = process.env): ImportEndpointResponse {
  const listing = listImportInbox(env);
  return {
    status: 200,
    body: {
      ok: true,
      code: 'OPERATOR_UI_IMPORT_INBOX',
      report: IMPORT_REPORT,
      state: listing.state,
      candidates: listing.candidates,
      skipped: listing.skipped,
      truncated: listing.truncated,
      guidance: listing.guidance,
    },
  };
}

/**
 * POST a preview.
 *
 * Nothing here can write. The only database access is `deps.lookup`, which is a SELECT, and no authority or
 * history store is passed to `previewImport` at all.
 */
export async function importPreviewResponse(
  body: Record<string, unknown>,
  deps: ImportEndpointDeps,
): Promise<ImportEndpointResponse> {
  const env = deps.env ?? process.env;
  const updateExisting = body.updateExisting === true;

  let file: ReturnType<typeof readInboxFile>;
  try {
    file = readInboxFile(body.file, env);
  } catch (err) {
    // A platform that cannot open a file safely is a 503 about the INSTALLATION, not a 400 about the file:
    // reporting it as a bad file would send an operator to check a file that is perfectly fine.
    if (err instanceof CatalogInboxUnsupportedPlatformError) {
      return refusal(503, 'IMPORT_UNSUPPORTED_PLATFORM', err.message);
    }
    if (err instanceof CatalogInboxError) return refusal(400, 'IMPORT_FILE_REJECTED', err.message);
    return refusal(503, 'IMPORT_INBOX_UNAVAILABLE', 'The import folder could not be read.');
  }

  let previewed: Awaited<ReturnType<typeof previewImport>>;
  try {
    previewed = await previewImport({ text: file.text, lookup: deps.lookup, updateExisting });
  } catch (err) {
    if (err instanceof CatalogImportError) {
      return {
        status: 400,
        body: {
          ok: false,
          code: 'OPERATOR_UI_IMPORT_SNAPSHOT_REJECTED',
          report: IMPORT_REPORT,
          message: 'That snapshot was rejected and nothing was written. Every problem found is listed below; '
            + 'each one names a field and a position, never a value.',
          // The parser's own problems. By construction they carry field names and positions and never a
          // title, a provider ref value, a metadata value or an external id.
          problems: previewProblems(err),
        },
      };
    }
    return refusal(503, 'IMPORT_UNAVAILABLE', 'The snapshot could not be checked against this installation.');
  }

  const confirmation = deps.confirmations.issue({
    name: file.name,
    bytes: file.bytes,
    contentDigest: file.contentDigest,
    snapshotDigest: previewed.snapshot.digest,
    source: previewed.snapshot.source,
    updateExisting,
  });

  return {
    status: 200,
    body: {
      ok: true,
      code: 'OPERATOR_UI_IMPORT_PREVIEW',
      report: IMPORT_REPORT,
      // Said in the body as well as proved by the design, because this is the sentence an operator acts on.
      wrote: 'nothing',
      file: { name: file.name, bytes: file.bytes, contentDigest: file.contentDigest },
      preview: previewed.result,
      confirmation,
      guidance: previewed.plan.noop
        ? 'Nothing would change: every record in this snapshot is already present and active. Applying it is '
          + 'safe and would write nothing.'
        : `Applying this would create ${previewed.plan.counts.create} record(s) and update `
          + `${previewed.plan.counts.update}. Nothing has been written yet.`,
    },
  };
}

/**
 * POST an apply.
 *
 * Requires a confirmation that verifies against the bytes on disk RIGHT NOW. The file is re-read here rather
 * than carried from the preview — that re-read is the whole point, because it is what detects a file that
 * changed in between.
 */
export async function importApplyResponse(
  body: Record<string, unknown>,
  deps: ImportEndpointDeps,
): Promise<ImportEndpointResponse> {
  const env = deps.env ?? process.env;
  if (deps.authority === undefined) {
    return refusal(503, 'IMPORT_UNAVAILABLE', 'This installation cannot write to its catalog right now. Check Setup & Diagnostics.');
  }

  let file: ReturnType<typeof readInboxFile>;
  try {
    file = readInboxFile(body.file, env);
  } catch (err) {
    // A platform that cannot open a file safely is a 503 about the INSTALLATION, not a 400 about the file:
    // reporting it as a bad file would send an operator to check a file that is perfectly fine.
    if (err instanceof CatalogInboxUnsupportedPlatformError) {
      return refusal(503, 'IMPORT_UNSUPPORTED_PLATFORM', err.message);
    }
    if (err instanceof CatalogInboxError) return refusal(400, 'IMPORT_FILE_REJECTED', err.message);
    return refusal(503, 'IMPORT_INBOX_UNAVAILABLE', 'The import folder could not be read.');
  }

  const verdict = deps.confirmations.verify(body.confirmation, file.contentDigest, file.bytes);
  if (!verdict.ok) {
    return {
      status: verdict.rejection === 'TOO_MANY_OUTSTANDING' ? 503 : 409,
      body: {
        ok: false,
        code: `OPERATOR_UI_IMPORT_CONFIRMATION_${verdict.rejection}`,
        report: IMPORT_REPORT,
        wrote: 'nothing',
        message: verdict.message,
      },
    };
  }
  // The confirmation named a file; the request named a file. They must be the same one — a confirmation is a
  // statement about a specific snapshot, not a licence to import whichever one is asked for next.
  if (verdict.claims.name !== file.name) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'OPERATOR_UI_IMPORT_CONFIRMATION_FILE_MISMATCH',
        report: IMPORT_REPORT,
        wrote: 'nothing',
        message: 'That confirmation was issued for a different snapshot file. Preview the one you want and confirm from its preview.',
      },
    };
  }

  let applied: Awaited<ReturnType<typeof applyImport>>;
  try {
    applied = await applyImport({
      text: file.text,
      // The digest the confirmation was CHECKED against, carried through so the history records the same
      // number rather than one recomputed from the decoded text.
      contentDigest: file.contentDigest,
      lookup: deps.lookup,
      authority: deps.authority,
      history: deps.history,
      actor: 'operator-ui',
      fileName: file.name,
      updateExisting: verdict.claims.updateExisting,
    });
  } catch (err) {
    if (err instanceof CatalogImportError) {
      // The bytes verified against the confirmation, so this is a snapshot that parsed during the preview and
      // does not now — which can only mean the file changed in a way that kept its digest, i.e. it did not.
      // Refusing rather than half-importing is the only safe answer.
      return {
        status: 400,
        body: {
          ok: false, code: 'OPERATOR_UI_IMPORT_SNAPSHOT_REJECTED', report: IMPORT_REPORT, wrote: 'nothing',
          message: 'That snapshot was rejected and nothing was written.',
          problems: previewProblems(err),
        },
      };
    }
    return refusal(503, 'IMPORT_UNAVAILABLE', 'The import could not be completed. Check Setup & Diagnostics for this installation\'s state.');
  }

  return {
    status: applied.result.ok ? 200 : 207,
    body: {
      ok: applied.result.ok,
      code: 'OPERATOR_UI_IMPORT_APPLIED',
      report: IMPORT_REPORT,
      file: { name: file.name, bytes: file.bytes, contentDigest: file.contentDigest },
      result: applied.result,
      // An import that succeeded and a history row that did not is an honest fact, not a failed import.
      recorded: applied.recorded,
      guidance: importGuidance(applied),
    },
  };
}

function importGuidance(applied: Awaited<ReturnType<typeof applyImport>>): string {
  const parts: string[] = [];
  if (applied.result.created === 0 && applied.result.updated === 0 && applied.result.failed === 0) {
    parts.push('Nothing changed: every record in this snapshot was already present and active. Applying the same snapshot twice is safe and is the expected result.');
  } else {
    parts.push(`Imported: ${applied.result.created} created, ${applied.result.updated} updated, ${applied.result.unchanged} already present.`);
  }
  if (applied.result.blocked > 0) {
    parts.push(`${applied.result.blocked} record(s) were skipped because those items were forgotten; an import cannot undo an erasure.`);
  }
  if (applied.result.failed > 0) {
    parts.push('Some records failed. Re-previewing and applying the same snapshot re-attempts only what did not land.');
  }
  if (!applied.recorded) {
    parts.push('The catalog was written, but this import could not be added to the import history. The records are there; the history entry is not.');
  }
  return parts.join(' ');
}

/** GET the durable history. A bounded, ordered SELECT and nothing else. */
export async function importHistoryResponse(history: ImportHistoryStore | undefined): Promise<ImportEndpointResponse> {
  if (history === undefined) {
    return refusal(503, 'IMPORT_HISTORY_UNAVAILABLE', 'The import history could not be read. Check Setup & Diagnostics for this installation\'s state.');
  }
  try {
    const entries = await history.list(IMPORT_HISTORY_MAX_ROWS);
    return {
      status: 200,
      body: {
        ok: true,
        code: 'OPERATOR_UI_IMPORT_HISTORY',
        report: IMPORT_REPORT,
        entries,
        limit: IMPORT_HISTORY_MAX_ROWS,
        guidance: entries.length === 0
          ? 'No import has been applied to this installation yet. Both the Import panel and the command line '
            + 'record what they did here, so this stays true until one of them writes something.'
          : `The ${entries.length} most recent import${entries.length === 1 ? '' : 's'}, newest first. Counts and `
            + 'digests only — no record content is kept here.',
      },
    };
  } catch {
    return refusal(503, 'IMPORT_HISTORY_UNAVAILABLE', 'The import history could not be read. Check Setup & Diagnostics for this installation\'s state.');
  }
}

function refusal(status: number, code: string, message: string): ImportEndpointResponse {
  return { status, body: { ok: false, code: `OPERATOR_UI_${code}`, report: IMPORT_REPORT, wrote: 'nothing', message } };
}

/** The parser's problems, bounded for a response. Each one names a field and a position, never a value. */
function previewProblems(err: CatalogImportError): readonly string[] {
  return err.problems.slice(0, 50);
}

