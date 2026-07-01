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
  readonly fetch: FetchLike;    // INJECTED — the client never references a bare `fetch`
  readonly timeoutMs?: number;  // per-request timeout (default 10000)
  readonly maxRetries?: number; // extra attempts for IDEMPOTENT ops only (default 2); never for create
}

/**
 * Phase 11 — the real Jellyfin client (collection curation) over an INJECTED {@link FetchLike}.
 *
 * The api key is sent ONLY as a header (`X-Emby-Token`) — never in the URL, an error, or a log. Errors
 * are redaction-safe (operation + status only). Fail-closed: every transport/HTTP failure throws (a
 * publish then writes no ledger row; a revoke stays revoke_pending). Timeout is enforced per attempt
 * via `AbortController`; bounded retry applies to IDEMPOTENT ops (search/delete) ONLY — `createCollection`
 * is NEVER retried. The endpoint mapping is PROVISIONAL (see mapping.ts) until the opt-in smoke.
 */
export class JellyfinHttpClient implements JellyfinClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: JellyfinHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
  }

  async findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]> {
    if (refs.length === 0) return [];
    const body = await this.requestJson('findItemsByRefs', buildFindCandidatesRequest(), true); // idempotent GET
    return matchItems(refs, body);
  }

  async createCollection(name: string, itemIds: readonly string[]): Promise<string> {
    const body = await this.requestJson('createCollection', buildCreateCollectionRequest(name, itemIds), false); // NEVER retried
    return parseCreateCollectionResponse(body);
  }

  async deleteCollection(collectionId: string): Promise<'deleted' | 'not_found'> {
    const res = await this.send('deleteCollection', buildDeleteCollectionRequest(collectionId), { idempotent: true, allow404: true });
    return res.status === 404 ? 'not_found' : 'deleted';
  }

  // --- HTTP plumbing ----------------------------------------------------------

  private buildUrl(spec: HttpRequestSpec): string {
    const u = new URL(this.baseUrl + spec.path);
    for (const [k, v] of Object.entries(spec.query ?? {})) u.searchParams.set(k, v);
    return u.toString(); // query values only — the api key is NEVER placed in the URL
  }

  /** One attempt with a per-request timeout (AbortController). */
  private async fetchOnce(url: string, spec: HttpRequestSpec): Promise<HttpResponseLike> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { method: spec.method, headers: { 'X-Emby-Token': this.apiKey, Accept: 'application/json' }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Perform a request with a per-attempt timeout and BOUNDED retry. Retries (idempotent ops only) on a
   * transport/timeout error or a transient 5xx/429; NEVER retries a non-idempotent op; NEVER loops
   * unbounded. Fail-closed: throws a redaction-safe {@link JellyfinHttpError} when attempts are exhausted.
   */
  private async send(op: string, spec: HttpRequestSpec, opts: { idempotent?: boolean; allow404?: boolean } = {}): Promise<HttpResponseLike> {
    const url = this.buildUrl(spec);
    const maxAttempts = opts.idempotent ? this.maxRetries + 1 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: HttpResponseLike;
      try {
        res = await this.fetchOnce(url, spec);
      } catch {
        if (attempt < maxAttempts) { await this.backoff(attempt); continue; }
        throw new JellyfinHttpError(op, null, `jellyfin ${op}: transport error after ${attempt} attempt(s)`);
      }
      if (res.ok) return res;
      if (opts.allow404 && res.status === 404) return res;
      if (attempt < maxAttempts && (res.status >= 500 || res.status === 429)) { await this.backoff(attempt); continue; }
      throw new JellyfinHttpError(op, res.status, `jellyfin ${op}: HTTP ${res.status}`);
    }
    /* c8 ignore next */ throw new JellyfinHttpError(op, null, `jellyfin ${op}: exhausted retries`);
  }

  private async requestJson(op: string, spec: HttpRequestSpec, idempotent: boolean): Promise<unknown> {
    const res = await this.send(op, spec, { idempotent });
    try { return await res.json(); }
    catch { throw new JellyfinHttpError(op, res.status, `jellyfin ${op}: invalid JSON response`); }
  }

  private async backoff(attempt: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, attempt * 10)); // small bounded backoff (no infinite loop)
  }
}
