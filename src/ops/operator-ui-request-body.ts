import type { IncomingMessage } from 'node:http';

// Phase 267 — the bounded JSON body reader, shared by every write surface in the operator UI.
//
// WHY IT MOVED HERE. Phase 264 wrote this for the import, which was then the only route in this service that
// accepted a POST. Phase 267/268 adds a second write surface (the collection control plane), and a second
// copy of "refuse a cross-origin request, refuse a body that is not declared JSON, and stop reading at the
// bound" is a second place for those three checks to drift apart. There is now one implementation and every
// write route calls it. The import's public names are kept as thin aliases so nothing that already depended
// on them had to change.
//
// CSRF AND THE CONFUSED DEPUTY, RESTATED BECAUSE IT NOW COVERS MORE. This service holds NO ambient
// credential: no cookie, no session, no browser-managed authenticator, so a cross-site request carries no
// authority to abuse. On top of that structural fact, three checks make an accidental or forged cross-origin
// write fail before it reaches any logic: the operator token must arrive in a CUSTOM header (which a
// cross-origin page cannot set without a CORS preflight this service never approves — it sends no CORS
// headers at all), the body must be declared `application/json` (which excludes every "simple request" a
// plain HTML form can make), and an `Origin` or `Sec-Fetch-Site` that says the request came from somewhere
// else is refused outright.
//
// THE BOUND IS PER-ROUTE AND ENFORCED AS BYTES ARRIVE. An import request carries a file name and a
// confirmation and is tiny; a collection plan carries up to five hundred record identifiers and is not. Each
// route states its own maximum, and a caller that streams past it is disconnected at the limit rather than
// buffered to it.

export type WriteBodyRejection =
  | 'TOO_LARGE' | 'NOT_JSON' | 'BAD_CONTENT_TYPE' | 'CROSS_ORIGIN' | 'UNREADABLE' | 'BAD_SHAPE';

export type WriteBodyResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly rejection: WriteBodyRejection; readonly message: string };

export const WRITE_BODY_REJECTION_MESSAGES: Record<WriteBodyRejection, string> = {
  TOO_LARGE: 'That request is larger than this endpoint accepts.',
  NOT_JSON: 'That request body is not valid JSON.',
  BAD_CONTENT_TYPE: 'This endpoint accepts application/json only.',
  CROSS_ORIGIN: 'This endpoint accepts requests from its own page only.',
  UNREADABLE: 'That request body could not be read.',
  BAD_SHAPE: 'That request body is not the shape this endpoint accepts.',
};

/** The HTTP status each rejection answers with. A refusal about size is not a refusal about origin. */
export function writeBodyRejectionStatus(rejection: WriteBodyRejection): number {
  if (rejection === 'TOO_LARGE') return 413;
  if (rejection === 'CROSS_ORIGIN') return 403;
  return 400;
}

/**
 * Is this request allowed to be a write at all?
 *
 * Checked BEFORE the body is read, so a refused request never causes bytes to be buffered. Absent headers are
 * ALLOWED on purpose: `curl`, the shipped acceptance harness and a request from a script legitimately send
 * neither `Origin` nor `Sec-Fetch-Site`, and refusing those would break the documented command-line path
 * without stopping any browser — a browser always sends `Origin` on a cross-origin request, which is exactly
 * the case being refused. The token in a custom header is what carries the authority either way.
 */
export function checkWriteRequestHeaders(req: Pick<IncomingMessage, 'headers'>): WriteBodyResult | null {
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
export async function readJsonRequestBody(req: IncomingMessage, maxBytes: number): Promise<WriteBodyResult> {
  const headerCheck = checkWriteRequestHeaders(req);
  if (headerCheck !== null) { req.resume(); return headerCheck; }

  const declared = header(req, 'content-length');
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0 || length > maxBytes) {
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
      if (total > maxBytes) {
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

function bodyReject(rejection: WriteBodyRejection): WriteBodyResult {
  return { ok: false, rejection, message: WRITE_BODY_REJECTION_MESSAGES[rejection] };
}

function header(req: Pick<IncomingMessage, 'headers'>, name: string): string | undefined {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}
