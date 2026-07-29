// Catalog Authority — Phase 266-276 acceptance: a LOCAL fake Jellyfin server.
//
// WHY IT EXISTS. The control plane's whole point is that it talks to somebody's media server. Proving it
// works therefore needs a server on the other end — and it must never be a real one. This is a few hundred
// lines of Node with no dependencies, serving exactly the endpoints the adapter uses, on loopback inside a
// Compose network. It contacts nothing, holds no real media, and is thrown away with the stack.
//
// WHAT IT IMPLEMENTS, AND NOTHING ELSE:
//   GET  /System/Info                    the authentication proof and the version
//   GET  /Items?IncludeItemTypes=...     library folders, box sets, and provider-id-bearing items
//   GET  /Items?parentId=<id>            the members of one collection (Phase 270's membership read)
//   POST /Collections?name=&ids=         create, returning an opaque id
//   POST /Collections/<id>/Items?ids=    add members  (Phase 270)
//   DELETE /Collections/<id>/Items?ids=  remove members (Phase 270)
//   DELETE /Items/<id>                   delete a collection by its opaque id
//
// IT ENFORCES THE API KEY. Every Jellyfin request must carry `X-Emby-Token` matching JELLYFIN_FAKE_API_KEY,
// or it answers 401 — so the acceptance proves the key really travelled in the header, and a run with the
// wrong key fails loudly rather than passing against an unauthenticated server.
//
// ---------------------------------------------------------------------------------------------------------
// THE FAKE-ADMIN SURFACE (`/_control/...`) — TEST-ONLY, OPT-IN, AND NEVER IN PRODUCTION RUNTIME CODE.
// ---------------------------------------------------------------------------------------------------------
//
// An acceptance that cannot manufacture a fault cannot prove recovery from one. So this server can be made to
// misbehave on purpose, and can be mutated behind the product's back — which is exactly what a real operator
// editing a collection in Jellyfin's own web UI would do:
//
//   POST /_control/lose-next-create      the next create succeeds server-side and drops its response
//   POST /_control/fail-next?read=...    the next `items`, `boxsets` or `members` read answers 500
//   POST /_control/membership?id=&add=&remove=   MUTATE a collection's membership directly (drift injection)
//   GET  /_control/state                 what this server holds
//
// THREE THINGS MAKE THIS SAFE TO EXIST AT ALL:
//
//   1. IT LIVES ONLY HERE. This file is under `deploy/ci/acceptance/`, is not in `src/`, is not in the
//      production image, and is not in the consumer release bundle. `test/disposable-collection-lifecycle.ts`
//      asserts every one of those, by scanning the shipped tree for the `/_control/` prefix and the bundle
//      generator for this file's name. A mutation surface that shipped would be a back door.
//   2. IT IS OFF UNLESS EXPLICITLY TURNED ON. `JELLYFIN_FAKE_ADMIN=enabled` — exactly that string — or every
//      `/_control/` path answers 404 as if it did not exist. The acceptance override sets it; nothing else
//      does. A fake server started without it is an ordinary read/write Jellyfin double with no back door.
//   3. IT IS NAMESPACED SO IT CANNOT COLLIDE WITH JELLYFIN. No real Jellyfin route begins `/_control/`, so
//      the product can never reach one by accident, and a request the product makes can never be answered by
//      the fake-admin surface.
//
// The control surface is deliberately UNAUTHENTICATED: it is the acceptance harness talking to its own
// fixture over a private Compose network with no host port, not a Jellyfin endpoint. Adding a second secret
// to it would prove nothing and would put another key in the run.

import { createServer } from 'node:http';

const PORT = Number(process.env.JELLYFIN_FAKE_PORT ?? '8096');
const API_KEY = process.env.JELLYFIN_FAKE_API_KEY ?? '';
const VERSION = process.env.JELLYFIN_FAKE_VERSION ?? '10.9.11';
/** Exactly `"enabled"`. Fail-closed in every other case, including absent, `"true"` and `"1"`. */
const ADMIN_ENABLED = process.env.JELLYFIN_FAKE_ADMIN === 'enabled';

if (API_KEY === '') {
  console.error('fake-jellyfin: JELLYFIN_FAKE_API_KEY is required — an unauthenticated fake would prove nothing');
  process.exit(2);
}

/**
 * The library this server "has".
 *
 * The provider reference VALUES here must match the acceptance snapshot's, because matching by reference is
 * the whole mechanism under test. They are fixture values and identify nothing real.
 */
const library = [
  { Id: 'jf-item-1', Name: 'Fixture One', ProviderIds: { Imdb: 'tt-jellyfin-acceptance-ref-1' } },
  { Id: 'jf-item-2', Name: 'Fixture Two', ProviderIds: { Imdb: 'tt-jellyfin-acceptance-ref-2' } },
  // Phase 276 drift injection needs a library item that is NOT intended by any plan, so an `extra` member can
  // be manufactured without inventing an id the library does not hold.
  { Id: 'jf-item-3', Name: 'Fixture Three', ProviderIds: { Imdb: 'tt-jellyfin-acceptance-ref-3' } },
];
const libraryFolders = [
  { Id: 'jf-lib-movies', Name: 'Movies', Type: 'CollectionFolder' },
  { Id: 'jf-lib-shows', Name: 'Shows', Type: 'CollectionFolder' },
];
/** A collection this product did NOT create. The discovery surface must count it and never name it. */
const foreignCollections = [
  { Id: 'jf-foreign-1', Name: 'Somebody elses private collection', Type: 'BoxSet' },
];

const collections = new Map();
let counter = 0;
let loseNextCreateResponse = false;
/** One-shot read failures, armed by the fake-admin surface. `items` | `boxsets` | `members`. */
const failNextRead = new Set();

const send = (res, status, value) => {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  res.end(body);
};

/** Consume a one-shot armed failure for this read, if there is one. */
const shouldFail = (kind) => {
  if (!failNextRead.has(kind)) return false;
  failNextRead.delete(kind);
  return true;
};

const idList = (value) => (value ?? '').split(',').map((id) => id.trim()).filter(Boolean);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (url.pathname.startsWith('/_control/')) {
    // OFF UNLESS EXPLICITLY TURNED ON, and a 404 rather than a 403: a surface that is not enabled should be
    // indistinguishable from a surface that does not exist.
    if (!ADMIN_ENABLED) { send(res, 404, {}); return; }

    if (url.pathname === '/_control/lose-next-create' && req.method === 'POST') {
      loseNextCreateResponse = true;
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/_control/fail-next' && req.method === 'POST') {
      const read = url.searchParams.get('read') ?? '';
      if (!['items', 'boxsets', 'members'].includes(read)) { send(res, 400, { error: 'unknown read' }); return; }
      failNextRead.add(read);
      send(res, 200, { ok: true, armed: read });
      return;
    }
    // MEMBERSHIP DRIFT, injected behind the product's back — the same thing an operator does when they open
    // Jellyfin and drag something into or out of a collection. It deliberately does NOT go through the
    // Jellyfin routes above, because a mutation the product itself performed would prove nothing about drift.
    if (url.pathname === '/_control/membership' && req.method === 'POST') {
      const collection = collections.get(url.searchParams.get('id') ?? '');
      if (!collection) { send(res, 404, { error: 'no such collection' }); return; }
      const add = idList(url.searchParams.get('add'));
      const remove = idList(url.searchParams.get('remove'));
      for (const id of add) if (!collection.ids.includes(id)) collection.ids.push(id);
      collection.ids = collection.ids.filter((id) => !remove.includes(id));
      send(res, 200, { ok: true, id: collection.id, items: collection.ids.length });
      return;
    }
    if (url.pathname === '/_control/state') {
      send(res, 200, {
        ok: true,
        collections: [...collections.values()].map((c) => ({ id: c.id, name: c.name, items: c.ids.length, ids: [...c.ids] })),
        // Collections carrying THIS product's correlation marker. Phase 276's cleanup claim is about these,
        // not about the foreign collection the fixture also holds.
        managed: [...collections.values()].filter((c) => c.name.includes('[cat:')).length,
        created: counter,
        adminEnabled: ADMIN_ENABLED,
      });
      return;
    }
    send(res, 404, {});
    return;
  }

  const token = req.headers['x-emby-token'];
  if ((Array.isArray(token) ? token[0] : token) !== API_KEY) {
    send(res, 401, { error: 'unauthorized' });
    return;
  }

  if (url.pathname === '/System/Info') {
    send(res, 200, { ServerName: 'fake-jellyfin-acceptance', Id: 'fake-server-id', Version: VERSION });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/Collections') {
    const name = url.searchParams.get('name') ?? '';
    const ids = idList(url.searchParams.get('ids'));
    const id = `jf-col-${++counter}`;
    collections.set(id, { id, name, ids });
    if (loseNextCreateResponse) {
      // The artifact EXISTS and the caller never learns its handle. Recovery has to work by the token
      // embedded in the name, which is exactly what the outbox does.
      loseNextCreateResponse = false;
      req.socket.destroy();
      return;
    }
    send(res, 200, { Id: id });
    return;
  }

  // Phase 270 membership. A managed collection's members are ADDED and REMOVED by set difference, so the
  // fake has to hold membership rather than only a name — otherwise the acceptance would prove a create and
  // nothing about the reconcile that keeps the collection honest afterwards.
  const collectionItems = /^\/Collections\/([^/]+)\/Items$/.exec(url.pathname);
  if (collectionItems !== null) {
    const collection = collections.get(decodeURIComponent(collectionItems[1]));
    if (!collection) { send(res, 404, {}); return; }
    const ids = idList(url.searchParams.get('ids'));
    if (req.method === 'POST') {
      for (const id of ids) if (!collection.ids.includes(id)) collection.ids.push(id);
      send(res, 200, {});
      return;
    }
    if (req.method === 'DELETE') {
      collection.ids = collection.ids.filter((id) => !ids.includes(id));
      send(res, 200, {});
      return;
    }
    send(res, 405, {});
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/Items/')) {
    const id = decodeURIComponent(url.pathname.slice('/Items/'.length));
    if (!collections.has(id)) { send(res, 404, {}); return; }
    collections.delete(id);
    send(res, 200, {});
    return;
  }

  if (url.pathname === '/Items') {
    // The MEMBER listing, spelled exactly as the mapping pins it (lowercase `parentId`).
    const parentId = url.searchParams.get('parentId');
    if (parentId !== null) {
      if (shouldFail('members')) { send(res, 500, { error: 'injected' }); return; }
      const start = Number(url.searchParams.get('startIndex') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '500');
      const member = collections.get(parentId);
      const rows = (member?.ids ?? []).map((id) => ({ Id: id }));
      send(res, 200, { Items: rows.slice(start, start + limit), TotalRecordCount: rows.length });
      return;
    }
    const types = (url.searchParams.get('IncludeItemTypes') ?? '').split(',').filter(Boolean);
    const start = Number(url.searchParams.get('StartIndex') ?? '0');
    const limit = Number(url.searchParams.get('Limit') ?? '500');
    let rows = [];
    if (types.includes('CollectionFolder')) rows = libraryFolders;
    else if (types.includes('BoxSet')) {
      if (shouldFail('boxsets')) { send(res, 500, { error: 'injected' }); return; }
      rows = [...foreignCollections, ...[...collections.values()].map((c) => ({ Id: c.id, Name: c.name, Type: 'BoxSet' }))];
    } else {
      if (shouldFail('items')) { send(res, 500, { error: 'injected' }); return; }
      rows = library;
    }
    send(res, 200, { Items: rows.slice(start, start + limit), TotalRecordCount: rows.length });
    return;
  }

  send(res, 404, {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`fake-jellyfin: listening on ${PORT}${ADMIN_ENABLED ? ' (fake-admin surface ENABLED)' : ''}`);
});
