import type { JellyfinClient, JellyfinRef } from './client.js';
import type { FetchLike, HttpResponseLike } from './transport.js';
import {
  buildFindCandidatesRequest, matchItems, buildCreateCollectionRequest,
  parseCreateCollectionResponse, buildDeleteCollectionRequest,
  buildFindCollectionsByNameRequest, matchCollectionIdsByName, type HttpRequestSpec,
} from './mapping.js';

/** Redaction-safe error: carries the operation + status only — NEVER the api key, url, or body. */
export class JellyfinHttpError extends Error {
  constructor(readonly operation: string, readonly status: number | null, message: string) {
    super(message);
    this.name = 'JellyfinHttpError';
  }
}

/** Live collection create is disabled — enable ONLY after `smoke:jellyfin` validates create/delete. */
export class JellyfinPublishDisabledError extends Error {
  constructor(message: string) { super(message); this.name = 'JellyfinPublishDisabledError'; }
}

/** A create whose outcome is ambiguous (created server-side but no handle captured). We attempt to
 * clean up so nothing is orphaned, then FAIL CLOSED — the caller records no ledger row. */
export class JellyfinAmbiguousCreateError extends Error {
  constructor(message: string) { super(message); this.name = 'JellyfinAmbiguousCreateError'; }
}

export interface JellyfinHttpOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: FetchLike;         // INJECTED — the client never references a bare `fetch`
  readonly timeoutMs?: number;       // per-request timeout (default 10000)
  readonly maxRetries?: number;      // extra attempts for IDEMPOTENT ops only (default 2); never for create
  readonly allowLivePublish?: boolean; // default FALSE — createCollection fails closed until enabled post-smoke
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
  private readonly allowLivePublish: boolean;

  constructor(opts: JellyfinHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.allowLivePublish = opts.allowLivePublish ?? false;
  }

  async findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]> {
    if (refs.length === 0) return [];
    const body = await this.requestJson('findItemsByRefs', buildFindCandidatesRequest(), true); // idempotent GET
    return matchItems(refs, body);
  }

  /**
   * Create a collection and return its opaque handle. Two protections keep a live external copy from
   * ever being ORPHANED (created but with no revocation handle → violates the Phase 9 invariant):
   *  1. GATED default-off — throws {@link JellyfinPublishDisabledError} BEFORE any POST unless live
   *     publish was explicitly enabled (post-smoke). So the risky POST cannot happen by default.
   *  2. AMBIGUOUS-outcome cleanup — if the POST is sent but we cannot capture a valid id (malformed/
   *     missing id, or a transport/timeout error AFTER the request left, so the server MAY have created
   *     it), best-effort delete any same-named collection, then FAIL CLOSED with
   *     {@link JellyfinAmbiguousCreateError}. The caller then records no ledger row AND no untracked
   *     external collection remains.
   */
  async createCollection(name: string, itemIds: readonly string[]): Promise<string> {
    if (!this.allowLivePublish) {
      throw new JellyfinPublishDisabledError('jellyfin live publish is disabled: set JELLYFIN_ALLOW_LIVE_PUBLISH=true only after smoke:jellyfin validates create/delete');
    }
    let id: string | null = null;
    try {
      const body = await this.requestJson('createCollection', buildCreateCollectionRequest(name, itemIds), false); // NEVER retried
      try { id = parseCreateCollectionResponse(body); } catch { id = null; }
    } catch {
      id = null; // transport/timeout error — the server may still have created the collection
    }
    if (id !== null) return id; // clean success: handle captured

    // Ambiguous: best-effort clean up any collection we may have just created, then fail closed.
    await this.cleanupOrphanCandidates(name);
    throw new JellyfinAmbiguousCreateError('jellyfin createCollection: ambiguous outcome; attempted cleanup of same-named collections — verify none remain');
  }

  /** Best-effort: find same-named collections and delete them so an ambiguous create never orphans. Never throws. */
  private async cleanupOrphanCandidates(name: string): Promise<void> {
    try {
      const body = await this.requestJson('cleanupFindCollections', buildFindCollectionsByNameRequest(name), true);
      for (const cid of matchCollectionIdsByName(name, body)) {
        try { await this.deleteCollection(cid); } catch { /* best-effort */ }
      }
    } catch { /* best-effort — surfaced by the thrown JellyfinAmbiguousCreateError */ }
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
