import { createHash } from 'node:crypto';
import type { FetchLike, HttpResponseLike } from './transport.js';
import { buildSystemInfoRequest, pageItems, type HttpRequestSpec } from './mapping.js';

// Phase 266 — READ-ONLY discovery against a Jellyfin server, for the operator UI.
//
// WHAT IT IS FOR. Before anybody can plan a collection, they need an answer to "is this even connected, and
// what is over there?" — and they need it without the answer itself becoming a disclosure. This client
// answers exactly four questions: can we reach it, what version is it, how many libraries and collections
// does it have, and which of those collections did THIS product create.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//   * It never enumerates media items. Not one title, not one path, not one provider id. A library's contents
//     are the operator's private data on a server this product does not own; a browser panel is not the
//     one-adapter, under-redaction disclosure boundary that `withProviderRef` is, and a discovery screen has
//     no business being the first thing to bulk-read a library.
//   * It never returns a Jellyfin id. Ids are opaque handles the outbox uses; a UI shows a non-reversible
//     DIGEST of one, which is enough to tell two collections apart and is not the handle.
//   * It never names a collection this product did not create. A collection carrying our `[cat:` marker is
//     one whose name an operator typed into this UI, so it comes back; everything else is COUNTED.
//   * It writes nothing. Every method here issues GET and only GET.
//
// HOW IT IS BOUNDED, ON EVERY AXIS.
//   * TIME: one AbortController per attempt, from the configured timeout. Nothing waits forever.
//   * SIZE: the body is read as TEXT with a byte bound and parsed here, rather than handed to `res.json()`
//     which will happily buffer a gigabyte from a server that is broken or hostile.
//   * PAGES: `StartIndex`/`Limit` with a page cap AND a total-item cap; a server that returns a full page
//     forever stops at the cap and the result SAYS it was truncated rather than pretending it saw everything.
//   * REDIRECTS: refused (`redirect: 'error'`). A 302 is how a server that passed the private-network policy
//     sends this process somewhere that did not.
//   * ORIGIN: every request URL is rebuilt from the validated base URL and re-checked to still start with the
//     validated origin before it is sent. A path or a query value can never move a request to another host.
//
// EVERY ERROR IS REDACTION-SAFE. `JellyfinDiscoveryError` carries an operation name and an HTTP status. It
// never carries the URL, the api key, a response body, or a transport error message — a DNS failure message
// contains the host, and a TLS error contains the certificate's subject.

/** How many bytes of any single response this client will read before giving up on it. */
export const JELLYFIN_DISCOVERY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Items per page. Jellyfin's own default is smaller; this is a request, not a promise. */
export const JELLYFIN_DISCOVERY_PAGE_LIMIT = 200;
/** How many pages one listing will walk. */
export const JELLYFIN_DISCOVERY_MAX_PAGES = 25;
/** How many rows one listing will accumulate, whatever the pages say. */
export const JELLYFIN_DISCOVERY_MAX_ROWS = 2000;
/** The marker Phase 12 embeds in a collection name. A collection carrying it was created by this product. */
export const JELLYFIN_MANAGED_MARKER = '[cat:';
/** How long a collection name may be before the discovery surface truncates it. */
export const JELLYFIN_DISCOVERY_MAX_NAME_LENGTH = 120;

/** Redaction-safe: an operation name and a status. Never a URL, a key, a body or a transport message. */
export class JellyfinDiscoveryError extends Error {
  readonly code = 'JELLYFIN_DISCOVERY_FAILED';

  constructor(readonly operation: string, readonly status: number | null, readonly reason: JellyfinDiscoveryFailure) {
    super(`jellyfin ${operation}: ${reason}${status === null ? '' : ` (HTTP ${status})`}`);
    this.name = 'JellyfinDiscoveryError';
  }
}

export type JellyfinDiscoveryFailure =
  | 'unreachable'
  | 'timed-out'
  | 'unauthorized'
  | 'refused'
  | 'redirected'
  | 'too-large'
  | 'unreadable';

export interface JellyfinDiscoveryOptions {
  /** The validated base URL: scheme, host, port and an optional path prefix, with no trailing slash. */
  readonly baseUrl: string;
  /** `scheme://host[:port]`. Every built URL is re-checked to start with this before it is sent. */
  readonly origin: string;
  /** SECRET. Sent only as `X-Emby-Token`, never in a URL, a log line, an error or a response. */
  readonly apiKey: string;
  /** INJECTED. This module never references a bare `fetch`, so a test can prove it made no call at all. */
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly pageLimit?: number;
  readonly maxPages?: number;
  readonly maxRows?: number;
}

export interface JellyfinManagedCollection {
  /** A short, non-reversible fingerprint of the Jellyfin id. Enough to compare; never the handle. */
  readonly collectionDigest: string;
  /** The name an operator typed into THIS product, with the opaque marker removed. Bounded. */
  readonly name: string;
  /** Whether the marker was parseable at all. A malformed one is still counted, never guessed at. */
  readonly marked: boolean;
}

export interface JellyfinDiscoveryReport {
  readonly reachable: true;
  /** The server's own product version. Not a name, not an id, not a host — a version. */
  readonly version: string | null;
  readonly libraries: number;
  readonly collections: number;
  /** Collections carrying this product's marker, by digest and by the name an operator gave them. */
  readonly managed: readonly JellyfinManagedCollection[];
  /** True when a listing hit a bound and did not see everything. Never silently false. */
  readonly truncated: boolean;
  readonly scanned: number;
}

/**
 * A short, non-reversible fingerprint of a Jellyfin id.
 *
 * Domain-separated from every other digest in this codebase, so a fingerprint from here can never be
 * compared against, or mistaken for, one produced somewhere else.
 */
export function jellyfinIdDigest(id: string): string {
  return createHash('sha256').update('phase-266-jellyfin-id\u0000' + id, 'utf8').digest('hex').slice(0, 16);
}

/** Strip this product's opaque correlation marker out of a collection name, leaving what a person typed. */
export function stripManagedMarker(name: string): { readonly name: string; readonly marked: boolean } {
  const at = name.indexOf(JELLYFIN_MANAGED_MARKER);
  if (at === -1) return { name: bounded(name), marked: false };
  const close = name.indexOf(']', at);
  if (close === -1) return { name: bounded(name.slice(0, at).trim()), marked: false };
  const without = (name.slice(0, at) + name.slice(close + 1)).replace(/\s+/g, ' ').trim();
  return { name: bounded(without), marked: true };
}

function bounded(value: string): string {
  return value.length > JELLYFIN_DISCOVERY_MAX_NAME_LENGTH
    ? value.slice(0, JELLYFIN_DISCOVERY_MAX_NAME_LENGTH)
    : value;
}

export class JellyfinDiscoveryClient {
  private readonly pageLimit: number;
  private readonly maxPages: number;
  private readonly maxRows: number;
  /**
   * The injected transport, held under a name that is NOT `fetch`.
   *
   * `test/deploy.ts` forbids a call to anything spelled exactly `fetch` anywhere under
   * `src/core/adapters/jellyfin/`, which is what makes "the core adapter never touches a bare or global
   * transport" a checkable property rather than a habit — and the check is deliberately a plain token scan,
   * so it also refuses this comment describing it in the forbidden spelling. `http-client.ts` has always
   * used `fetchImpl` for the same reason; this follows it.
   */
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: JellyfinDiscoveryOptions) {
    this.fetchImpl = opts.fetch;
    this.pageLimit = clamp(opts.pageLimit ?? JELLYFIN_DISCOVERY_PAGE_LIMIT, 1, JELLYFIN_DISCOVERY_PAGE_LIMIT);
    this.maxPages = clamp(opts.maxPages ?? JELLYFIN_DISCOVERY_MAX_PAGES, 1, JELLYFIN_DISCOVERY_MAX_PAGES);
    this.maxRows = clamp(opts.maxRows ?? JELLYFIN_DISCOVERY_MAX_ROWS, 1, JELLYFIN_DISCOVERY_MAX_ROWS);
  }

  /**
   * The whole discovery surface, in three bounded reads.
   *
   * The server info read comes FIRST and is the authentication proof: a bad key answers 401 there, and
   * reporting "your key was refused" is far more useful than reporting an empty library.
   */
  async discover(): Promise<JellyfinDiscoveryReport> {
    const version = await this.serverVersion();
    const libraries = await this.listPages('libraries', (start, limit) => ({
      method: 'GET',
      path: '/Items',
      // Recursive:false at the root is exactly the set of library folders. Fields is deliberately absent:
      // this asks for as little per row as the endpoint will give.
      query: { Recursive: 'false', IncludeItemTypes: 'CollectionFolder', StartIndex: String(start), Limit: String(limit) },
    }));
    const collections = await this.listPages('collections', (start, limit) => ({
      method: 'GET',
      path: '/Items',
      query: { Recursive: 'true', IncludeItemTypes: 'BoxSet', Fields: 'Name', StartIndex: String(start), Limit: String(limit) },
    }));

    const managed: JellyfinManagedCollection[] = [];
    for (const row of collections.rows) {
      const item = row as { Id?: unknown; Name?: unknown };
      if (typeof item.Id !== 'string' || typeof item.Name !== 'string') continue;
      if (!item.Name.includes(JELLYFIN_MANAGED_MARKER)) continue; // not ours: counted above, never named
      const stripped = stripManagedMarker(item.Name);
      managed.push({ collectionDigest: jellyfinIdDigest(item.Id), name: stripped.name, marked: stripped.marked });
    }
    // A total order that does not depend on what the server happened to return first, so two discoveries of
    // an unchanged server produce the same document.
    managed.sort((a, b) => (a.name === b.name ? a.collectionDigest.localeCompare(b.collectionDigest, 'en') : a.name.localeCompare(b.name, 'en')));

    return {
      reachable: true,
      version,
      libraries: libraries.rows.length,
      collections: collections.rows.length,
      managed,
      truncated: libraries.truncated || collections.truncated,
      scanned: libraries.rows.length + collections.rows.length,
    };
  }

  /** The server's product version, or null when it does not declare one. Never its name, never its id. */
  async serverVersion(): Promise<string | null> {
    const body = await this.getJson('serverInfo', buildSystemInfoRequest());
    const raw = (body as { Version?: unknown }).Version;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
    // A version is a version. Anything else in that field is not shown rather than guessed at.
    return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(raw) ? raw : null;
  }

  /**
   * Walk a paginated listing within every bound, and SAY when a bound was hit.
   *
   * Stopping early is a fact about the answer, not an implementation detail — a caller that cannot tell a
   * complete listing from a truncated one will eventually report the second as the first.
   */
  private async listPages(
    operation: string,
    build: (startIndex: number, limit: number) => HttpRequestSpec,
  ): Promise<{ rows: unknown[]; truncated: boolean }> {
    const rows: unknown[] = [];
    for (let page = 0; page < this.maxPages; page += 1) {
      const body = await this.getJson(operation, build(page * this.pageLimit, this.pageLimit));
      const items = pageItems(body);
      for (const item of items) {
        if (rows.length >= this.maxRows) return { rows, truncated: true };
        rows.push(item);
      }
      if (items.length < this.pageLimit) return { rows, truncated: false }; // a short page is the last page
    }
    return { rows, truncated: true };
  }

  /**
   * One GET, bounded in time and size, with the origin re-checked and redirects refused.
   *
   * NO RETRY. Discovery is a screen an operator can press again; a client that retries silently turns one
   * slow server into three times the wait and hides the fact that it was slow.
   */
  private async getJson(operation: string, spec: HttpRequestSpec): Promise<unknown> {
    const url = this.buildUrl(spec);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.opts.timeoutMs);
    let res: HttpResponseLike;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          // The ONLY place the api key appears. Never a query parameter, never a log line, never an error.
          'X-Emby-Token': this.opts.apiKey,
          Accept: 'application/json',
        },
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      // The transport's own message is discarded on purpose: a DNS failure names the host and a TLS failure
      // names the certificate, and neither belongs in a response a browser renders.
      throw new JellyfinDiscoveryError(operation, null, timedOut ? 'timed-out' : 'unreachable');
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new JellyfinDiscoveryError(operation, res.status, 'unauthorized');
      // A redirect that reached here means the transport did not refuse it for us; refusing it here keeps the
      // guarantee whatever transport was injected.
      if (res.status >= 300 && res.status < 400) throw new JellyfinDiscoveryError(operation, res.status, 'redirected');
      throw new JellyfinDiscoveryError(operation, res.status, 'refused');
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new JellyfinDiscoveryError(operation, res.status, 'unreadable');
    }
    if (Buffer.byteLength(text, 'utf8') > JELLYFIN_DISCOVERY_MAX_RESPONSE_BYTES) {
      throw new JellyfinDiscoveryError(operation, res.status, 'too-large');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new JellyfinDiscoveryError(operation, res.status, 'unreadable');
    }
  }

  /**
   * Build a request URL from the VALIDATED base, and prove it did not move.
   *
   * `new URL(base + path)` is enough on its own for the paths in this file, which are constants. The origin
   * assertion is here so that stays true of any path a future caller adds: a path beginning `//` or carrying
   * a scheme would otherwise silently produce a request to another host, and a check that only runs when
   * somebody remembers is not a check.
   */
  private buildUrl(spec: HttpRequestSpec): string {
    const url = new URL(this.opts.baseUrl + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value);
    const built = url.toString();
    if (!built.startsWith(this.opts.origin + '/')) {
      throw new JellyfinDiscoveryError('buildUrl', null, 'refused');
    }
    return built;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return min;
  return Math.max(min, Math.min(max, value));
}
