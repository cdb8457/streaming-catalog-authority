import type { FetchLike, HttpResponseLike, HttpRequestInit } from '../src/core/adapters/jellyfin/transport.js';

/**
 * ONE fake Jellyfin, shared by every suite that drives the real `JellyfinHttpClient` over a fake transport.
 *
 * WHY IT IS A HELPER RATHER THAN A CLASS PER SUITE. `test/jellyfin-outbox.ts` used to carry its own copy.
 * When Phase 222 corrected the create mapping to Jellyfin's OpenAPI spelling (`Name` -> `name`,
 * `Ids` -> `ids`) it updated `test/jellyfin-http.ts` and not that copy, which went on reading `Name` and
 * defaulting the miss to an empty string. Every collection it stored was therefore nameless, the
 * `[cat:<token>]` recovery marker was silently discarded, and the outbox's whole duplicate-prevention
 * property was untestable — the suite failed for eighteen phases and the failure was read as a defect in
 * the outbox. Two independent models of one server is the defect; this file is the repair.
 *
 * The server is deliberately CASE-SENSITIVE about query parameters even though a real ASP.NET server binds
 * them case-insensitively. A double exists to hold the product to a pinned contract, so a request in the
 * wrong spelling is a 400 here rather than something quietly tolerated.
 */

const ok = (body: unknown): HttpResponseLike => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const stat = (s: number): HttpResponseLike => ({ ok: s >= 200 && s < 300, status: s, json: async () => ({}), text: async () => '' });

/** How the server behaves on `POST /Collections`. */
export type CreateMode =
  | 'ok'                  // creates, responds
  | 'throw-before-create' // the request never lands: nothing is created
  | 'create-then-throw';  // created + tagged server-side, then the RESPONSE is lost

/** How the server behaves on the BoxSet listing that recovery-by-token reads. */
export type FindMode = 'ok' | 'throw';

export interface FakeJellyfinOptions {
  /** `"<providerType>:<value>"` -> library item id. */
  readonly library?: Record<string, string>;
}

export class FakeJellyfin {
  private readonly items: Array<{ Id: string; ProviderIds: Record<string, string> }>;
  private readonly collections = new Map<string, string>(); // opaque id -> stored name
  private counter = 0;

  createMode: CreateMode = 'ok';
  findMode: FindMode = 'ok';
  /**
   * A server that stores a name of its own choosing, discarding the `[cat:<token>]` recovery marker. It is
   * a property of the SERVER, not of one request — which is why it is a flag rather than a create mode: the
   * marker is dropped whether the response is delivered or lost, and the combination of the two is exactly
   * the sequence that used to produce a duplicate external collection.
   */
  dropsMarker = false;
  /** Every request line the client sent, for assertions about what was and was not disclosed. */
  readonly requests: Array<{ method: string; url: string }> = [];

  constructor(opts: FakeJellyfinOptions = {}) {
    this.items = Object.entries(opts.library ?? {}).map(([key, id]) => {
      const [type, value] = key.split(':');
      return { Id: id, ProviderIds: { [type!]: value! } };
    });
  }

  readonly fetch: FetchLike = async (url: string, init?: HttpRequestInit): Promise<HttpResponseLike> => {
    const method = init?.method ?? 'GET';
    this.requests.push({ method, url });
    const u = new URL(url);

    if (method === 'GET' && u.pathname === '/Items') {
      if (u.searchParams.get('IncludeItemTypes') === 'BoxSet') {
        if (this.findMode === 'throw') throw new Error('boxset listing failed (network down)');
        // The client never sends SearchTerm (it filters locally); honour it if one ever appears so the
        // double cannot make a server-side filter look like it works.
        const term = u.searchParams.get('SearchTerm') ?? '';
        return ok({ Items: [...this.collections.entries()].filter(([, n]) => n.includes(term)).map(([id, n]) => ({ Id: id, Name: n })) });
      }
      return ok({ Items: this.items });
    }

    if (method === 'POST' && u.pathname === '/Collections') {
      // Pinned by test/jellyfin-http.ts from Jellyfin's OpenAPI: lowercase `name` and `ids`.
      if (u.searchParams.has('Name') || u.searchParams.has('Ids')) return stat(400);
      const name = u.searchParams.get('name');
      if (name === null) return stat(400); // a create with no name cannot carry the recovery marker
      if (this.createMode === 'throw-before-create') throw new Error('the create request never landed');
      const id = `jf-col-${++this.counter}`;
      this.collections.set(id, this.dropsMarker ? '' : name);
      if (this.createMode === 'create-then-throw') throw new Error('created server-side, then the response was lost');
      return ok({ Id: id });
    }

    if (method === 'DELETE' && u.pathname.startsWith('/Items/')) {
      const id = decodeURIComponent(u.pathname.slice('/Items/'.length));
      return stat(this.collections.delete(id) ? 204 : 404);
    }

    return stat(404);
  };

  /** Collections currently on the server. */
  count(): number { return this.collections.size; }
  names(): string[] { return [...this.collections.values()]; }
}
