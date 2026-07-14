import type { JellyfinClient, JellyfinRef } from './client.js';
import type { FetchLike, HttpResponseLike } from './transport.js';
import {
  buildFindCandidatesRequest, matchItems, buildDeleteCollectionRequest, buildSystemInfoRequest,
  buildCreateTaggedRequest, parseCreatedId, buildFindByTokenRequest, matchIdByToken, pageItems, type HttpRequestSpec,
  buildAddCollectionItemsRequest, buildRemoveCollectionItemsRequest, buildCollectionItemsRequest, buildItemCollectionsRequest, matchIdsByNamePrefix,
} from './mapping.js';

const PAGE_LIMIT = 500;   // items per page
const MAX_PAGES = 200;    // safety cap (<= 100k items scanned) — never loops unbounded

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
  readonly pageLimit?: number;  // /Items page size (default 500)
}

export interface JellyfinServerInfo {
  readonly serverName?: string;
  readonly version?: string;
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
  private readonly pageLimit: number;

  constructor(opts: JellyfinHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.pageLimit = Math.max(1, opts.pageLimit ?? PAGE_LIMIT);
  }

  async getServerInfo(): Promise<JellyfinServerInfo> {
    const body = await this.requestJson('getServerInfo', buildSystemInfoRequest(), true);
    const raw = body as { ServerName?: unknown; Version?: unknown; ProductName?: unknown };
    return {
      ...(typeof raw.ServerName === 'string' ? { serverName: raw.ServerName } : {}),
      ...(typeof raw.Version === 'string' ? { version: raw.Version } : {}),
    };
  }

  async findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]> {
    if (refs.length === 0) return [];
    const items = await this.getAllPages('findItemsByRefs', (start, limit) => buildFindCandidatesRequest(start, limit));
    return matchItems(refs, items);
  }

  /** Walk `/Items` pages (StartIndex/Limit) and aggregate — a single unpaged fetch would miss matches
   *  beyond Jellyfin's default page. Bounded by MAX_PAGES; stops on the first short page. */
  private async getAllPages(op: string, build: (startIndex: number, limit: number) => HttpRequestSpec): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.requestJson(op, build(page * this.pageLimit, this.pageLimit), true); // idempotent GET
      const items = pageItems(body);
      all.push(...items);
      if (items.length < this.pageLimit) break; // last (short) page
    }
    return all;
  }

  /**
   * The unsafe bare create stays DISABLED — a create with no durable intent could orphan. Live create
   * is available ONLY via the Phase 12 outbox (createTaggedCollection + findCollectionByToken below).
   */
  async createCollection(_name: string, _itemIds: readonly string[]): Promise<string> {
    throw new JellyfinPublishDisabledError('jellyfin bare create is disabled — live create is available ONLY through the Phase 12 publish-intent outbox (token-tagged, crash-recoverable).');
  }

  /**
   * OUTBOX-ONLY: create a collection whose name carries the opaque `token` marker (atomic + findable),
   * so an ambiguous create is recoverable by {@link findCollectionByToken}. NEVER retried. The token
   * is opaque (not identity). Only the outbox target calls this, after writing a durable intent.
   */
  async createTaggedCollection(name: string, itemIds: readonly string[], token: string): Promise<string> {
    const body = await this.requestJson('createTaggedCollection', buildCreateTaggedRequest(name, itemIds, token), false);
    return parseCreatedId(body);
  }

  /** OUTBOX-ONLY recovery/idempotency: find a collection previously tagged with `token`; id or null.
   *  Fetches BoxSets and filters by name LOCALLY (never trusts Jellyfin SearchTerm) so the bracketed
   *  marker can't be missed (a false "not found" would risk a duplicate create). */
  async findCollectionByToken(token: string): Promise<string | null> {
    const items = await this.getAllPages('findCollectionByToken', (start, limit) => buildFindByTokenRequest(start, limit));
    return matchIdByToken(token, items);
  }

  async findCollectionsByNamePrefix(prefix: string): Promise<string[]> {
    const items = await this.getAllPages('findCollectionsByNamePrefix', (start, limit) => buildFindByTokenRequest(start, limit));
    return matchIdsByNamePrefix(prefix, items);
  }

  async deleteCollection(collectionId: string): Promise<'deleted' | 'not_found'> {
    const res = await this.send('deleteCollection', buildDeleteCollectionRequest(collectionId), { idempotent: true, allow404: true });
    return res.status === 404 ? 'not_found' : 'deleted';
  }

  async addItemsToCollection(collectionId: string, itemIds: readonly string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.send('addItemsToCollection', buildAddCollectionItemsRequest(collectionId, itemIds), { idempotent: false });
  }

  async removeItemsFromCollection(collectionId: string, itemIds: readonly string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.send('removeItemsFromCollection', buildRemoveCollectionItemsRequest(collectionId, itemIds), { idempotent: true, allow404: true });
  }

  async listCollectionItemIds(collectionId: string): Promise<string[]> {
    const items = await this.getAllPages('listCollectionItemIds', (start, limit) => buildCollectionItemsRequest(collectionId, start, limit));
    const ids: string[] = [];
    for (const raw of items) {
      const id = (raw as { Id?: unknown }).Id;
      if (typeof id === 'string') ids.push(id);
    }
    return ids;
  }

  async listItemCollectionIds(itemId: string): Promise<string[]> {
    const items = await this.getAllPages('listItemCollectionIds', (start, limit) => buildItemCollectionsRequest(itemId, start, limit));
    const ids: string[] = [];
    for (const raw of items) {
      const id = (raw as { Id?: unknown }).Id;
      if (typeof id === 'string') ids.push(id);
    }
    return ids;
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
