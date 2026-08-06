import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

// A faithful offline TorBox: the `requestdl` API and the CDN it hands you off to, in one process.
//
// WHY IT IS ONE PROCESS SERVING TWO ROLES. A real TorBox read is two hops — resolve at `api.torbox.app`,
// then range-read at a signed CDN URL on a DIFFERENT host — and the interesting failures live in the seam
// between them: a link that expires between resolve and read, a CDN that answers 200 to a ranged GET, a
// resolver that hands back an origin the allowlist does not name. A fixture that only modelled the API would
// exercise none of that. Serving both roles from one listener, on two path prefixes, keeps the two hops real
// while keeping the fixture a single thing to start and stop.
//
//   GET /v1/api/{torrents,webdl,usenet}/requestdl?token=…&{torrent_id,web_id,usenet_id}=…&file_id=…
//        -> {"success":true,"detail":"...","error":null,"data":"http://<self>/cdn/<signed>"}
//   GET /cdn/<signed>            Range: bytes=a-b   -> 206 + Content-Range
//   GET /control/...                                -> fault injection
//
// THE BYTES ARE DETERMINISTIC AND CONTENT-ADDRESSED. Each object's bytes come from a keyed hash of its
// reference and offset, so any run can compute the expected digest of any window without shipping a fixture
// file, and two runs of the gate compare the same values.

export type TorBoxFault =
  | 'none'
  // --- resolver-side ---------------------------------------------------------------------------------------
  | 'resolver-500' | 'resolver-429' | 'resolver-401' | 'resolver-403' | 'resolver-404'
  | 'resolver-not-json' | 'resolver-success-false' | 'resolver-no-data' | 'resolver-data-not-url'
  | 'resolver-data-plaintext' | 'resolver-wrong-origin' | 'resolver-timeout' | 'resolver-redirect'
  // --- CDN-side --------------------------------------------------------------------------------------------
  | 'cdn-expired' | 'cdn-401' | 'cdn-403' | 'cdn-429' | 'cdn-redirect'
  | 'cdn-full-body-on-range' | 'cdn-malformed-content-range' | 'cdn-mismatched-content-range'
  | 'cdn-wrong-total' | 'cdn-short-body' | 'cdn-long-body' | 'cdn-wrong-content-length' | 'cdn-timeout';

export interface FixtureObject {
  readonly ref: string;
  readonly sizeBytes: number;
}

export interface FixtureConfig {
  readonly objects: readonly FixtureObject[];
  readonly token: string;
  /** How the fixture describes itself in the links it mints. */
  readonly publicOrigin: string;
  /** Where `resolver-wrong-origin` points, so a gate can prove nothing ever dialled it. */
  readonly disallowedOrigin?: string;
  readonly linkLifetimeMs?: number;
}

export interface FixtureCounters {
  resolveRequests: number;
  cdnRequests: number;
  cdnBytes: number;
  status429: number;
  badTokenRequests: number;
  /** Requests that arrived at the deliberately-excluded origin. A gate asserts this stays zero. */
  disallowedOriginRequests: number;
}

/** Deterministic bytes for an object, so an expected digest can be computed without a fixture file. */
export function objectBytes(ref: string, offset: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  const blockSize = 4096;
  let written = 0;
  let block = Math.floor(offset / blockSize);
  let skip = offset % blockSize;
  while (written < length) {
    const digest = createHash('sha256').update(`${ref}:${block}`).digest();
    // 32 bytes of hash, repeated to fill a 4 KiB block. Cheap, deterministic, and not compressible enough
    // for a proxy to quietly serve something else.
    const source = Buffer.alloc(blockSize);
    for (let i = 0; i < blockSize; i += digest.length) digest.copy(source, i);
    const take = Math.min(blockSize - skip, length - written);
    source.copy(out, written, skip, skip + take);
    written += take;
    skip = 0;
    block += 1;
  }
  return out;
}

const KIND_BY_PATH: Readonly<Record<string, { kind: string; idParam: string }>> = Object.freeze({
  '/v1/api/torrents/requestdl': { kind: 'torrent', idParam: 'torrent_id' },
  '/v1/api/webdl/requestdl': { kind: 'webdl', idParam: 'web_id' },
  '/v1/api/usenet/requestdl': { kind: 'usenet', idParam: 'usenet_id' },
});

interface MintedLink { readonly ref: string; readonly expiresAt: number }

export interface TorBoxFixture {
  readonly server: ReturnType<typeof createServer>;
  readonly counters: FixtureCounters;
  setFault(fault: TorBoxFault, times?: number): void;
  expireAllLinks(): void;
  /**
   * Tells the fixture what it is reachable as, once it has a port.
   *
   * WHY THIS IS NEEDED AT ALL. The fixture mints links naming ITSELF, and a listener bound to port 0 does
   * not know its own port until it is listening. Without this, every minted link would name port 0 and the
   * whole two-hop shape -- resolve here, then range-read THERE -- would collapse into an unreachable URL.
   */
  setPublicOrigin(origin: string): void;
}

export function createTorBoxFixture(config: FixtureConfig): TorBoxFixture {
  const counters: FixtureCounters = {
    resolveRequests: 0, cdnRequests: 0, cdnBytes: 0, status429: 0,
    badTokenRequests: 0, disallowedOriginRequests: 0,
  };
  const links = new Map<string, MintedLink>();
  const sizes = new Map(config.objects.map((object) => [object.ref, object.sizeBytes]));
  const lifetime = config.linkLifetimeMs ?? 3 * 60 * 60 * 1000;
  let publicOrigin = config.publicOrigin;

  let fault: TorBoxFault = 'none';
  let faultTimes = 0;
  const takeFault = (): TorBoxFault => {
    if (fault === 'none' || faultTimes === 0) return 'none';
    if (faultTimes > 0) faultTimes -= 1;
    return fault;
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', publicOrigin);

    // --- control ------------------------------------------------------------------------------------------
    if (url.pathname === '/control/fault') {
      fault = (url.searchParams.get('fault') ?? 'none') as TorBoxFault;
      faultTimes = Number(url.searchParams.get('times') ?? '1');
      json(res, 200, { fault, times: faultTimes });
      return;
    }
    if (url.pathname === '/control/expire-links') { links.clear(); json(res, 200, { expired: true }); return; }
    if (url.pathname === '/control/counters') { json(res, 200, counters); return; }
    // The origin a gate proves was never dialled. Reaching it is itself the failure.
    if (url.pathname === '/disallowed') {
      counters.disallowedOriginRequests += 1;
      json(res, 200, { reached: true });
      return;
    }

    // --- the requestdl API --------------------------------------------------------------------------------
    const mapping = KIND_BY_PATH[url.pathname];
    if (mapping !== undefined) {
      counters.resolveRequests += 1;
      const active = takeFault();

      // THE CREDENTIAL IS A QUERY PARAMETER, exactly as TorBox's own contract has it. A fixture that took a
      // bearer header would let the gate pass while the real adapter sent the token somewhere it is ignored.
      if (url.searchParams.get('token') !== config.token) {
        counters.badTokenRequests += 1;
        json(res, 403, { success: false, detail: 'invalid token', error: 'AUTH_ERROR', data: null });
        return;
      }
      const id = url.searchParams.get(mapping.idParam);
      const fileId = url.searchParams.get('file_id');
      if (id === null || fileId === null) {
        json(res, 400, { success: false, detail: 'missing parameter', error: 'BAD_REQUEST', data: null });
        return;
      }
      const ref = `torbox:${mapping.kind}:${id}:${fileId}`;
      if (!sizes.has(ref)) {
        json(res, 404, { success: false, detail: 'not found', error: 'NOT_FOUND', data: null });
        return;
      }

      switch (active) {
        case 'resolver-500': json(res, 500, { success: false, detail: 'server error' }); return;
        case 'resolver-429': counters.status429 += 1; json(res, 429, { success: false }); return;
        case 'resolver-401': json(res, 401, { success: false }); return;
        case 'resolver-403': json(res, 403, { success: false }); return;
        case 'resolver-404': json(res, 404, { success: false }); return;
        case 'resolver-not-json':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{ "success": true, "data": "http');
          return;
        case 'resolver-success-false':
          json(res, 200, { success: false, detail: 'not ready', error: 'NOT_READY', data: null });
          return;
        case 'resolver-no-data': json(res, 200, { success: true, detail: 'ok', error: null }); return;
        case 'resolver-data-not-url':
          json(res, 200, { success: true, detail: 'ok', error: null, data: 'not-a-url' });
          return;
        case 'resolver-data-plaintext':
          json(res, 200, { success: true, data: `http://insecure.invalid/cdn/x` });
          return;
        case 'resolver-wrong-origin':
          json(res, 200, {
            success: true,
            data: `${config.disallowedOrigin ?? 'https://elsewhere.invalid'}/disallowed`,
          });
          return;
        case 'resolver-redirect':
          res.writeHead(302, { Location: `${publicOrigin}/v1/api/torrents/requestdl` });
          res.end();
          return;
        case 'resolver-timeout': return; // never answers; the caller's finite deadline must fire
        default: break;
      }

      const signed = randomBytes(24).toString('hex');
      links.set(signed, { ref, expiresAt: Date.now() + lifetime });
      json(res, 200, {
        success: true,
        detail: 'Got download link',
        error: null,
        data: `${publicOrigin}/cdn/${signed}`,
      });
      return;
    }

    // --- the CDN ------------------------------------------------------------------------------------------
    if (url.pathname.startsWith('/cdn/')) {
      counters.cdnRequests += 1;
      const active = takeFault();
      const signed = url.pathname.slice('/cdn/'.length);
      const link = links.get(signed);

      if (active === 'cdn-timeout') return;
      if (active === 'cdn-redirect') {
        res.writeHead(302, { Location: `${publicOrigin}/cdn/${signed}` });
        res.end();
        return;
      }
      // AN EXPIRED OR UNKNOWN LINK ANSWERS 401, which is what the data plane treats as "re-resolve once".
      if (link === undefined || active === 'cdn-expired' || active === 'cdn-401'
        || Date.now() > link.expiresAt) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'link expired' }));
        return;
      }
      if (active === 'cdn-403') { res.writeHead(403); res.end(); return; }
      if (active === 'cdn-429') { counters.status429 += 1; res.writeHead(429); res.end(); return; }

      const size = sizes.get(link.ref) as number;
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
      if (range === null) {
        // No range: the whole object. A ranged read that lands here is a data-plane bug, not a fixture one.
        res.writeHead(200, { 'Content-Length': String(size) });
        res.end(objectBytes(link.ref, 0, size));
        return;
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), size - 1);
      const length = end - start + 1;

      if (active === 'cdn-full-body-on-range') {
        // 200 WITH THE WHOLE OBJECT — the most expensive protocol failure available, and the one the daemon
        // must refuse at the header without reading a byte.
        res.writeHead(200, { 'Content-Length': String(size) });
        res.end(objectBytes(link.ref, 0, size));
        return;
      }

      const headers: Record<string, string> = { 'Accept-Ranges': 'bytes' };
      let body = objectBytes(link.ref, start, length);
      let contentRange = `bytes ${start}-${end}/${size}`;

      switch (active) {
        case 'cdn-malformed-content-range': contentRange = `bytes ${start}-${end}`; break;
        case 'cdn-mismatched-content-range': contentRange = `bytes ${start + 7}-${end + 7}/${size}`; break;
        case 'cdn-wrong-total': contentRange = `bytes ${start}-${end}/${size + 1}`; break;
        case 'cdn-short-body': body = body.subarray(0, Math.max(0, body.length - 16)); break;
        case 'cdn-long-body': body = Buffer.concat([body, Buffer.alloc(64)]); break;
        case 'cdn-wrong-content-length': headers['Content-Length'] = String(length + 5); break;
        default: break;
      }
      headers['Content-Range'] = contentRange;
      if (headers['Content-Length'] === undefined) headers['Content-Length'] = String(body.length);
      counters.cdnBytes += body.length;
      res.writeHead(206, headers);
      res.end(body);
      return;
    }

    if (url.pathname === '/healthz') { json(res, 200, { alive: true }); return; }
    json(res, 404, { error: 'not found' });
  });

  return {
    server,
    counters,
    setFault(next: TorBoxFault, times = 1) { fault = next; faultTimes = times; },
    expireAllLinks() { links.clear(); },
    setPublicOrigin(origin: string) { publicOrigin = origin; },
  };
}
