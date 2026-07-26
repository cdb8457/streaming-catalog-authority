import type { IncomingMessage } from 'node:http';
import { CatalogImportError } from '../core/catalog/import-snapshot.js';
import type { CatalogAuthority } from '../core/catalog/authority.js';
import type { ExistingStateLookup } from './catalog-import.js';
import { CatalogInboxError, listImportInbox, readInboxFile } from './catalog-import-inbox.js';
import { ImportConfirmations } from './catalog-import-confirmation.js';
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

export type ImportBodyRejection =
  | 'TOO_LARGE' | 'NOT_JSON' | 'BAD_CONTENT_TYPE' | 'CROSS_ORIGIN' | 'UNREADABLE' | 'BAD_SHAPE';

export type ImportBodyResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly rejection: ImportBodyRejection; readonly message: string };

const BODY_REJECTION_MESSAGES: Record<ImportBodyRejection, string> = {
  TOO_LARGE: 'That request is larger than this endpoint accepts. It carries a file name and a confirmation, and nothing else.',
  NOT_JSON: 'That request body is not valid JSON.',
  BAD_CONTENT_TYPE: 'This endpoint accepts application/json only.',
  CROSS_ORIGIN: 'This endpoint accepts requests from its own page only.',
  UNREADABLE: 'That request body could not be read.',
  BAD_SHAPE: 'That request body is not the shape this endpoint accepts.',
};

/**
 * Is this request allowed to be a write at all?
 *
 * Checked BEFORE the body is read, so a refused request never causes bytes to be buffered. Absent headers are
 * ALLOWED on purpose: `curl`, the shipped acceptance harness and a request from a script legitimately send
 * neither `Origin` nor `Sec-Fetch-Site`, and refusing those would break the documented command-line path
 * without stopping any browser — a browser always sends `Origin` on a cross-origin request, which is exactly
 * the case being refused. The token in a custom header is what carries the authority either way.
 */
export function checkWriteRequestHeaders(req: Pick<IncomingMessage, 'headers'>): ImportBodyResult | null {
  const contentType = header(req, 'content-type');
  if (contentType === undefined) return bodyReject('BAD_CONTENT_TYPE');
  const mediaType = contentType.split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/json') return bodyReject('BAD_CONTENT_TYPE');

  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return bodyReject('CROSS_ORIGIN');

  const origin = header(req, 'origin');
  if (origin !== undefined && origin !== 'null') {
    const host = header(req, 'host');
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return bodyReject('CROSS_ORIGIN');
    }
    // HOST AND PORT, DELIBERATELY NOT THE SCHEME. This service speaks plain HTTP, and a documented,
    // supported deployment puts it behind a reverse proxy that terminates TLS — in which case the browser's
    // Origin is `https://…` while the request that reaches here is `http://`. Comparing the scheme would
    // refuse every proxied installation while buying almost nothing: an origin that differs only by scheme
    // requires an attacker to already be serving TLS on this exact host and port, and a cross-SITE page —
    // the thing this check exists to refuse — always differs by host.
    if (host === undefined || originHost !== host) return bodyReject('CROSS_ORIGIN');
  }
  return null;
}

/**
 * Read a bounded JSON object body.
 *
 * The bound is enforced as bytes arrive rather than after: a caller that streams megabytes at this endpoint
 * is disconnected at the limit, not buffered to it. A `Content-Length` that already exceeds the bound is
 * refused before a single chunk is read.
 */
export async function readImportRequestBody(req: IncomingMessage): Promise<ImportBodyResult> {
  const headerCheck = checkWriteRequestHeaders(req);
  if (headerCheck !== null) { req.resume(); return headerCheck; }

  const declared = header(req, 'content-length');
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0 || length > IMPORT_REQUEST_MAX_BYTES) {
      req.resume();
      return bodyReject('TOO_LARGE');
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.byteLength;
      if (total > IMPORT_REQUEST_MAX_BYTES) {
        // PAUSE, do not destroy. Destroying the request tears the socket down before the refusal can be
        // written, so the caller sees a hung-up connection instead of "that request is too large" — a
        // correct refusal that reads as a crash. Pausing stops reading immediately (nothing further is
        // buffered), and Node closes the connection after the response because the body was not consumed.
        req.pause();
        return bodyReject('TOO_LARGE');
      }
      chunks.push(buffer);
    }
  } catch {
    return bodyReject('UNREADABLE');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return bodyReject('NOT_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyReject('BAD_SHAPE');
  return { ok: true, value: parsed as Record<string, unknown> };
}

export function importBodyRejectionResponse(result: Extract<ImportBodyResult, { ok: false }>): ImportEndpointResponse {
  return {
    status: result.rejection === 'TOO_LARGE' ? 413 : result.rejection === 'CROSS_ORIGIN' ? 403 : 400,
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

function bodyReject(rejection: ImportBodyRejection): ImportBodyResult {
  return { ok: false, rejection, message: BODY_REJECTION_MESSAGES[rejection] };
}

function header(req: Pick<IncomingMessage, 'headers'>, name: string): string | undefined {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}
