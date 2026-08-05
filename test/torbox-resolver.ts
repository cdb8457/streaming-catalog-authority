import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  TORBOX_ASSUMED_LIFETIME_MS, TORBOX_LINK_LIFETIME_MS, TORBOX_REQUESTDL, TORBOX_SOURCE_KINDS,
  TorBoxRefError, TorBoxResolveError, buildRequestUrl, classifyStatus, findSecretShapes, formatStableRef,
  parseResolveBody, parseStableRef, redactError,
} from '../src/core/adapters/torbox-resolver.js';
import { createTorBoxFixture, objectBytes, type TorBoxFault } from '../src/ops/torbox-fixture-service.js';
import { createResolverService, readSecretFile } from '../src/ops/torbox-resolver-service.js';

// The TorBox resolver, attacked offline.
//
// WHAT MAKES THIS SUITE DIFFERENT FROM PARSING TESTS. The point of the adapter is that a TorBox object
// becomes an ordinary read-only file. A suite that only checked `parseStableRef` would pass while the
// resolver was never invoked at all. So the core of what follows stands up the FIXTURE, stands up the REAL
// resolver service against it, and drives the real service over HTTP the way the projection daemon drives
// it — same POST body, same bearer, same three response fields. Every fault below is injected into a real
// listener and observed through a real client.
//
// THE ONE THING IT CANNOT DO IS TALK TO TORBOX. No test here contacts a real account, reads a real
// credential, or searches for one. What it proves is that the adapter speaks the contract TorBox publishes;
// whether TorBox honours its own contract is a question only the operator-run real gate can answer.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const repoFile = (path: string): string => readFileSync(join(HERE, '..', path), 'utf8');

let passed = 0;
let failed = 0;
const failures: [string, unknown][] = [];

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push([name, error]);
    console.log(`FAIL  ${name}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const TOKEN = 'fixture-api-key-0123456789abcdef';
const GATE = 'gate-secret-fedcba9876543210';
const SIZE = 4 * 1024 * 1024;
const REF_TORRENT = 'torbox:torrent:1234:0';
const REF_WEBDL = 'torbox:webdl:5678:1';
const REF_USENET = 'torbox:usenet:9012:2';

// ---------------------------------------------------------------------------------------------------------
// A live fixture and a live resolver, for the tests that need the whole path
// ---------------------------------------------------------------------------------------------------------

interface Harness {
  readonly resolverUrl: string;
  readonly fixture: ReturnType<typeof createTorBoxFixture>;
  readonly credentialFile: string;
  readonly gateFile: string;
  close(): Promise<void>;
}

async function harness(over: { token?: string; allowPlaintextLink?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'torbox-'));
  const credentialFile = join(dir, 'credential');
  const gateFile = join(dir, 'gate');
  writeFileSync(credentialFile, `${over.token ?? TOKEN}\n`);
  writeFileSync(gateFile, `${GATE}\n`);
  if (process.platform !== 'win32') {
    chmodSync(credentialFile, 0o600);
    chmodSync(gateFile, 0o600);
  }

  const fixture = createTorBoxFixture({
    objects: [
      { ref: REF_TORRENT, sizeBytes: SIZE },
      { ref: REF_WEBDL, sizeBytes: SIZE },
      { ref: REF_USENET, sizeBytes: SIZE },
    ],
    token: TOKEN,
    publicOrigin: 'http://127.0.0.1:0',
    disallowedOrigin: 'http://127.0.0.1:1',
  });
  await new Promise<void>((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  const fixturePort = (fixture.server.address() as AddressInfo).port;
  const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
  // THE FIXTURE MINTS LINKS NAMING ITSELF, and a listener bound to port 0 does not know its own port until
  // it is listening. Without this the minted links would name port 0 and the two-hop shape would collapse.
  fixture.setPublicOrigin(fixtureOrigin);

  const service = createResolverService({
    host: '127.0.0.1', port: 0, credentialFile, gateSecretFile: gateFile, apiOrigin: fixtureOrigin,
    requestTimeoutMs: 2_000, maxAttempts: 3,
    // THE OFFLINE FIXTURE SERVES PLAINTEXT ON LOOPBACK, so most tests here need the exemption. It is
    // opt-OUT rather than opt-in for this harness alone; the module's own default is to REFUSE plaintext,
    // and the two tests below prove that default is what a caller who says nothing gets.
    allowPlaintextLink: over.allowPlaintextLink ?? true,
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  const resolverPort = (service.address() as AddressInfo).port;

  return {
    resolverUrl: `http://127.0.0.1:${resolverPort}/resolve`,
    fixture,
    credentialFile,
    gateFile,
    close: async () => {
      await new Promise<void>((resolve) => service.close(() => resolve()));
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    },
  };
}

/** Drives the resolver EXACTLY as `projectiond/internal/source/resolver.go` does. */
async function askResolver(url: string, objectRef: string, bearer = GATE): Promise<{
  status: number; body: { url?: string; headers?: Record<string, string>; expiresAtUnixMs?: number };
}> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ objectRef }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = {}; }
  return { status: response.status, body };
}

async function main(): Promise<void> {
  console.log('\ntorbox resolver (offline)\n');

  // -------------------------------------------------------------------------------------------------------
  // The published contract, as recorded from TorBox's own SDK source
  // -------------------------------------------------------------------------------------------------------

  await test('THE THREE ENDPOINTS AND THEIR WIRE PARAMETER NAMES ARE THE OFFICIAL ONES', () => {
    // These four strings per family are the entire integration surface. They were taken from TorBox's own
    // SDK source rather than from prose, because prose says `torrentId` where the wire says `torrent_id` —
    // and a resolver that sent the camelCase spelling would be silently ignored and answer 400 forever.
    assert(TORBOX_REQUESTDL.torrent.path === '/v1/api/torrents/requestdl', 'the torrent path');
    assert(TORBOX_REQUESTDL.torrent.idParam === 'torrent_id', 'the torrent id parameter');
    assert(TORBOX_REQUESTDL.webdl.path === '/v1/api/webdl/requestdl', 'the webdl path');
    assert(TORBOX_REQUESTDL.webdl.idParam === 'web_id', 'the webdl id parameter');
    assert(TORBOX_REQUESTDL.usenet.path === '/v1/api/usenet/requestdl', 'the usenet path');
    assert(TORBOX_REQUESTDL.usenet.idParam === 'usenet_id', 'the usenet id parameter');
  });

  await test('THE REQUEST CARRIES THE CREDENTIAL AS A QUERY PARAMETER, WHICH IS WHY IT IS A SECRET', () => {
    // TorBox authenticates requestdl with ?token=, not a header. That makes the REQUEST URL a bearer
    // credential, and it is the single fact that shapes every redaction rule in this adapter.
    const url = buildRequestUrl(parseStableRef(REF_TORRENT), TOKEN);
    assert(url.searchParams.get('token') === TOKEN, 'the token is a query parameter');
    assert(url.searchParams.get('torrent_id') === '1234', 'the item id is a query parameter');
    assert(url.searchParams.get('file_id') === '0', 'as is the file id');
    assert(url.origin === 'https://api.torbox.app', 'and the default origin is the official one');
    // `redirect` MUST NEVER BE SET: with it TorBox answers 3xx toward a CDN host, and this contract needs
    // the JSON body — while the data plane refuses to follow redirects at all.
    assert(!url.searchParams.has('redirect'), 'redirect is never requested');
    assert(findSecretShapes(url.toString(), 'url').length > 0,
      'and the resulting URL is recognised by the scrubber as something that must never be printed');
  });

  await test('A REFERENCE CANNOT SMUGGLE A PARAMETER INTO THE URL', () => {
    // If the parser were ever loosened, the escaping still has to hold.
    for (const hostile of ['torbox:torrent:1&file_id=9:0', 'torbox:torrent:1:0&admin=1',
      'torbox:torrent:../../x:0', 'torbox:torrent:1 2:0', 'torbox:torrent:+1:0', 'torbox:torrent:0x10:0']) {
      let threw = false;
      try { parseStableRef(hostile); } catch { threw = true; }
      assert(threw, `the parser accepted ${JSON.stringify(hostile)}`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // Reference parsing
  // -------------------------------------------------------------------------------------------------------

  await test('A WELL-FORMED REFERENCE ROUND-TRIPS FOR ALL THREE KINDS', () => {
    for (const ref of [REF_TORRENT, REF_WEBDL, REF_USENET]) {
      assert(formatStableRef(parseStableRef(ref)) === ref, `${ref} did not round-trip`);
    }
    assert(TORBOX_SOURCE_KINDS.length === 3, 'there are exactly three source kinds');
  });

  await test('EVERY MALFORMED REFERENCE IS REFUSED, AND THE FAILURE NEVER QUOTES IT BACK', () => {
    // A malformed reference is still somebody's account data, and a parser is most tempted to quote its
    // input at exactly the moment it must not.
    const hostile = [
      '', 'torbox', 'torbox:torrent', 'torbox:torrent:1', 'torbox:torrent:1:0:extra',
      'http:torrent:1:0', 'torbox:magnet:1:0', 'torbox:TORRENT:1:0',
      'torbox:torrent:-1:0', 'torbox:torrent:01:0', 'torbox:torrent:1.0:0', 'torbox:torrent:1e3:0',
      'torbox:torrent::0', 'torbox:torrent:1:', 'torbox:torrent:1:-0',
      `torbox:torrent:${'9'.repeat(30)}:0`, `torbox:torrent:1:0${' '.repeat(200)}`,
    ];
    for (const raw of hostile) {
      let error: unknown;
      try { parseStableRef(raw); } catch (caught) { error = caught; }
      assert(error instanceof TorBoxRefError, `the parser accepted ${JSON.stringify(raw)}`);
      const message = (error as Error).message;
      assert(!message.includes(raw) || raw === '',
        `the failure quoted the reference back: ${message.slice(0, 60)}`);
      assert(findSecretShapes(message, 'msg').length === 0, 'and it must carry no secret shape');
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // Response handling — fail closed on anything ambiguous
  // -------------------------------------------------------------------------------------------------------

  await test('A WELL-FORMED SUCCESS YIELDS A BOUNDED, SHORTER-THAN-DOCUMENTED EXPIRY', () => {
    const now = 1_000_000;
    const resolved = parseResolveBody(
      { success: true, detail: 'Got download link', error: null, data: 'https://cdn.invalid/a?sig=b' }, now);
    assert(resolved.url === 'https://cdn.invalid/a?sig=b', 'the URL is carried through');
    assert(resolved.expiresAtUnixMs === now + TORBOX_ASSUMED_LIFETIME_MS, 'the expiry is the assumed one');
    // TorBox documents three hours and returns no expiry field. Treating a link as good for the full window
    // means the first read after 2h59m races the expiry, and the failure is a stall rather than a refresh.
    assert(TORBOX_ASSUMED_LIFETIME_MS < TORBOX_LINK_LIFETIME_MS,
      'the assumed lifetime must be strictly shorter than the documented one');
  });

  await test('EVERY AMBIGUOUS PROVIDER BODY IS REFUSED RATHER THAN GUESSED', () => {
    // TorBox marks all four response fields optional, so a body can be valid JSON, arrive with HTTP 200 and
    // still say nothing usable. Every guess here would hand the data plane something that is not a URL.
    const bodies: [unknown, string][] = [
      [null, 'null'],
      ['a string', 'a bare string'],
      [[], 'an array'],
      [{}, 'an empty object'],
      [{ data: 'https://cdn.invalid/a' }, 'a link with no success flag'],
      [{ success: false, data: 'https://cdn.invalid/a' }, 'a link with success false'],
      [{ success: 'true', data: 'https://cdn.invalid/a' }, 'a stringy success'],
      [{ success: true }, 'success with no data'],
      [{ success: true, data: '' }, 'success with an empty link'],
      [{ success: true, data: 42 }, 'success with a numeric link'],
      [{ success: true, data: 'not-a-url' }, 'success with a non-URL'],
      [{ success: true, data: 'http://cdn.invalid/a' }, 'a plaintext link'],
      [{ success: true, data: 'ftp://cdn.invalid/a' }, 'a non-http scheme'],
    ];
    for (const [body, what] of bodies) {
      let threw = false;
      try { parseResolveBody(body, 0); } catch (error) {
        threw = error instanceof TorBoxResolveError;
        assert(findSecretShapes((error as Error).message, 'msg').length === 0,
          `the refusal of ${what} carried a secret shape`);
      }
      assert(threw, `${what} was accepted`);
    }
  });

  await test('THE PROVIDER’S OWN detail AND error STRINGS ARE NEVER REPEATED OUTWARD', () => {
    // Those fields routinely carry the item name, and on some errors the request URL.
    let message = '';
    try {
      parseResolveBody({
        success: false,
        detail: 'failed for https://api.torbox.app/v1/api/torrents/requestdl?token=SECRET&torrent_id=9',
        error: 'The Godfather (1972).mkv',
      }, 0);
    } catch (error) { message = (error as Error).message; }
    assert(message !== '', 'it must refuse');
    assert(findSecretShapes(message, 'msg').length === 0,
      `the refusal repeated the provider's message: ${message.slice(0, 80)}`);
    assert(!message.includes('Godfather'), 'and it must not carry a filename');
  });

  await test('STATUS CLASSIFICATION MAKES AUTH TERMINAL AND 429 RETRYABLE', () => {
    assert(classifyStatus(200) === 'ok', '200');
    for (const status of [401, 403]) {
      // Terminal HERE on purpose: the one-refresh-per-read rule lives above this. Retrying an auth failure
      // inside the resolver would spend the operator's rate limit rediscovering the same answer.
      assert(classifyStatus(status) === 'auth', `${status} is an auth failure, not a retry`);
    }
    for (const status of [404, 410]) assert(classifyStatus(status) === 'unknown-ref', `${status}`);
    for (const status of [408, 429, 500, 502, 503, 504]) {
      assert(classifyStatus(status) === 'retryable', `${status} must be retryable`);
    }
    for (const status of [301, 302, 307, 400, 405, 418]) {
      assert(classifyStatus(status) === 'terminal', `${status} must be terminal`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // Credential handling
  // -------------------------------------------------------------------------------------------------------

  await test('A CREDENTIAL FILE IS REFUSED UNLESS IT IS PRIVATE, PRESENT AND PLAUSIBLE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torbox-cred-'));
    const path = join(dir, 'credential');

    let threw = false;
    try { readSecretFile(path, 'x'); } catch { threw = true; }
    assert(threw, 'a missing credential file was accepted');

    writeFileSync(path, '');
    threw = false;
    try { readSecretFile(path, 'x'); } catch { threw = true; }
    assert(threw, 'an empty credential file was accepted');

    writeFileSync(path, '   \n  ');
    threw = false;
    try { readSecretFile(path, 'x'); } catch { threw = true; }
    assert(threw, 'a whitespace-only credential file was accepted');

    writeFileSync(path, 'x'.repeat(9_000));
    threw = false;
    try { readSecretFile(path, 'x'); } catch { threw = true; }
    assert(threw, 'an oversized credential file was accepted');

    writeFileSync(path, TOKEN);
    if (process.platform !== 'win32') {
      for (const mode of [0o644, 0o640, 0o604, 0o666, 0o777]) {
        chmodSync(path, mode);
        threw = false;
        try { readSecretFile(path, 'x'); } catch { threw = true; }
        assert(threw, `a credential file at mode ${mode.toString(8)} was accepted`);
      }
      chmodSync(path, 0o600);
    }
    assert(readSecretFile(path, 'x') === TOKEN, 'and a private, plausible file is read');
  });

  // -------------------------------------------------------------------------------------------------------
  // THE WHOLE PATH: a real resolver service, a real fixture, driven the way the daemon drives it
  // -------------------------------------------------------------------------------------------------------

  await test('ALL THREE SOURCE KINDS RESOLVE END TO END THROUGH THE REAL SERVICE', async () => {
    // This is the test that would notice the adapter never being invoked. It stands up the fixture and the
    // service and drives the service over HTTP with the daemon's own request shape.
    const h = await harness();
    try {
      for (const ref of [REF_TORRENT, REF_WEBDL, REF_USENET]) {
        const answer = await askResolver(h.resolverUrl, ref);
        assert(answer.status === 200, `${ref} did not resolve: ${answer.status}`);
        assert(typeof answer.body.url === 'string' && answer.body.url.includes('/cdn/'),
          `${ref} did not yield a CDN link`);
        // THE THREE FIELDS THE DAEMON DECODES, and nothing else is required of the response.
        assert(typeof answer.body.expiresAtUnixMs === 'number' && answer.body.expiresAtUnixMs > Date.now(),
          'the expiry must be in the future');
        assert(JSON.stringify(answer.body.headers) === '{}',
          'no headers: a TorBox CDN link is pre-signed, and attaching the API key would hand the '
          + 'operator account credential to whatever host the link names');
      }
      assert(h.fixture.counters.resolveRequests === 3, 'the fixture saw exactly three resolutions');
      assert(h.fixture.counters.badTokenRequests === 0, 'and the credential was accepted every time');
    } finally { await h.close(); }
  });

  await test('THE RESOLVED LINK ACTUALLY SERVES THE RIGHT BYTES BY RANGE, BACKWARD AND AT THE TAIL', async () => {
    // A resolver that returned a syntactically valid URL to nothing would pass every test above.
    const h = await harness();
    try {
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      const link = answer.body.url as string;

      // The tail, past 90% — where a container index lives and where a stream-from-zero implementation fails.
      const tailOffset = Math.floor(SIZE * 0.91);
      const tail = await fetch(link, { headers: { Range: `bytes=${tailOffset}-${tailOffset + 4095}` } });
      assert(tail.status === 206, `a ranged GET must be answered 206, got ${tail.status}`);
      assert(tail.headers.get('content-range') === `bytes ${tailOffset}-${tailOffset + 4095}/${SIZE}`,
        'with an exact Content-Range naming the right total');
      const tailBytes = Buffer.from(await tail.arrayBuffer());
      assert(tailBytes.equals(objectBytes(REF_TORRENT, tailOffset, 4096)), 'and the right bytes');

      // Then BACKWARD, to a lower offset than one already read.
      const back = await fetch(link, { headers: { Range: 'bytes=0-4095' } });
      assert(back.status === 206, 'a backward ranged read must also be 206');
      const backBytes = Buffer.from(await back.arrayBuffer());
      assert(backBytes.equals(objectBytes(REF_TORRENT, 0, 4096)), 'and carry the right bytes');
      assert(!backBytes.equals(tailBytes), 'and the two windows must differ, or the fixture is not real');
    } finally { await h.close(); }
  });

  await test('AN EXPIRED LINK IS RECOVERED BY EXACTLY ONE FRESH RESOLUTION', async () => {
    // The data plane's rule is at most one refresh per read. What is proved here is the half this adapter
    // owns: a second resolution of the same reference yields a DIFFERENT, working link, so a refresh is
    // capable of recovering. `projectiond/internal/source/http_test.go` owns the once-and-only-once half.
    const h = await harness();
    try {
      const first = (await askResolver(h.resolverUrl, REF_TORRENT)).body.url as string;
      h.fixture.expireAllLinks();
      const stale = await fetch(first, { headers: { Range: 'bytes=0-15' } });
      assert(stale.status === 401, `an expired link must answer 401, got ${stale.status}`);

      const second = (await askResolver(h.resolverUrl, REF_TORRENT)).body.url as string;
      assert(second !== first, 'a refresh must mint a new link, not return the dead one');
      const fresh = await fetch(second, { headers: { Range: 'bytes=0-15' } });
      assert(fresh.status === 206, 'and the new link must work');
      assert(h.fixture.counters.resolveRequests === 2, 'at the cost of exactly one extra resolution');
    } finally { await h.close(); }
  });

  await test('A WRONG CREDENTIAL IS REFUSED BY THE PROVIDER AND NEVER RETRIED', async () => {
    const h = await harness({ token: 'the-wrong-key' });
    try {
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      assert(answer.status === 403, `expected a terminal refusal, got ${answer.status}`);
      // NOT RETRIED. A rotated key gives the same answer however many times it is asked, and each ask spends
      // the operator's rate limit.
      assert(h.fixture.counters.badTokenRequests === 1,
        `the resolver retried an auth failure ${h.fixture.counters.badTokenRequests} times`);
    } finally { await h.close(); }
  });

  await test('THE GATE SECRET IS REQUIRED, AND A WRONG ONE REACHES NO PROVIDER', async () => {
    const h = await harness();
    try {
      for (const bearer of ['', 'wrong', `${GATE}x`, GATE.slice(0, -1)]) {
        const answer = await askResolver(h.resolverUrl, REF_TORRENT, bearer);
        assert(answer.status === 401, `a bad gate secret was accepted (${answer.status})`);
      }
      assert(h.fixture.counters.resolveRequests === 0,
        'a request that failed the gate must never reach the provider');
    } finally { await h.close(); }
  });

  await test('A MALFORMED REFERENCE IS REFUSED WITHOUT CONTACTING THE PROVIDER', async () => {
    const h = await harness();
    try {
      for (const ref of ['', 'torbox:torrent:1', 'not-a-ref', 'torbox:magnet:1:0']) {
        const answer = await askResolver(h.resolverUrl, ref);
        assert(answer.status === 400, `${JSON.stringify(ref)} was not refused (${answer.status})`);
      }
      assert(h.fixture.counters.resolveRequests === 0,
        'a malformed reference must cost the provider nothing');
    } finally { await h.close(); }
  });

  // -------------------------------------------------------------------------------------------------------
  // Every provider misbehaviour, injected into a real listener
  // -------------------------------------------------------------------------------------------------------

  const resolverFaults: [TorBoxFault, string][] = [
    ['resolver-not-json', 'a truncated body'],
    ['resolver-success-false', 'success false under HTTP 200'],
    ['resolver-no-data', 'success with no link'],
    ['resolver-data-not-url', 'a link that is not a URL'],
    ['resolver-401', 'an unauthorized status'],
    ['resolver-403', 'a forbidden status'],
    ['resolver-404', 'an unknown item'],
    ['resolver-redirect', 'a redirect'],
  ];

  for (const [fault, what] of resolverFaults) {
    await test(`THE RESOLVER FAILS CLOSED ON ${what.toUpperCase()}`, async () => {
      const h = await harness();
      try {
        h.fixture.setFault(fault, 5);
        const answer = await askResolver(h.resolverUrl, REF_TORRENT);
        assert(answer.status !== 200, `${what} produced a 200`);
        assert(answer.body.url === undefined, `${what} produced a URL`);
        const rendered = JSON.stringify(answer.body);
        assert(findSecretShapes(rendered, 'response').length === 0,
          `${what} leaked something into the response: ${rendered.slice(0, 80)}`);
      } finally { await h.close(); }
    });
  }

  await test('A PLAINTEXT LINK IS REFUSED WHEN THE FIXTURE EXEMPTION IS NOT ASKED FOR', async () => {
    // THE EXEMPTION IS THE MOST DANGEROUS LINE IN THIS ADAPTER. The fixture serves plaintext on loopback, so
    // an exemption has to exist; if it could be acquired by accident, a real deployment would accept a CDN
    // link that carries the operator's entitlement in the clear. So this runs a service configured EXACTLY
    // like a production one — by saying nothing about plaintext — and requires the refusal.
    const h = await harness({ allowPlaintextLink: false });
    try {
      h.fixture.setFault('resolver-data-plaintext', 5);
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      assert(answer.status !== 200, `a plaintext link was accepted (${answer.status})`);
      assert(answer.body.url === undefined, 'and a URL was handed back');
    } finally { await h.close(); }
  });

  await test('THE MODULE ITSELF DEFAULTS TO REFUSING PLAINTEXT, WITH NO ARGUMENT AT ALL', () => {
    // Below the service, at the function every path funnels through: called with two arguments, the way a
    // caller who has never heard of the exemption calls it.
    let threw = false;
    try { parseResolveBody({ success: true, data: 'http://cdn.invalid/a' }, 0); } catch { threw = true; }
    assert(threw, 'parseResolveBody accepted a plaintext link by default');
    // Explicitly false must behave the same as omitted.
    threw = false;
    try { parseResolveBody({ success: true, data: 'http://cdn.invalid/a' }, 0, false); } catch { threw = true; }
    assert(threw, 'an explicit false did not refuse');
    // And the exemption must not widen to anything but http.
    for (const scheme of ['ftp', 'file', 'data', 'gopher']) {
      threw = false;
      try { parseResolveBody({ success: true, data: `${scheme}://x/a` }, 0, true); } catch { threw = true; }
      assert(threw, `the exemption admitted ${scheme}:`);
    }
    // https is accepted in both modes, because that is the real contract.
    assert(parseResolveBody({ success: true, data: 'https://cdn.invalid/a' }, 0).url === 'https://cdn.invalid/a',
      'https must be accepted with no exemption');
  });

  await test('THE EXEMPTION IS SET IN EXACTLY ONE PLACE IN SHIPPED CODE, AND IT IS OPT-IN', () => {
    const cli = repoFile('src/ops/torbox-resolver-cli.ts');
    const service = repoFile('src/ops/torbox-resolver-service.ts');
    // IT IS NOW STRICTER THAN A SINGLE FLAG: the relaxation requires --fixture-mode AS WELL, so a
    // deployment cannot acquire it without the word fixture appearing on its command line.
    assert(/allowPlaintextLink: fixtureMode && argv\.includes\('--fixture-plaintext-link'\)/.test(cli),
      'the CLI must require BOTH the fixture-mode switch and the explicit flag');
    assert(/--api-origin-file is FIXTURE-ONLY/.test(cli),
      'and the API origin override must fail closed outside fixture mode');
    assert(/config\.allowPlaintextLink === true/.test(service),
      'and the service must require an exact true rather than any truthy value');
    assert(!/allowPlaintextLink:\s*true/.test(cli) && !/allowPlaintextLink:\s*true/.test(service),
      'no shipped file may hard-code the exemption on');
  });

  await test('A RETRYABLE STATUS IS RETRIED, BOUNDED, AND THEN GIVES UP', async () => {
    // 429 is the one the backoff exists for: TorBox meters this endpoint, and an unbounded retry against a
    // rate limit is how a correctness gate becomes a denial of service on the operator's own account.
    const h = await harness();
    try {
      h.fixture.setFault('resolver-429', 99);
      const started = Date.now();
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      assert(answer.status === 502, `expected a bounded give-up, got ${answer.status}`);
      assert(h.fixture.counters.resolveRequests === 3,
        `expected exactly 3 attempts, saw ${h.fixture.counters.resolveRequests}`);
      assert(Date.now() - started < 10_000, 'and the whole thing stayed inside a finite budget');
      assert(h.fixture.counters.status429 === 3, 'with every 429 recorded');
    } finally { await h.close(); }
  });

  await test('A RETRYABLE STATUS THAT CLEARS IS RECOVERED WITHIN THE BOUND', async () => {
    const h = await harness();
    try {
      h.fixture.setFault('resolver-429', 1);
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      assert(answer.status === 200, `a transient 429 should have been ridden out, got ${answer.status}`);
      assert(h.fixture.counters.resolveRequests === 2, 'in exactly two attempts');
    } finally { await h.close(); }
  });

  await test('A HANGING PROVIDER HITS A FINITE DEADLINE RATHER THAN HANGING THE READER', async () => {
    const h = await harness();
    try {
      h.fixture.setFault('resolver-timeout', 99);
      const started = Date.now();
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      assert(answer.status !== 200, 'a hanging provider must not produce a link');
      // Three attempts at a 2s timeout plus backoff; generous, but finite is the point.
      assert(Date.now() - started < 20_000, 'and the deadline must actually fire');
    } finally { await h.close(); }
  });

  await test('A LINK POINTING AT AN ORIGIN THE OPERATOR NEVER AUTHORISED IS NEVER DIALLED', async () => {
    // The resolver hands the URL back and the DAEMON checks it against the egress allowlist and re-checks
    // every address at dial time. What is proved here is the half this service owns: it does not itself
    // fetch the link, so a hostile origin is never contacted by this process.
    const h = await harness();
    try {
      h.fixture.setFault('resolver-wrong-origin', 1);
      const answer = await askResolver(h.resolverUrl, REF_TORRENT);
      // It may be handed back — the daemon is the authority on the allowlist — but nothing dialled it.
      assert(h.fixture.counters.disallowedOriginRequests === 0,
        'the resolver dialled the origin it was handed');
      if (answer.status === 200) {
        assert(!(answer.body.url ?? '').includes('api.torbox.app'),
          'and the link is the one the provider named, unmodified, for the daemon to judge');
      }
    } finally { await h.close(); }
  });

  // -------------------------------------------------------------------------------------------------------
  // CDN-side protocol discipline, observed through a real client
  // -------------------------------------------------------------------------------------------------------

  await test('THE FIXTURE CAN PRODUCE EVERY CDN PROTOCOL VIOLATION THE DATA PLANE MUST REFUSE', async () => {
    // The daemon's refusal of each of these is proved in Go (`source/http_test.go`). What is proved here is
    // that the fixture can actually MAKE each one happen, so those refusals are exercisable end to end
    // rather than only against a hand-built response.
    const h = await harness();
    try {
      const cases: [TorBoxFault, (r: Response, body: Buffer) => boolean, string][] = [
        ['cdn-full-body-on-range', (r) => r.status === 200, 'a 200 full body answering a ranged GET'],
        ['cdn-malformed-content-range',
          (r) => !/^bytes \d+-\d+\/\d+$/.test(r.headers.get('content-range') ?? ''), 'a malformed range'],
        ['cdn-mismatched-content-range',
          (r) => (r.headers.get('content-range') ?? '').startsWith('bytes 7-'), 'a mismatched range'],
        ['cdn-wrong-total',
          (r) => (r.headers.get('content-range') ?? '').endsWith(`/${SIZE + 1}`), 'a wrong total'],
        ['cdn-short-body', (_r, b) => b.length < 4096, 'a short body'],
        ['cdn-long-body', (_r, b) => b.length > 4096, 'a long body'],
        ['cdn-401', (r) => r.status === 401, 'an expired link'],
        ['cdn-429', (r) => r.status === 429, 'a rate limit'],
        ['cdn-redirect', (r) => r.status === 302 || r.redirected, 'a redirect'],
      ];
      for (const [fault, check, what] of cases) {
        const link = (await askResolver(h.resolverUrl, REF_TORRENT)).body.url as string;
        h.fixture.setFault(fault, 1);
        const response = await fetch(link, {
          headers: { Range: 'bytes=0-4095' }, redirect: 'manual',
        });
        const body = Buffer.from(await response.arrayBuffer());
        assert(check(response, body), `the fixture could not produce ${what}`);
      }
    } finally { await h.close(); }
  });

  await test('THE FIXTURE’S BYTES ARE DETERMINISTIC AND CONTENT-ADDRESSED', () => {
    // Two runs of the gate must compare the same digests, and two different objects must not collide.
    const a = objectBytes(REF_TORRENT, 0, 8192);
    const b = objectBytes(REF_TORRENT, 0, 8192);
    assert(a.equals(b), 'the same window must produce the same bytes');
    assert(!objectBytes(REF_WEBDL, 0, 8192).equals(a), 'two objects must not share bytes');
    assert(!objectBytes(REF_TORRENT, 8192, 8192).equals(a), 'two windows must not share bytes');
    // A window read whole and in two halves must agree, or every offset assertion is meaningless.
    const whole = objectBytes(REF_TORRENT, 100, 9000);
    const split = Buffer.concat([objectBytes(REF_TORRENT, 100, 4000), objectBytes(REF_TORRENT, 4100, 5000)]);
    assert(whole.equals(split), 'the byte function must be offset-consistent across block boundaries');
    assert(createHash('sha256').update(whole).digest('hex').length === 64, 'and digestible');
  });

  // -------------------------------------------------------------------------------------------------------
  // Redaction, which is what makes this adapter safe to run at all
  // -------------------------------------------------------------------------------------------------------

  await test('THE SCRUBBER RECOGNISES EVERY SHAPE THIS ADAPTER CAN LEAK', () => {
    for (const text of [
      'https://api.torbox.app/v1/api/torrents/requestdl?token=abc&torrent_id=1&file_id=0',
      'http://cdn.torbox.app/x',
      'token=deadbeef',
      'torbox:torrent:1234:0',
      'torbox:usenet:9:1',
      'Bearer abc123',
      'torrent_id=1234',
      'web_id=99',
      'usenet_id=7',
      'file_id=3',
    ]) {
      assert(findSecretShapes(text, 'x').length > 0, `the scrubber let through: ${text.slice(0, 40)}`);
    }
    // ...and it does not flag what a report legitimately says.
    for (const text of ['resolved a torrent reference in 1 attempt(s)', 'the provider answered 429',
      'object-1', 'torrent', '206', 'bytes 0-4095/4194304']) {
      assert(findSecretShapes(text, 'x').length === 0, `the scrubber flagged legitimate text: ${text}`);
    }
  });

  await test('A THROWN PROVIDER ERROR CARRYING A URL IS REPLACED WHOLESALE, NOT SCRUBBED IN PLACE', () => {
    // One unguarded `catch (e) { log(e.message) }` above this boundary would publish the operator's API key,
    // because a fetch failure's message routinely carries the URL it could not reach.
    const leaky = new Error('connect ECONNREFUSED https://api.torbox.app/v1/api/torrents/requestdl?token=SEC');
    const safe = redactError(leaky);
    assert(!safe.includes('token='), 'the redaction left the token in');
    assert(!safe.includes('api.torbox.app'), 'and the host');
    assert(findSecretShapes(safe, 'x').length === 0, 'and the result is clean');
    // A partial scrub of an unknown format is a guess, so the whole message goes.
    assert(/withheld/.test(safe), 'and it says the message was withheld rather than pretending to be one');
    assert(redactError(new Error('the provider answered 429')) === 'the provider answered 429',
      'while a clean message passes through unchanged');
  });

  await test('NOTHING THE SERVICE LOGS OR RETURNS CARRIES A REFERENCE, A TOKEN OR A REQUEST URL', async () => {
    const h = await harness();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      await askResolver(h.resolverUrl, REF_TORRENT);
      await askResolver(h.resolverUrl, 'torbox:torrent:1:1');
      await askResolver(h.resolverUrl, 'malformed', 'wrong');
      h.fixture.setFault('resolver-403', 2);
      await askResolver(h.resolverUrl, REF_WEBDL);
    } finally {
      console.log = originalLog;
      await h.close();
    }
    assert(lines.length > 0, 'the service logged nothing at all, so this proves nothing');
    for (const line of lines) {
      assert(findSecretShapes(line, 'log').length === 0, `a log line leaked: ${line.slice(0, 90)}`);
      assert(!line.includes(TOKEN), 'a log line carried the credential');
      assert(!line.includes('1234'), 'a log line carried a provider identifier');
    }
    // It must still say something useful, or "we log nothing" is a way to pass this test trivially.
    assert(lines.some((line) => /torrent|webdl|usenet/.test(line)),
      'the service must still record which kind of reference it handled');
  });

  await test('THE SHIPPED CODE NEVER PUTS A SECRET ON A COMMAND LINE', () => {
    for (const file of ['src/ops/torbox-resolver-cli.ts', 'src/ops/torbox-resolver-service.ts',
      'src/ops/torbox-fixture-cli.ts']) {
      const text = repoFile(file);
      assert(!/--token[= ]["$]?[A-Za-z0-9]/.test(text), `${file} passes a token on the command line`);
      assert(!/--api-key/.test(text), `${file} accepts an inline API key`);
    }
    assert(repoFile('src/ops/torbox-resolver-cli.ts').includes('findSecretShapes'),
      'the CLI checks its own argv before doing anything');
  });

  // -------------------------------------------------------------------------------------------------------
  // What this adapter must never become
  // -------------------------------------------------------------------------------------------------------

  await test('THE ADAPTER IS GET-ONLY AND TOUCHES NO MUTATING TORBOX ENDPOINT', () => {
    // COMMENTS ARE STRIPPED FIRST, AND THAT IS NOT A WEAKENING. An earlier version of this test failed on
    // the core module's own header, which QUOTES Phase 41 saying these endpoints "can expose CDN/permalink
    // URLs" — the exact sentence that should be there. What must be absent is a path the code CONSTRUCTS.
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    const service = stripComments(repoFile('src/ops/torbox-resolver-service.ts'));
    const core = stripComments(repoFile('src/core/adapters/torbox-resolver.ts'));
    for (const [name, text] of [['the service', service], ['the core', core]] as const) {
      assert(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(text.replace(/method: 'GET'/g, '')),
        `${name} issues a mutating request to the provider`);
      // PATHS, NOT PROSE. An earlier version of this test grepped for the word "permalink" and failed on a
      // COMMENT saying the adapter never requests one -- which is exactly the sentence that should be there.
      // What must be absent is a URL PATH, so that is what is matched.
      for (const forbidden of ['/createtorrent', '/controltorrent', '/deletetorrent', '/createdownload',
        '/requestpermalink', '/permalink', 'usenet/create', 'webdl/create', '/user/data', '/torrents/create']) {
        assert(!text.toLowerCase().includes(forbidden),
          `${name} names a mutating or out-of-scope endpoint path: ${forbidden}`);
      }
    }
    // Only the three requestdl paths, and nothing else, are ever built.
    const paths = Object.values(TORBOX_REQUESTDL).map((entry) => entry.path);
    assert(paths.length === 3 && paths.every((path) => path.endsWith('/requestdl')),
      'the adapter reaches endpoints other than requestdl');
  });

  await test('THE PHASE 33 SMOKE CLIENT IS NOT UNGATED BY THIS PHASE', () => {
    // The tempting move was to widen TORBOX_REAL_CLIENT_ALLOWED_OPERATIONS so one gate covered everything.
    // That would relax a contract several hundred existing assertions depend on, to give the smoke client a
    // capability it has no use for. The resolver is its own surface instead, and this pins the boundary --
    // if a later change quietly ungates the smoke client, this fails.
    const gate = repoFile('src/core/adapters/torbox-real-client-gate.ts');
    const allowed = /TORBOX_REAL_CLIENT_ALLOWED_OPERATIONS = \[([\s\S]*?)\]/.exec(gate)?.[1] ?? '';
    assert(allowed !== '', 'the allowed-operation list must still exist');
    assert(!allowed.includes('request-download-link'),
      'request-download-link has been added to the smoke client allow list; this phase does not do that');
    const futureGated = /TORBOX_REAL_CLIENT_FUTURE_GATED_OPERATIONS = \[([\s\S]*?)\]/.exec(gate)?.[1] ?? '';
    assert(futureGated.includes('request-download-link'),
      'request-download-link must remain future-gated for the smoke client');
    // And the smoke transport still reaches only the cache/status surface.
    const transport = repoFile('src/ops/torbox-live-transport.ts');
    assert(!transport.includes('requestdl'), 'the Phase 42 smoke transport must not learn requestdl');
  });

  await test('THE DOCUMENTATION RECORDS THE OFFICIAL CONTRACT AND ITS SOURCES', () => {
    const doc = repoFile('docs/PHASE_50_TORBOX_RESOLVER.md');
    for (const needle of ['/v1/api/torrents/requestdl', '/v1/api/webdl/requestdl',
      '/v1/api/usenet/requestdl', 'torrent_id', 'web_id', 'usenet_id', 'file_id']) {
      assert(doc.includes(needle), `the phase document does not record ${needle}`);
    }
    assert(/github\.com\/TorBox-App/.test(doc), 'and it cites the official SDK it was taken from');
    // PHASE 41 FUTURE-GATED THIS FAMILY. The document that unblocks it must say so, or the two disagree.
    assert(/PHASE_41/.test(doc), 'and it names the phase that future-gated these endpoints');
  });

  // -------------------------------------------------------------------------------------------------------
  // The mount gate's own shape
  // -------------------------------------------------------------------------------------------------------

  await test('THE MOUNT GATE PROVES THE RESOLVER IS IN THE READ PATH, NOT MERELY THAT READS SUCCEEDED', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    // A gate that only checked bytes would pass against a daemon that never called the resolver -- if the
    // bytes came from anywhere else. The resolution COUNT is what makes the claim falsifiable.
    assert(/control\/counters/.test(gate), 'the gate must read the fixture own resolution counter');
    assert(/the resolver was not in the path/.test(gate),
      'and must fail with that reason when nothing resolved');
    assert(/control\/expire-links/.test(gate), 'and it must expire every link');
    assert(/reads did not recover after expiry/.test(gate), 'and require the reads to recover');
    assert(/AFTER_REFRESH" -gt "\$BEFORE_REFRESH/.test(gate),
      'and require the recovery to have cost a real re-resolution');
  });

  await test('THE MOUNT GATE READS BACKWARD AND PAST 90%, AND REQUIRES THE WINDOWS TO DIFFER', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(/0\.91/.test(gate), 'a tail read past 90% of the object');
    assert(/backward/.test(gate), 'and a backward read');
    // Without this, a mount serving one buffer for every offset would satisfy both.
    assert(/distinct-windows/.test(gate), 'and the two windows must be required to differ');
  });

  await test('THE MOUNT GATE USES TWO DIFFERENT SECRETS AND PROVES THEY DIFFER', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(/torbox-credential/.test(gate) && /gate-secret/.test(gate), 'two secret files');
    assert(/the two secrets are identical/.test(gate),
      'and the gate must fail if they are the same, which would defeat the split it exists to prove');
    assert(/chmod 600/.test(gate), 'both at mode 0600');
  });

  await test('THE MOUNT GATE KEEPS THE RESOLVER LOOPBACK-ONLY', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(/--network "container:\$MOUNT_CONTAINER"/.test(gate),
      'the resolver must join the daemon network namespace rather than being published');
    assert(!/-p .*\$\{RESOLVER_PORT\}/.test(gate), 'and its port must never be published to the host');
  });

  await test('THE MOUNT GATE SEARCHES FOR BOTH SECRETS IN FILES AND IN CONTAINER LOGS', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(/CRED_HITS/.test(gate) && /GATE_HITS/.test(gate), 'both secrets are searched for');
    assert(/docker logs "\$container"/.test(gate),
      'and container logs are searched too, because that is where a URL is most likely to surface');
    assert(/the resolver logged a stable reference/.test(gate), 'and a leaked reference fails the gate');
  });

  await test('THE MOUNT GATE IS OFFLINE AND SAYS SO, AND IS NOT THE REAL RUN', () => {
    const gate = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(/CLOSES NOTHING ABOUT ANY REAL PROVIDER/.test(gate),
      'the gate must refuse to be read as a real-provider pass');
    assert(/SKIPS with 77/.test(gate), 'and must point at the real run');
    assert(/GATE_SKIP_STATUS=77/.test(gate), 'and skip rather than pass where it cannot run');
    // THE FIXTURE EXEMPTIONS ARE HERE AND MUST BE NOWHERE ELSE.
    assert(/--fixture-plaintext-link/.test(gate), 'the plaintext exemption is opt-in, here');
    const realGate = repoFile('deploy/projection-real-provider-gate.sh');
    assert(!/fixture-plaintext-link/.test(realGate),
      'and the REAL gate must never set it');
  });

  // -------------------------------------------------------------------------------------------------------
  // The REAL gate: the topology, the narrow authority, and the fixture switches it must never set
  // -------------------------------------------------------------------------------------------------------

  await test('THE REAL GATE PUTS THE RESOLVER IN THE DAEMON NETWORK NAMESPACE, NOT ON A HOST PORT', () => {
    // THE DEFECT THIS CLOSES. The documented procedure started the resolver on the Unraid HOST at
    // 127.0.0.1:8140 and then started projectiond in a bridge network -- where 127.0.0.1 is the CONTAINER.
    // The daemon would have dialled its own loopback and found nothing. This test fails against that
    // arrangement and against any attempt to "fix" it by publishing the resolver to a host port.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    assert(/--network \"container:\$MOUNT_CONTAINER\"/.test(gate),
      'the resolver must join the daemon network namespace');
    // NO `-p ...RESOLVER_PORT` ANYWHERE. Publishing it would make the resolver reachable from the network,
    // and anything that can reach it can mint CDN links for the operator's account.
    assert(!gate.split('\n').some((line) => /^\s*-p\s/.test(line) && line.includes('RESOLVER_PORT')),
      'the resolver port must never be published to the host: a reachable resolver is a credential oracle');
    // And the daemon must be confirmed running first, or the join fails with a message about a consequence.
    assert(gate.indexOf('daemon_up') < gate.indexOf('--network \"container:'),
      'the daemon must be confirmed running before anything joins its namespace');
    // The arrangement is asserted at run time, not merely configured.
    assert(/it must be loopback-only/.test(gate),
      'the gate must PROVE the resolver is unreachable from the gate network');
  });

  await test('THE REAL GATE USES THE NARROW LOOPBACK AUTHORITY AND NEVER THE BROAD PRIVATE-ADDRESS SWITCH', () => {
    // THE SECOND DEFECT. Reaching a loopback resolver used to require allowPrivateAddresses -- a switch its
    // own documentation calls test-only, which also authorises every RFC1918 destination and would widen
    // CDN egress across the operator's whole private network.
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    assert(/loopbackResolver: true/.test(gate), 'the narrow authority is what a real run sets');
    assert(/allowPrivateAddresses: false/.test(gate), 'and the broad one stays off');
    assert(/allowInsecureHttp: false/.test(gate), 'as does the plaintext switch');
  });

  await test('THE REAL GATE NEVER PASSES A FIXTURE FLAG, AND THE OFFLINE ONE ALWAYS DOES', () => {
    // COMMENTS STRIPPED FIRST: the real gate's own comment explains that it passes no fixture flag, and
    // that sentence is exactly the one that should be there. What must be absent is an ARGUMENT.
    const strip = (text: string): string =>
      text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    const real = strip(repoFile('deploy/projection-torbox-real-gate.sh'));
    const offline = repoFile('deploy/projection-torbox-mount-gate.sh');
    assert(!/--fixture-mode/.test(real), 'the real gate must never enter fixture mode');
    assert(!/--fixture-plaintext-link/.test(real), 'nor relax the plaintext rule');
    assert(!/--api-origin-file/.test(real),
      'nor override the API origin: a real resolver is pinned to the official TorBox origin');
    assert(/--fixture-mode --fixture-plaintext-link/.test(offline),
      'and the offline gate must ask for both together');
  });

  await test('THE REAL GATE SKIPS WITH 77 BEFORE ANY BUILD, DATABASE OR PACKET', () => {
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    const skip = gate.indexOf('exit "$GATE_SKIP_STATUS"');
    assert(skip !== -1, 'the gate skips');
    for (const [what, needle] of [
      ['an image build', 'docker build'],
      ['a database', 'docker compose -f "$COMPOSE_FILE" up'],
      ['a network', 'docker network create'],
    ] as const) {
      assert(gate.indexOf(needle) > skip, `the skip must come before ${what}`);
    }
    assert(/NOTHING WAS CONTACTED/.test(gate), 'and say so');
    assert(/It is not a pass and must not be reported as one/.test(gate),
      'and refuse to be read as a pass');
  });

  await test('THE REAL GATE GIVES THE DAEMON THE GATE SECRET AND NEVER THE TORBOX KEY', () => {
    const gate = repoFile('deploy/projection-torbox-real-gate.sh');
    // A SEPARATE DIRECTORY, so the key is not merely unreferenced in the daemon container -- it is absent.
    assert(/daemon-inputs/.test(gate), 'the daemon gets its own inputs directory');
    assert(/install -m 600 "\$WORK\/inputs\/gate-secret" "\$WORK\/daemon-inputs\/gate-secret"/.test(gate),
      'containing only the gate secret');
    assert(/the TorBox credential is present inside the daemon container/.test(gate),
      'and the gate must FAIL if the key ever appears there');
    assert(/they must differ/.test(gate),
      'and the two secrets must be required to differ');
  });

  await test('this suite runs in the aggregate', () => {
    assert(AGGREGATE_SUITE_COMMAND.includes('tsx test/torbox-resolver.ts'),
      'a suite nobody runs is a suite that stops being true');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const [name, error] of failures) console.error(`FAILED ${name}\n  ${String(error)}`);
    process.exit(1);
  }
}

void main();
