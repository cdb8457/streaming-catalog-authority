// TorBox request-download-link resolver — the narrow, read-only adapter behind the generic resolver contract.
//
// WHAT THIS CLOSES. `docs/PHASE_41_TORBOX_ENDPOINT_MAPPING.md` future-gated the three `requestdl` endpoints
// "because they require token query parameters and can expose CDN/permalink URLs", and said they "require a
// later explicit phase". This is that phase, and it is deliberately the smallest one that can exist: three
// GET endpoints, one response field, and nothing else.
//
// THE OFFICIAL CONTRACT, VERIFIED AGAINST TORBOX'S OWN SDK SOURCE (see docs/PHASE_50_TORBOX_RESOLVER.md for
// the citations). All three are GET on `https://api.torbox.app`:
//
//   torrent   /v1/api/torrents/requestdl?token=…&torrent_id=…&file_id=…
//   webdl     /v1/api/webdl/requestdl?token=…&web_id=…&file_id=…
//   usenet    /v1/api/usenet/requestdl?token=…&usenet_id=…&file_id=…
//
// and all three answer `{ success: boolean, detail: string, error: any, data: string }`, where `data` is the
// CDN URL.
//
// THE SINGLE MOST IMPORTANT FACT ABOUT THIS ENDPOINT FAMILY: THE CREDENTIAL IS A QUERY PARAMETER.
//
// TorBox authenticates `requestdl` with `?token=<API key>` rather than an Authorization header. That makes
// the REQUEST URL ITSELF A BEARER CREDENTIAL — anything that logs a request URL, puts one in an error
// message, or reports one, has published the operator's API key. Every other adapter in this repository can
// afford to be relaxed about request URLs. This one cannot, and that is why this module never returns,
// stores or formats a request URL at all: it builds one, uses it, and drops it. `redactError` below exists
// because a thrown network error routinely carries the URL it failed to reach.
//
// WHAT IT REFUSES TO DO. It never creates, controls, edits, deletes or downloads a provider job; it never
// requests a permalink; it never sets `redirect=true` (which would answer with a 3xx to a CDN host rather
// than the JSON this contract needs, and the data plane refuses redirects anyway). The only verb is GET and
// the only effect is that TorBox opens an existing file's link for a while.

/** The three provider families TorBox exposes a `requestdl` endpoint for. */
export type TorBoxSourceKind = 'torrent' | 'webdl' | 'usenet';

export const TORBOX_SOURCE_KINDS: readonly TorBoxSourceKind[] =
  Object.freeze(['torrent', 'webdl', 'usenet']);

/** The default origin. Overridable only by configuration, never by a stable reference. */
export const TORBOX_API_ORIGIN = 'https://api.torbox.app';

/**
 * TorBox opens a link "for 3 hours"; the API returns no expiry field, so the lifetime is a documented
 * constant rather than an observation.
 *
 * THE GATE USES A DELIBERATELY SHORTER ONE. Treating a link as valid for the full documented window means
 * the first read after 2h59m races the expiry, and the failure mode is a user-visible stall rather than a
 * refresh. Two hours leaves an hour of headroom and costs one extra resolution per object per two hours,
 * which against a metered API is nothing.
 */
export const TORBOX_LINK_LIFETIME_MS = 3 * 60 * 60 * 1000;
export const TORBOX_ASSUMED_LIFETIME_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------
// The stable reference
// ---------------------------------------------------------------------------------------------------------

/**
 * A parsed stable reference: the MINIMUM that identifies one readable file at TorBox.
 *
 * `torbox:<kind>:<providerId>:<fileId>`
 *
 * WHY NOTHING ELSE IS IN IT. A stable reference is written into a manifest, stored in a database, and appears
 * in a daemon's memory and its source strings. Every field it carries is a field that has to be kept out of
 * logs forever. A name, a hash, a size or a category would each be one more thing to redact and none of them
 * are needed to fetch bytes: TorBox's own endpoints take exactly a kind, an item id and a file id.
 *
 * IT IS STILL NOT PUBLIC INFORMATION. The pair (item id, file id) identifies something in the operator's
 * account, so a reference is treated as a secret throughout: `parseStableRef` never echoes its input in a
 * failure message, and no function here formats one.
 */
export interface TorBoxStableRef {
  readonly kind: TorBoxSourceKind;
  readonly providerId: number;
  readonly fileId: number;
}

/** Numeric ids only, no leading zeros, no sign, bounded — so a reference cannot smuggle a path or a query. */
const ID_SHAPE = /^(0|[1-9][0-9]{0,17})$/;

export class TorBoxRefError extends Error {
  constructor(reason: string) {
    // THE REASON, NEVER THE INPUT. A malformed reference is still somebody's account data, and the one place
    // a parser is most tempted to quote its input is exactly where it must not.
    super(`the stable reference is not usable: ${reason}`);
    this.name = 'TorBoxRefError';
  }
}

/**
 * Parses `torbox:<kind>:<providerId>:<fileId>` and refuses everything else.
 *
 * STRICT BY CONSTRUCTION. Exactly four colon-separated fields, a known scheme, a known kind, and two integers
 * matching a shape that admits no whitespace, sign, decimal point, exponent or leading zero. Anything looser
 * lets a reference carry a second query parameter into a URL built from it.
 */
export function parseStableRef(raw: string): TorBoxStableRef {
  if (typeof raw !== 'string') throw new TorBoxRefError('it is not a string');
  if (raw.length > 128) throw new TorBoxRefError('it is longer than any legitimate reference');

  const parts = raw.split(':');
  if (parts.length !== 4) {
    throw new TorBoxRefError(`it has ${parts.length} colon-separated fields, not 4`);
  }
  const [scheme, kind, providerId, fileId] = parts as [string, string, string, string];

  if (scheme !== 'torbox') throw new TorBoxRefError('the scheme is not "torbox"');
  if (!TORBOX_SOURCE_KINDS.includes(kind as TorBoxSourceKind)) {
    throw new TorBoxRefError('the source kind is not one of torrent, webdl or usenet');
  }
  if (!ID_SHAPE.test(providerId)) throw new TorBoxRefError('the provider id is not a plain integer');
  if (!ID_SHAPE.test(fileId)) throw new TorBoxRefError('the file id is not a plain integer');

  const parsedProvider = Number(providerId);
  const parsedFile = Number(fileId);
  if (!Number.isSafeInteger(parsedProvider) || !Number.isSafeInteger(parsedFile)) {
    throw new TorBoxRefError('an id is outside the safe integer range');
  }
  return { kind: kind as TorBoxSourceKind, providerId: parsedProvider, fileId: parsedFile };
}

/** The inverse, for building a reference. Used by operator tooling, never by the resolver. */
export const formatStableRef = (ref: TorBoxStableRef): string =>
  `torbox:${ref.kind}:${ref.providerId}:${ref.fileId}`;

// ---------------------------------------------------------------------------------------------------------
// The endpoint mapping
// ---------------------------------------------------------------------------------------------------------

/** Path and id-parameter name per family, exactly as TorBox's own SDK spells them on the wire. */
export const TORBOX_REQUESTDL: Readonly<Record<TorBoxSourceKind,
{ readonly path: string; readonly idParam: string }>> = Object.freeze({
  torrent: { path: '/v1/api/torrents/requestdl', idParam: 'torrent_id' },
  webdl: { path: '/v1/api/webdl/requestdl', idParam: 'web_id' },
  usenet: { path: '/v1/api/usenet/requestdl', idParam: 'usenet_id' },
});

/**
 * The request URL for one reference.
 *
 * THE RETURN VALUE OF THIS FUNCTION IS A CREDENTIAL. It carries `token=<API key>` because that is the
 * contract TorBox publishes. Callers must use it and drop it: not log it, not store it, not put it in an
 * error. `URL` does the escaping, so a reference cannot inject a parameter even if the parser were wrong.
 */
export function buildRequestUrl(ref: TorBoxStableRef, token: string, origin = TORBOX_API_ORIGIN): URL {
  const mapping = TORBOX_REQUESTDL[ref.kind];
  const url = new URL(mapping.path, origin);
  url.searchParams.set('token', token);
  url.searchParams.set(mapping.idParam, String(ref.providerId));
  url.searchParams.set('file_id', String(ref.fileId));
  // `redirect` IS DELIBERATELY NEVER SET. With it, TorBox answers 3xx toward a CDN host; this contract needs
  // the JSON body, and the data plane refuses to follow redirects in any case.
  return url;
}

// ---------------------------------------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------------------------------------

export interface TorBoxResolution {
  /** The CDN URL TorBox handed back. Ephemeral, bearer-equivalent, never logged. */
  readonly url: string;
  readonly expiresAtUnixMs: number;
}

export class TorBoxResolveError extends Error {
  readonly retryable: boolean;
  constructor(reason: string, retryable = false) {
    super(reason);
    this.name = 'TorBoxResolveError';
    this.retryable = retryable;
  }
}

/**
 * Turns a TorBox `requestdl` body into a resolution, and FAILS CLOSED on anything ambiguous.
 *
 * WHAT AMBIGUOUS MEANS HERE. TorBox answers `{success, detail, error, data}` with every field optional, so a
 * body can be well-formed JSON, arrive with HTTP 200, and still say nothing usable. Guessing — treating a
 * missing `success` as true, or a non-string `data` as a URL — is how a resolver hands the data plane
 * something that is not a URL and turns a clean provider error into an obscure read failure three layers
 * down. Every branch below refuses instead.
 *
 * NOT ONE BRANCH QUOTES THE BODY. `detail` and `error` are provider-supplied strings that routinely contain
 * the item name and, on some errors, the request URL. They are used to CLASSIFY and never to report.
 */
export function parseResolveBody(body: unknown, now: number, allowPlaintextLink = false): TorBoxResolution {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TorBoxResolveError('the provider answered something that is not a JSON object');
  }
  const record = body as Record<string, unknown>;

  if (record.success !== true) {
    // A FALSE OR ABSENT `success` IS A FAILURE, INCLUDING UNDER HTTP 200. TorBox reports application-level
    // failures in the body, so trusting the status alone accepts an error as a URL.
    throw new TorBoxResolveError('the provider did not report success', record.success === undefined);
  }
  if (typeof record.data !== 'string' || record.data === '') {
    throw new TorBoxResolveError('the provider reported success without a download link');
  }

  let parsed: URL;
  try {
    parsed = new URL(record.data);
  } catch {
    throw new TorBoxResolveError('the provider returned a link that is not a URL');
  }
  // HTTPS ONLY. A plaintext CDN link would carry the request — and on a metered service, the entitlement —
  // in the clear. The daemon checks the origin against its allowlist as well; this is the earlier of two.
  //
  // THE ONE EXEMPTION IS THE OFFLINE FIXTURE, AND IT DEFAULTS TO OFF. The fixture serves plaintext on
  // loopback because standing up a certificate authority to test a JSON field would be theatre. But an
  // exemption that could be acquired by accident is worse than no fixture at all — so it is a parameter that
  // defaults to REFUSING plaintext, it is set in exactly one place, and a test requires that a real
  // resolution still refuses a plaintext link when the flag is simply not passed.
  if (parsed.protocol !== 'https:' && !(allowPlaintextLink && parsed.protocol === 'http:')) {
    throw new TorBoxResolveError('the provider returned a link that is not https');
  }

  return { url: parsed.toString(), expiresAtUnixMs: now + TORBOX_ASSUMED_LIFETIME_MS };
}

/**
 * How an HTTP status from `requestdl` should be treated.
 *
 * 401/403 ARE TERMINAL FOR THE RESOLVER AND A REFRESH FOR THE READER. The data plane's one-refresh-per-read
 * rule lives above this: it re-resolves once when access material is rejected. Classifying these as
 * retryable HERE would let the resolver loop on a rotated API key, spending the operator's rate limit to
 * discover the same answer.
 */
export function classifyStatus(status: number): 'ok' | 'auth' | 'unknown-ref' | 'retryable' | 'terminal' {
  if (status === 200) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 410) return 'unknown-ref';
  // 429 IS RETRYABLE AND IS THE ONE THE BACKOFF EXISTS FOR. TorBox meters this endpoint, and the correct
  // response to being told to slow down is to slow down — not to fail the read outright.
  if (status === 429 || status === 408 || (status >= 500 && status <= 599)) return 'retryable';
  return 'terminal';
}

// ---------------------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------------------

const SECRET_SHAPES: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/https?:\/\/[^\s"']+/i, 'a URL'],
  [/\btoken=[^\s&"']+/i, 'a token query parameter'],
  [/\btorbox:(torrent|webdl|usenet):\d+:\d+/i, 'a stable reference'],
  [/\bBearer\s+\S+/i, 'a bearer credential'],
  [/\b(torrent_id|web_id|usenet_id|file_id)=\d+/i, 'a provider identifier'],
]);

export interface RedactionProblem { readonly kind: string; readonly at: string }

/** Every forbidden shape in `text`, named without quoting the offending substring back. */
export function findSecretShapes(text: string, at: string): readonly RedactionProblem[] {
  const found: RedactionProblem[] = [];
  for (const [pattern, kind] of SECRET_SHAPES) {
    if (pattern.test(text)) found.push({ kind, at });
  }
  return found;
}

/**
 * The message an exception is allowed to carry outward.
 *
 * WHY EVERY THROWN ERROR GOES THROUGH THIS. A `fetch` failure's message routinely contains the URL it could
 * not reach, and on this endpoint family that URL contains the operator's API key. One unguarded
 * `catch (e) { log(e.message) }` anywhere above would publish it. So the boundary is here: anything carrying
 * a forbidden shape is replaced wholesale rather than scrubbed in place, because a partial scrub of an
 * unknown format is a guess.
 */
export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (findSecretShapes(message, 'error').length > 0) {
    return '<a provider failure whose message was withheld because it carried a URL or credential>';
  }
  return message;
}
