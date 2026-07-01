import type { JellyfinClient, JellyfinRef } from './client.js';
import type { FetchLike, HttpResponseLike } from './transport.js';
import {
  buildFindCandidatesRequest, matchItems, buildCreateCollectionRequest,
  parseCreateCollectionResponse, buildDeleteCollectionRequest, type HttpRequestSpec,
} from './mapping.js';

/** Redaction-safe error: carries the operation + status only — NEVER the api key, url, or body. */
export class JellyfinHttpError extends Error {
  constructor(readonly operation: string, readonly status: number | null, message: string) {
    super(message);
    this.name = 'JellyfinHttpError';
  }
}

export interface JellyfinHttpOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: FetchLike; // INJECTED — the client never references a bare `fetch`
}

/**
 * Phase 11 — the real Jellyfin client (collection curation) over an INJECTED {@link FetchLike}.
 *
 * The api key is sent ONLY as a header (`X-Emby-Token`) — never in the URL, an error, or a log. Errors
 * are redaction-safe (operation + status only). Timeout/retry are layered in Stage 11.3; this stage is
 * the request mapping + fail-closed HTTP handling. The endpoint mapping is PROVISIONAL (see mapping.ts).
 */
export class JellyfinHttpClient implements JellyfinClient {
  protected readonly baseUrl: string;
  private readonly apiKey: string;
  protected readonly fetchImpl: FetchLike;

  constructor(opts: JellyfinHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch;
  }

  async findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]> {
    if (refs.length === 0) return [];
    const body = await this.requestJson('findItemsByRefs', buildFindCandidatesRequest());
    return matchItems(refs, body);
  }

  async createCollection(name: string, itemIds: readonly string[]): Promise<string> {
    const body = await this.requestJson('createCollection', buildCreateCollectionRequest(name, itemIds));
    return parseCreateCollectionResponse(body);
  }

  async deleteCollection(collectionId: string): Promise<'deleted' | 'not_found'> {
    const res = await this.send('deleteCollection', buildDeleteCollectionRequest(collectionId), { allow404: true });
    return res.status === 404 ? 'not_found' : 'deleted';
  }

  // --- HTTP plumbing (Stage 11.3 layers timeout + bounded retry over `send`) ---

  private buildUrl(spec: HttpRequestSpec): string {
    const u = new URL(this.baseUrl + spec.path);
    for (const [k, v] of Object.entries(spec.query ?? {})) u.searchParams.set(k, v);
    return u.toString(); // query values only — the api key is NEVER placed in the URL
  }

  /** Perform one request. Fail-closed: throws a redaction-safe JellyfinHttpError on transport/HTTP error. */
  protected async send(op: string, spec: HttpRequestSpec, opts: { allow404?: boolean } = {}): Promise<HttpResponseLike> {
    let res: HttpResponseLike;
    try {
      res = await this.fetchImpl(this.buildUrl(spec), { method: spec.method, headers: { 'X-Emby-Token': this.apiKey, Accept: 'application/json' } });
    } catch {
      throw new JellyfinHttpError(op, null, `jellyfin ${op}: transport error`); // no key/url/cause leaked
    }
    if (res.ok) return res;
    if (opts.allow404 && res.status === 404) return res;
    throw new JellyfinHttpError(op, res.status, `jellyfin ${op}: HTTP ${res.status}`);
  }

  protected async requestJson(op: string, spec: HttpRequestSpec): Promise<unknown> {
    const res = await this.send(op, spec);
    try { return await res.json(); }
    catch { throw new JellyfinHttpError(op, res.status, `jellyfin ${op}: invalid JSON response`); }
  }
}
