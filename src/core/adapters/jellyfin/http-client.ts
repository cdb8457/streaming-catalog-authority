import type { JellyfinClient, JellyfinRef } from './client.js';
import type { FetchLike, HttpResponseLike } from './transport.js';
import { buildFindCandidatesRequest, matchItems, buildDeleteCollectionRequest, type HttpRequestSpec } from './mapping.js';

/** Redaction-safe error: carries the operation + status only — NEVER the api key, url, or body. */
export class JellyfinHttpError extends Error {
  constructor(readonly operation: string, readonly status: number | null, message: string) {
    super(message);
    this.name = 'JellyfinHttpError';
  }
}

/**
 * Live collection CREATE is DISABLED in this release. A remote create cannot guarantee a captured
 * revocation handle under network failure — an ambiguous create could orphan an external collection
 * with no Phase 9 ledger row — so real create is deferred to Phase 12's durable publish-intent outbox.
 */
export class JellyfinPublishDisabledError extends Error {
  constructor(message: string) { super(message); this.name = 'JellyfinPublishDisabledError'; }
}

export interface JellyfinHttpOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: FetchLike;    // INJECTED — the client never references a bare `fetch`
  readonly timeoutMs?: number;  // per-request timeout (default 10000)
  readonly maxRetries?: number; // extra attempts for IDEMPOTENT ops only (default 2)
}

/**
 * Phase 11 — the real Jellyfin client over an INJECTED {@link FetchLike}. Ships real **find + revoke**
 * (both orphan-safe: find is read-only; revoke deletes a known opaque handle). Live **create is
 * hard-disabled** (deferred to Phase 12) so there is no real-create path that could orphan an
 * external copy — preserving the Phase 9 "no untracked external copy" invariant.
 *
 * The api key is sent ONLY as the `X-Emby-Token` header — never in the URL/error/log/ledger. Errors are
 * redaction-safe (operation + status only). Fail-closed: every transport/HTTP failure throws. Timeout is
 * per-attempt via `AbortController`; bounded retry applies to IDEMPOTENT ops only. Mapping is PROVISIONAL.
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

  /** DISABLED in this release — fail-closed BEFORE any network call. Redaction-safe (no identity). */
  async createCollection(_name: string, _itemIds: readonly string[]): Promise<string> {
    throw new JellyfinPublishDisabledError('jellyfin live publish (collection create) is disabled in this release — deferred to Phase 12 (durable publish-intent outbox). Real find + revoke are available.');
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

  private async fetchOnce(url: string, spec: HttpRequestSpec): Promise<HttpResponseLike> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { method: spec.method, headers: { 'X-Emby-Token': this.apiKey, Accept: 'application/json' }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Per-attempt timeout + BOUNDED retry (idempotent ops only). Fail-closed with a redaction-safe error. */
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
