// Catalog Authority — Phase 266-268 acceptance: a LOCAL fake Jellyfin server.
//
// WHY IT EXISTS. The control plane's whole point is that it talks to somebody's media server. Proving it
// works therefore needs a server on the other end — and it must never be a real one. This is a few dozen
// lines of Node with no dependencies, serving exactly the four endpoints the adapter uses, on loopback
// inside a Compose network. It contacts nothing, holds no real media, and is thrown away with the stack.
//
// WHAT IT IMPLEMENTS, AND NOTHING ELSE:
//   GET  /System/Info                    the authentication proof and the version
//   GET  /Items?IncludeItemTypes=...     library folders, box sets, and provider-id-bearing items
//   POST /Collections?name=&ids=         create, returning an opaque id
//   DELETE /Items/<id>                   delete a collection by its opaque id
//
// IT ENFORCES THE API KEY. Every request must carry `X-Emby-Token` matching JELLYFIN_FAKE_API_KEY, or it
// answers 401 — so the acceptance proves the key really travelled in the header, and a run with the wrong
// key fails loudly rather than passing against an unauthenticated server.
//
// IT CAN BE MADE TO MISBEHAVE, ON PURPOSE. `POST /_control/lose-next-create` makes the next create succeed
// server-side and drop the response, which is the ambiguous case the outbox exists for. `/_control/state`
// reports what it holds. Those two paths are the ONLY ones outside the Jellyfin surface, they are namespaced
// so they cannot collide with it, and they exist because an acceptance that cannot manufacture a lost
// response cannot prove recovery from one.

import { createServer } from 'node:http';

const PORT = Number(process.env.JELLYFIN_FAKE_PORT ?? '8096');
const API_KEY = process.env.JELLYFIN_FAKE_API_KEY ?? '';
const VERSION = process.env.JELLYFIN_FAKE_VERSION ?? '10.9.11';

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

const send = (res, status, value) => {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  res.end(body);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  // The control surface is deliberately unauthenticated and deliberately namespaced: it is the acceptance
  // harness talking to its own fixture, not a Jellyfin endpoint.
  if (url.pathname === '/_control/lose-next-create' && req.method === 'POST') {
    loseNextCreateResponse = true;
    send(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/_control/state') {
    send(res, 200, {
      ok: true,
      collections: [...collections.values()].map((c) => ({ id: c.id, name: c.name, items: c.ids.length })),
      created: counter,
    });
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
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
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

  if (req.method === 'DELETE' && url.pathname.startsWith('/Items/')) {
    const id = decodeURIComponent(url.pathname.slice('/Items/'.length));
    if (!collections.has(id)) { send(res, 404, {}); return; }
    collections.delete(id);
    send(res, 200, {});
    return;
  }

  if (url.pathname === '/Items') {
    const types = (url.searchParams.get('IncludeItemTypes') ?? '').split(',').filter(Boolean);
    const start = Number(url.searchParams.get('StartIndex') ?? '0');
    const limit = Number(url.searchParams.get('Limit') ?? '500');
    let rows = [];
    if (types.includes('CollectionFolder')) rows = libraryFolders;
    else if (types.includes('BoxSet')) {
      rows = [...foreignCollections, ...[...collections.values()].map((c) => ({ Id: c.id, Name: c.name, Type: 'BoxSet' }))];
    } else rows = library;
    send(res, 200, { Items: rows.slice(start, start + limit), TotalRecordCount: rows.length });
    return;
  }

  send(res, 404, {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`fake-jellyfin: listening on ${PORT}`);
});
