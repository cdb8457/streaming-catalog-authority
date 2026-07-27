import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JELLYFIN_LOCAL_NAME_SUFFIXES,
  JELLYFIN_METADATA_HOSTS,
  JELLYFIN_URL_MAX_LENGTH,
  JELLYFIN_URL_REJECTION_MESSAGES,
  checkJellyfinBaseUrl,
  classifyHost,
} from '../src/core/adapters/jellyfin/url-policy.js';
import {
  JELLYFIN_ALLOW_COLLECTION_WRITES_ENV,
  JELLYFIN_API_KEY_MAX_LENGTH,
  JELLYFIN_ENABLE_NETWORK_ENV,
  JELLYFIN_TIMEOUT_MAX_MS,
  JELLYFIN_TIMEOUT_MIN_MS,
  describeJellyfinControlConfig,
  isJellyfinCollectionWriteEnabled,
  isJellyfinControlNetworkEnabled,
  isUsableApiKey,
  loadJellyfinControlConfig,
} from '../src/ops/jellyfin-control-config.js';
import {
  JELLYFIN_DISCOVERY_MAX_RESPONSE_BYTES,
  JellyfinDiscoveryClient,
  JellyfinDiscoveryError,
  jellyfinIdDigest,
  stripManagedMarker,
} from '../src/core/adapters/jellyfin/discovery.js';
import {
  JellyfinTransportRefusedError,
  guardedJellyfinFetch,
} from '../src/core/adapters/jellyfin/guarded-fetch.js';
import type { FetchLike, HttpRequestInit, HttpResponseLike } from '../src/core/adapters/jellyfin/transport.js';
import {
  JELLYFIN_DISCOVERY_ROUTE,
  JELLYFIN_STATUS_ROUTE,
  jellyfinDiscoveryResponse,
  jellyfinStatusResponse,
  resolveJellyfinTransport,
} from '../src/ops/operator-ui-jellyfin-endpoint.js';
import {
  createOperatorUiServiceServer,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import {
  OPERATOR_UI_LOCAL_AUTH_HEADER,
  loadOperatorUiLocalAuthRuntime,
} from '../src/ops/operator-ui-local-auth-runtime.js';

// Phase 266 — the authenticated Jellyfin connection and the read-only discovery surface.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - NETWORKING IS OFF BY DEFAULT, and "off" means no transport exists in the process — not that a branch
//     was taken. Proved by asserting the resolver returns nothing and that the endpoint answers DISABLED
//     while holding a transport that would record any call.
//   - THE API KEY MUST COME FROM A FILE. An inline `JELLYFIN_API_KEY` is REFUSED, not merely preferred.
//   - THE ADDRESS POLICY IS SSRF-SHAPED AND CLOSED. Metadata addresses, IPv4-mapped IPv6, decimal and octal
//     spellings, credentials in the URL, public names, redirects: each refused, by name of the rule.
//   - EVERY RESPONSE IS REDACTED. The suite scans every body produced in this file for the api key, the base
//     URL, the host, the port, the key file's path, the operator token and any Jellyfin id.
//   - DISCOVERY LISTS NO MEDIA ITEM, EVER, and names no collection this product did not create.
//   - IT IS BOUNDED on every axis: pages, rows, response bytes, and time.
//   - IT WRITES NOTHING, and the routes fail closed on a missing token and on any method but GET.
//
// It is entirely offline: the "real server" leg is a fake Jellyfin on 127.0.0.1 that this file starts.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');

const WORK = mkdtempSync(join(tmpdir(), 'ca-jellyfin-control-'));
const API_KEY = 'phase266-api-key-must-never-be-disclosed-abcdef';
const KEY_FILE = join(WORK, 'jellyfin_api_key');
writeFileSync(KEY_FILE, `${API_KEY}\n`, 'utf8');
const TOKEN = 'phase266-operator-token-abcdefghij';
const TOKEN_FILE = join(WORK, 'operator_token');
writeFileSync(TOKEN_FILE, TOKEN, 'utf8');

/** Every response body this suite produced, scanned once at the end for anything that must never appear. */
const emitted: string[] = [];
function capture<T>(body: T): T {
  emitted.push(JSON.stringify(body));
  return body;
}

function envWith(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

/** The refusal code a configuration produced, or `null` when it loaded. Keeps the assertions one-liners. */
function problemOf(result: ReturnType<typeof loadJellyfinControlConfig>): string | null {
  return result.ok ? null : result.problem;
}

const enabledEnv = (baseUrl: string): NodeJS.ProcessEnv => envWith({
  [JELLYFIN_ENABLE_NETWORK_ENV]: 'true',
  JELLYFIN_BASE_URL: baseUrl,
  JELLYFIN_API_KEY_FILE: KEY_FILE,
});

// --- a fake Jellyfin server, on loopback, that records exactly what it was asked ---------------------------

interface FakeJellyfinOptions {
  readonly items?: ReadonlyArray<{ Id: string; Name: string; Type: string }>;
  readonly version?: string;
  readonly status?: number;
  readonly redirectTo?: string;
  readonly body?: string;
  readonly delayMs?: number;
  readonly pageSize?: number;
}

interface FakeJellyfin {
  readonly server: Server;
  readonly port: number;
  readonly baseUrl: string;
  readonly seen: Array<{ url: string; auth: string | undefined; method: string }>;
  close(): Promise<void>;
}

async function startFakeJellyfin(options: FakeJellyfinOptions = {}): Promise<FakeJellyfin> {
  const seen: Array<{ url: string; auth: string | undefined; method: string }> = [];
  const items = options.items ?? [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const token = req.headers['x-emby-token'];
    seen.push({ url: req.url ?? '', auth: Array.isArray(token) ? token[0] : token, method: req.method ?? '' });
    const send = (): void => {
      if (options.redirectTo !== undefined) {
        res.statusCode = 302;
        res.setHeader('Location', options.redirectTo);
        res.end();
        return;
      }
      if (options.status !== undefined && options.status !== 200) {
        res.statusCode = options.status;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"error":"refused"}');
        return;
      }
      if (options.body !== undefined) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(options.body);
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname.endsWith('/System/Info')) {
        // ServerName and Id are DELIBERATELY present here: the suite proves they never reach a response.
        res.end(JSON.stringify({ ServerName: 'clint-home-server', Id: 'server-id-should-never-appear', Version: options.version ?? '10.9.11' }));
        return;
      }
      const wanted = url.searchParams.get('IncludeItemTypes') ?? '';
      const start = Number(url.searchParams.get('StartIndex') ?? '0');
      const limit = Number(url.searchParams.get('Limit') ?? '200');
      const matching = items.filter((item) => wanted.split(',').includes(item.Type));
      res.end(JSON.stringify({ Items: matching.slice(start, start + limit), TotalRecordCount: matching.length }));
    };
    if (options.delayMs !== undefined) setTimeout(send, options.delayMs);
    else send();
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** A transport that answers from a script and records every call. Used where a real socket is not the point. */
function scriptedFetch(handler: (url: string, init?: HttpRequestInit) => Partial<HttpResponseLike> & { throws?: unknown }): {
  fetch: FetchLike;
  calls: Array<{ url: string; init?: HttpRequestInit }>;
} {
  const calls: Array<{ url: string; init?: HttpRequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    const answer = handler(url, init);
    if (answer.throws !== undefined) throw answer.throws;
    return {
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      json: answer.json ?? (async () => ({})),
      text: answer.text ?? (async () => '{}'),
    };
  };
  return { fetch: fetchImpl, calls };
}

const jsonResponse = (value: unknown): Partial<HttpResponseLike> => ({
  ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value,
});

// --- the HTTP client for the operator UI legs ---------------------------------------------------------------

interface HttpResult { status: number; body: any; headers: Record<string, string | string[] | undefined> }

function call(server: Server, path: string, opts: { token?: string; method?: string } = {}): Promise<HttpResult> {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) headers[OPERATOR_UI_LOCAL_AUTH_HEADER] = opts.token;
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += String(chunk); });
      res.on('end', () => {
        let body: unknown = raw;
        try { body = JSON.parse(raw); } catch { /* a plain-text refusal is a valid answer here */ }
        emitted.push(raw);
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  console.log('Running Phase 266 Jellyfin control plane suite:\n');

  // -------------------------------------------------------------------------------------------------------
  // The address policy.
  // -------------------------------------------------------------------------------------------------------

  await test('a private address is accepted, and normalised to an origin plus a bounded path prefix', () => {
    for (const [input, expected, hostClass] of [
      ['http://127.0.0.1:8096', 'http://127.0.0.1:8096', 'loopback'],
      ['http://127.0.0.1:8096/', 'http://127.0.0.1:8096', 'loopback'],
      ['http://192.168.1.50:8096/jellyfin/', 'http://192.168.1.50:8096/jellyfin', 'private-ipv4'],
      ['https://10.1.2.3', 'https://10.1.2.3', 'private-ipv4'],
      ['http://172.16.0.9:8096', 'http://172.16.0.9:8096', 'private-ipv4'],
      ['http://100.64.0.1', 'http://100.64.0.1', 'cgnat'],
      ['http://jellyfin:8096', 'http://jellyfin:8096', 'local-name'],
      ['http://media.local', 'http://media.local', 'local-name'],
      ['http://[fd00::1]:8096', 'http://[fd00::1]:8096', 'unique-local-ipv6'],
      ['http://[::1]:8096', 'http://[::1]:8096', 'loopback'],
    ] as const) {
      const verdict = checkJellyfinBaseUrl(input);
      assert(verdict.ok, `${input} should be accepted, was rejected as ${verdict.rejection}`);
      assertEq(verdict.baseUrl, expected, `${input} normalised`);
      assertEq(verdict.hostClass, hostClass, `${input} host class`);
      assert(!verdict.baseUrl!.endsWith('/'), 'a base url never ends in a slash');
    }
    // A dot segment is resolved by the URL parser before the policy sees it, so the result is the resolved
    // path rather than a rejection. Asserted rather than assumed, because the ENCODED form below relies on
    // knowing which of the two is happening.
    assertEq(checkJellyfinBaseUrl('http://127.0.0.1:8096/a/../b').baseUrl, 'http://127.0.0.1:8096/b',
      'a dot segment is resolved, not rejected');
    // Every documented local suffix is actually honoured, so the message and the code cannot drift.
    for (const suffix of JELLYFIN_LOCAL_NAME_SUFFIXES) {
      assertEq(classifyHost(`server${suffix}`), 'local-name', `${suffix} is a local name`);
    }
  });

  await test('a public, credentialed, redirect-shaped or metadata address is refused by the rule it broke', () => {
    for (const [input, rejection] of [
      ['', 'EMPTY'],
      ['   ', 'EMPTY'],
      [`http://127.0.0.1/${'a'.repeat(JELLYFIN_URL_MAX_LENGTH)}`, 'TOO_LONG'],
      ['not a url', 'NOT_A_URL'],
      ['file:///etc/passwd', 'SCHEME'],
      ['gopher://127.0.0.1:70', 'SCHEME'],
      ['http://user:pass@127.0.0.1:8096', 'CREDENTIALS_IN_URL'],
      ['http://admin@192.168.0.5', 'CREDENTIALS_IN_URL'],
      ['http://127.0.0.1:8096/?a=b', 'QUERY_OR_FRAGMENT'],
      ['http://127.0.0.1:8096/#x', 'QUERY_OR_FRAGMENT'],
      // `/a/../b` is NOT here on purpose: `new URL` resolves it to `/b` before this policy ever sees it, so
      // asserting a rejection would be asserting something that cannot happen. The ENCODED form is what a
      // caller reaches for once the plain one stops working, and that one is refused below.
      ['http://127.0.0.1:8096/a%2e%2e/b', 'PATH'],
      ['http://127.0.0.1:8096/a%2f%2fb', 'PATH'],
      ['http://jellyfin.example.com', 'HOST_NOT_PRIVATE'],
      ['http://169.254.169.254/latest/meta-data', 'HOST_NOT_PRIVATE'],
      ['http://[::ffff:169.254.169.254]', 'HOST_NOT_PRIVATE'],
      ['http://[::ffff:8.8.8.8]', 'HOST_NOT_PRIVATE'],
      ['http://134744072', 'HOST_NOT_PRIVATE'],
      ['http://010.0.0.1', 'HOST_NOT_PRIVATE'],
      ['http://2852039166', 'HOST_NOT_PRIVATE'],
      ['http://8.8.8.8', 'HOST_NOT_PRIVATE'],
      ['http://metadata.google.internal.evil.com', 'HOST_NOT_PRIVATE'],
    ] as const) {
      const verdict = checkJellyfinBaseUrl(input);
      assert(!verdict.ok, `${input} should have been refused`);
      assertEq(verdict.rejection, rejection as never, `${input} rejection`);
      assertEq(verdict.baseUrl, undefined, `${input} yielded no base url`);
    }
  });

  await test('the link-local block is admitted, but the metadata endpoints inside it are refused by name', () => {
    // The rest of 169.254/16 is a legitimate LAN address an operator may genuinely be using.
    assertEq(classifyHost('169.254.1.1'), 'link-local', 'link-local classification exists');
    assert(checkJellyfinBaseUrl('http://169.254.1.1:8096').ok, 'a link-local address is a legitimate LAN address');
    // The metadata endpoints are the one denylist in an otherwise-allowlist policy. Nobody runs a media
    // server on one, and they are the single most-used SSRF target.
    for (const host of JELLYFIN_METADATA_HOSTS) {
      assertEq(classifyHost(host), null, `${host} is refused by name`);
      const bracketed = host.includes(':') ? `[${host}]` : host;
      const verdict = checkJellyfinBaseUrl(`http://${bracketed}/latest/meta-data`);
      assert(!verdict.ok, `http://${bracketed} is refused`);
      assertEq(verdict.rejection, 'HOST_NOT_PRIVATE', `${host} rejection`);
    }
    // ...including through both IPv4-mapped IPv6 spellings, unwrapped and re-checked. The HEX form is the
    // one that actually arrives, because URL re-serialises the dotted one into it.
    assertEq(classifyHost('::ffff:169.254.169.254'), null, 'the dotted mapped spelling is refused');
    assertEq(classifyHost('::ffff:a9fe:a9fe'), null, 'and so is the hex mapped spelling URL produces');
    assertEq(checkJellyfinBaseUrl('http://[::ffff:169.254.169.254]').rejection, 'HOST_NOT_PRIVATE',
      'through the URL parser as well');
    // ...while a legitimate private address written the same way still works.
    assertEq(classifyHost('::ffff:c0a8:0101'), 'private-ipv4', 'a mapped 192.168.1.1 is still private');
  });

  await test('an alternate IPv4 spelling is normalised by the parser, then judged on the address it denotes', () => {
    // `new URL` resolves decimal, octal and hexadecimal forms to a dotted quad before this policy sees them,
    // so the question is never "is 2130706433 private" but "is what it denotes private". Both directions are
    // asserted, so a parser that stopped normalising would be caught here rather than in production: the
    // policy's own parser accepts ONLY the normal form and refuses every other spelling outright.
    assertEq(checkJellyfinBaseUrl('http://2130706433').hostClass, 'loopback', '2130706433 IS 127.0.0.1');
    assertEq(checkJellyfinBaseUrl('http://0x7f.0.0.1').hostClass, 'loopback', 'and so is 0x7f.0.0.1');
    assertEq(checkJellyfinBaseUrl('http://2852039166').rejection, 'HOST_NOT_PRIVATE',
      'the decimal spelling of the metadata address is still refused');
    assertEq(checkJellyfinBaseUrl('http://134744072').rejection, 'HOST_NOT_PRIVATE',
      'and the decimal spelling of a public address is still refused');
    assertEq(classifyHost('0x7f.0.0.1'), null, 'the policy itself refuses an un-normalised spelling');
    assertEq(classifyHost('010.0.0.1'), null, 'including an octal one');
    assertEq(classifyHost('2130706433'), null, 'including a decimal one');
  });

  await test('the rejection messages name the rule and never the value', () => {
    for (const [rejection, message] of Object.entries(JELLYFIN_URL_REJECTION_MESSAGES)) {
      assert(message.length > 0, `${rejection} has a message`);
      assert(!/\$\{/.test(message), `${rejection} interpolates nothing`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // The configuration.
  // -------------------------------------------------------------------------------------------------------

  await test('networking and writes are off unless the value is exactly "true"', () => {
    for (const value of [undefined, '', '0', 'false', 'TRUE', 'True', '1', 'yes', ' true']) {
      assertEq(isJellyfinControlNetworkEnabled(envWith({ [JELLYFIN_ENABLE_NETWORK_ENV]: value })), false,
        `network stays off for ${JSON.stringify(value)}`);
      assertEq(isJellyfinCollectionWriteEnabled(envWith({ [JELLYFIN_ALLOW_COLLECTION_WRITES_ENV]: value })), false,
        `writes stay off for ${JSON.stringify(value)}`);
    }
    assertEq(isJellyfinControlNetworkEnabled(envWith({ [JELLYFIN_ENABLE_NETWORK_ENV]: 'true' })), true, 'exact true turns networking on');
    assertEq(isJellyfinCollectionWriteEnabled(envWith({ [JELLYFIN_ALLOW_COLLECTION_WRITES_ENV]: 'true' })), true, 'exact true turns writes on');
    // And the two are INDEPENDENT: turning networking on does not turn writing on.
    assertEq(isJellyfinCollectionWriteEnabled(envWith({ [JELLYFIN_ENABLE_NETWORK_ENV]: 'true' })), false,
      'networking does not imply writing');
  });

  await test('the api key must come from a FILE, and an inline key is refused rather than accepted', () => {
    const inline = loadJellyfinControlConfig(envWith({
      [JELLYFIN_ENABLE_NETWORK_ENV]: 'true',
      JELLYFIN_BASE_URL: 'http://127.0.0.1:8096',
      JELLYFIN_API_KEY: API_KEY,
    }));
    assert(!inline.ok, 'an inline key is refused');
    assertEq(inline.problem, 'API_KEY_MUST_BE_A_FILE', 'and it says exactly why');
    assert(!inline.message.includes(API_KEY), 'the refusal does not echo the key');

    // Setting BOTH is also refused: that is how a key ends up in an environment nobody meant it to be in.
    const both = loadJellyfinControlConfig(envWith({
      [JELLYFIN_ENABLE_NETWORK_ENV]: 'true',
      JELLYFIN_BASE_URL: 'http://127.0.0.1:8096',
      JELLYFIN_API_KEY: API_KEY,
      JELLYFIN_API_KEY_FILE: KEY_FILE,
    }));
    assertEq(problemOf(both), 'API_KEY_MUST_BE_A_FILE', 'setting both is refused too');
  });

  await test('a configured installation loads, with the trailing newline stripped from the key file', () => {
    const result = loadJellyfinControlConfig(enabledEnv('http://127.0.0.1:8096/'));
    assert(result.ok, 'a complete configuration loads');
    assertEq(result.config.apiKey, API_KEY, 'the key file\'s trailing newline is stripped');
    assertEq(result.config.baseUrl, 'http://127.0.0.1:8096', 'the base url is the normalised one');
    assertEq(result.config.origin, 'http://127.0.0.1:8096', 'the origin is recorded for the transport guard');
    assertEq(result.config.writesEnabled, false, 'writes are off unless separately enabled');
  });

  await test('every configuration refusal is named, and the ORDER is the order somebody fixes them in', () => {
    assertEq(problemOf(loadJellyfinControlConfig(envWith({}))), 'NETWORK_DISABLED', 'the switch comes first');
    assertEq(problemOf(loadJellyfinControlConfig(envWith({ [JELLYFIN_ENABLE_NETWORK_ENV]: 'true' }))), 'UNCONFIGURED',
      'then whether anything is configured at all');
    assertEq(problemOf(loadJellyfinControlConfig(envWith({
      [JELLYFIN_ENABLE_NETWORK_ENV]: 'true', JELLYFIN_BASE_URL: 'http://evil.example.com', JELLYFIN_API_KEY_FILE: KEY_FILE,
    }))), 'URL_HOST_NOT_PRIVATE', 'then the address');
    assertEq(problemOf(loadJellyfinControlConfig(envWith({
      [JELLYFIN_ENABLE_NETWORK_ENV]: 'true', JELLYFIN_BASE_URL: 'http://127.0.0.1:8096',
      JELLYFIN_API_KEY_FILE: join(WORK, 'no-such-file'),
    }))), 'API_KEY_UNREADABLE', 'then whether the key file can be read');
    const timeout = loadJellyfinControlConfig({ ...enabledEnv('http://127.0.0.1:8096'), JELLYFIN_TIMEOUT_MS: '1' });
    assertEq(problemOf(timeout), 'TIMEOUT', `a timeout below ${JELLYFIN_TIMEOUT_MIN_MS} is refused`);
    const huge = loadJellyfinControlConfig({ ...enabledEnv('http://127.0.0.1:8096'), JELLYFIN_TIMEOUT_MS: String(JELLYFIN_TIMEOUT_MAX_MS + 1) });
    assertEq(problemOf(huge), 'TIMEOUT', 'and so is one above the maximum');
    for (const bad of ['1e4', '-5', '0x10', ' 900', 'abc']) {
      assertEq(problemOf(loadJellyfinControlConfig({ ...enabledEnv('http://127.0.0.1:8096'), JELLYFIN_TIMEOUT_MS: bad })),
        'TIMEOUT', `${bad} is not a timeout`);
    }
  });

  await test('a key with a control character, a newline or padding is refused before it can reach a header', () => {
    assert(isUsableApiKey('abc123'), 'an ordinary key is usable');
    assert(!isUsableApiKey(''), 'an empty key is not');
    assert(!isUsableApiKey(' abc'), 'a padded key is not');
    assert(!isUsableApiKey('abc '), 'a trailing-space key is not');
    assert(!isUsableApiKey('a'.repeat(JELLYFIN_API_KEY_MAX_LENGTH + 1)), 'an over-long key is not');
    for (const injected of ['a\rb', 'a\nb', 'a\u0000b', 'a\u007fb']) {
      assert(!isUsableApiKey(injected), `${JSON.stringify(injected)} cannot reach a header`);
    }
    // ...and the loader agrees, on a real file.
    const badFile = join(WORK, 'bad_key');
    writeFileSync(badFile, 'first\nsecond\n', 'utf8');
    const result = loadJellyfinControlConfig(envWith({
      [JELLYFIN_ENABLE_NETWORK_ENV]: 'true', JELLYFIN_BASE_URL: 'http://127.0.0.1:8096', JELLYFIN_API_KEY_FILE: badFile,
    }));
    assertEq(problemOf(result), 'API_KEY_SHAPE', 'a two-line key file is refused');
  });

  await test('the diagnostics summary carries a class, never an address, a key or a path', () => {
    const summary = capture(describeJellyfinControlConfig(enabledEnv('http://192.168.7.7:8096/jellyfin')));
    assertEq(summary.configured, true, 'it says it is configured');
    assertEq(summary.hostClass, 'private-ipv4', 'it says how the address was judged');
    assertEq(summary.apiKeySource, 'file', 'it says where the key came from');
    const text = JSON.stringify(summary);
    for (const forbidden of [API_KEY, '192.168.7.7', '8096', KEY_FILE, 'jellyfin/']) {
      assert(!text.includes(forbidden), `the summary must not contain ${forbidden}`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // The guarded transport.
  // -------------------------------------------------------------------------------------------------------

  await test('the guarded transport refuses any request that would leave the configured origin', async () => {
    const scripted = scriptedFetch(() => jsonResponse({}));
    const guarded = guardedJellyfinFetch('http://127.0.0.1:8096', scripted.fetch);
    await guarded('http://127.0.0.1:8096/System/Info');
    assertEq(scripted.calls.length, 1, 'an on-origin request passes through');
    assertEq(scripted.calls[0]!.init!.redirect, 'error', 'and it always refuses redirects');

    for (const off of [
      'http://127.0.0.1:8097/System/Info',   // a different port is a different origin
      'https://127.0.0.1:8096/System/Info',  // a different scheme is a different origin
      'http://127.0.0.1.evil.example/x',     // the classic prefix-without-separator confusion
      'http://evil.example/x',
      'http://169.254.169.254/latest/meta-data',
      'not-a-url',
    ]) {
      let refused = false;
      try { await guarded(off); } catch (err) { refused = err instanceof JellyfinTransportRefusedError; }
      assert(refused, `${off} must be refused by the transport itself`);
    }
    assertEq(scripted.calls.length, 1, 'and not one of them reached the underlying transport');
  });

  // -------------------------------------------------------------------------------------------------------
  // The discovery client, against a real fake server.
  // -------------------------------------------------------------------------------------------------------

  await test('discovery reads a real server: counts, version, and the collections this product made', async () => {
    const fake = await startFakeJellyfin({
      items: [
        { Id: 'lib-movies', Name: 'Movies', Type: 'CollectionFolder' },
        { Id: 'lib-shows', Name: 'Shows', Type: 'CollectionFolder' },
        { Id: 'box-1', Name: 'Weekend picks [cat:11111111-2222-3333-4444-555555555555]', Type: 'BoxSet' },
        { Id: 'box-2', Name: 'Somebody else private collection', Type: 'BoxSet' },
      ],
      version: '10.9.11',
    });
    try {
      const config = loadJellyfinControlConfig(enabledEnv(fake.baseUrl));
      assert(config.ok, 'the fake server address passes the policy');
      const client = new JellyfinDiscoveryClient({
        baseUrl: config.config.baseUrl,
        origin: config.config.origin,
        apiKey: config.config.apiKey,
        fetch: guardedJellyfinFetch(config.config.origin, globalThis.fetch as unknown as FetchLike),
        timeoutMs: 4000,
      });
      const report = capture(await client.discover());
      assertEq(report.libraries, 2, 'both library folders are counted');
      assertEq(report.collections, 2, 'both collections are counted');
      assertEq(report.managed.length, 1, 'exactly one carries this product\'s marker');
      assertEq(report.managed[0]!.name, 'Weekend picks', 'and the marker is stripped from its name');
      assertEq(report.managed[0]!.marked, true, 'and it is reported as marked');
      assertEq(report.version, '10.9.11', 'the product version is reported');
      assertEq(report.truncated, false, 'nothing was truncated');

      // The key travelled in the HEADER and never in a URL.
      assert(fake.seen.length >= 3, 'the client made the three reads it says it makes');
      for (const seen of fake.seen) {
        assertEq(seen.auth, API_KEY, 'every request carried the key as X-Emby-Token');
        assertEq(seen.method, 'GET', 'every request was a GET');
        assert(!seen.url.includes(API_KEY), 'no request put the key in the URL');
      }

      const text = JSON.stringify(report);
      for (const forbidden of ['clint-home-server', 'server-id-should-never-appear', 'lib-movies', 'box-1', 'box-2',
        'Somebody else private collection', API_KEY, fake.baseUrl, 'cat:']) {
        assert(!text.includes(forbidden), `discovery must never disclose ${forbidden}`);
      }
      assertEq(report.managed[0]!.collectionDigest, jellyfinIdDigest('box-1'), 'the id is present only as a digest');
      assertEq(report.managed[0]!.collectionDigest.length, 16, 'and the digest is short and non-reversible');
    } finally {
      await fake.close();
    }
  });

  await test('discovery never asks for a media item, on any request it makes', async () => {
    const fake = await startFakeJellyfin({ items: [{ Id: 'x', Name: 'y [cat:z]', Type: 'BoxSet' }] });
    try {
      const config = loadJellyfinControlConfig(enabledEnv(fake.baseUrl));
      assert(config.ok, 'configured');
      await new JellyfinDiscoveryClient({
        baseUrl: config.config.baseUrl, origin: config.config.origin, apiKey: config.config.apiKey,
        fetch: guardedJellyfinFetch(config.config.origin, globalThis.fetch as unknown as FetchLike), timeoutMs: 4000,
      }).discover();
      for (const seen of fake.seen) {
        const types = new URL(seen.url, 'http://x').searchParams.get('IncludeItemTypes');
        assert(types === null || types === 'CollectionFolder' || types === 'BoxSet',
          `discovery asked for item types it must not: ${String(types)}`);
        assert(!seen.url.includes('ProviderIds'), 'discovery never asks for provider ids');
      }
    } finally {
      await fake.close();
    }
  });

  await test('discovery paginates, and says so when it hits a bound rather than implying it saw everything', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ Id: `box-${i}`, Name: `C${i} [cat:t${i}]`, Type: 'BoxSet' }));
    const scripted = scriptedFetch((url) => {
      if (url.includes('/System/Info')) return jsonResponse({ Version: '10.9.0' });
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get('StartIndex') ?? '0');
      const limit = Number(parsed.searchParams.get('Limit') ?? '10');
      const wanted = parsed.searchParams.get('IncludeItemTypes');
      const rows = wanted === 'BoxSet' ? many : [];
      return jsonResponse({ Items: rows.slice(start, start + limit) });
    });
    const client = new JellyfinDiscoveryClient({
      baseUrl: 'http://127.0.0.1:8096', origin: 'http://127.0.0.1:8096', apiKey: API_KEY,
      fetch: scripted.fetch, timeoutMs: 1000, pageLimit: 10,
    });
    const report = await client.discover();
    assertEq(report.collections, 25, 'every page was walked');
    assertEq(report.truncated, false, 'a short final page means nothing was truncated');

    // Now the same data with a row cap smaller than the data. The report must SAY it stopped.
    const capped = new JellyfinDiscoveryClient({
      baseUrl: 'http://127.0.0.1:8096', origin: 'http://127.0.0.1:8096', apiKey: API_KEY,
      fetch: scripted.fetch, timeoutMs: 1000, pageLimit: 10, maxRows: 12,
    });
    const cappedReport = await capped.discover();
    assertEq(cappedReport.collections, 12, 'the row cap held');
    assertEq(cappedReport.truncated, true, 'and it is reported as truncated, never silently');

    // And a server that returns a full page forever stops at the page cap rather than looping.
    const endless = scriptedFetch((url) => url.includes('/System/Info')
      ? jsonResponse({ Version: '1' })
      : jsonResponse({ Items: Array.from({ length: 10 }, (_, i) => ({ Id: `e${i}`, Name: 'x', Type: 'BoxSet' })) }));
    const bounded = new JellyfinDiscoveryClient({
      baseUrl: 'http://127.0.0.1:8096', origin: 'http://127.0.0.1:8096', apiKey: API_KEY,
      fetch: endless.fetch, timeoutMs: 1000, pageLimit: 10, maxPages: 3,
    });
    const endlessReport = await bounded.discover();
    assert(endlessReport.truncated, 'an endless server produces a truncated report, not an endless loop');
    assert(endless.calls.length <= 1 + 3 + 3, 'and a bounded number of requests');
  });

  await test('every transport and protocol failure is a redaction-safe class, never a message', async () => {
    const cases: Array<[string, () => FetchLike, string]> = [
      ['a refused socket', () => scriptedFetch(() => ({ throws: new Error(`connect ECONNREFUSED 192.168.9.9:8096 for ${API_KEY}`) })).fetch, 'unreachable'],
      ['a 401', () => scriptedFetch(() => ({ ok: false, status: 401 })).fetch, 'unauthorized'],
      ['a 403', () => scriptedFetch(() => ({ ok: false, status: 403 })).fetch, 'unauthorized'],
      ['a 500', () => scriptedFetch(() => ({ ok: false, status: 500 })).fetch, 'refused'],
      ['a redirect the transport did not refuse', () => scriptedFetch(() => ({ ok: false, status: 302 })).fetch, 'redirected'],
      ['a body that is not JSON', () => scriptedFetch(() => ({ ok: true, status: 200, text: async () => '<html>login</html>' })).fetch, 'unreadable'],
      ['an enormous body', () => scriptedFetch(() => ({ ok: true, status: 200, text: async () => 'x'.repeat(JELLYFIN_DISCOVERY_MAX_RESPONSE_BYTES + 1) })).fetch, 'too-large'],
    ];
    for (const [label, make, reason] of cases) {
      const client = new JellyfinDiscoveryClient({
        baseUrl: 'http://127.0.0.1:8096', origin: 'http://127.0.0.1:8096', apiKey: API_KEY,
        fetch: make(), timeoutMs: 500,
      });
      let error: unknown;
      try { await client.discover(); } catch (err) { error = err; }
      assert(error instanceof JellyfinDiscoveryError, `${label} produced a typed error`);
      assertEq((error as JellyfinDiscoveryError).reason, reason as never, `${label} reason`);
      const text = String((error as Error).message);
      for (const forbidden of [API_KEY, '192.168.9.9', 'ECONNREFUSED']) {
        assert(!text.includes(forbidden), `${label}: the error must not carry ${forbidden}`);
      }
    }
  });

  await test('a request that outlives the timeout is aborted and reported as a timeout', async () => {
    const fake = await startFakeJellyfin({ delayMs: 2000 });
    try {
      const config = loadJellyfinControlConfig(enabledEnv(fake.baseUrl));
      assert(config.ok, 'configured');
      const client = new JellyfinDiscoveryClient({
        baseUrl: config.config.baseUrl, origin: config.config.origin, apiKey: config.config.apiKey,
        fetch: guardedJellyfinFetch(config.config.origin, globalThis.fetch as unknown as FetchLike),
        timeoutMs: JELLYFIN_TIMEOUT_MIN_MS,
      });
      const started = Date.now();
      let error: unknown;
      try { await client.discover(); } catch (err) { error = err; }
      const elapsed = Date.now() - started;
      assert(error instanceof JellyfinDiscoveryError, 'a slow server produced a typed error');
      assertEq((error as JellyfinDiscoveryError).reason, 'timed-out', 'and it is reported as a timeout');
      assert(elapsed < 1800, `the wait was bounded by the timeout, not by the server (${elapsed}ms)`);
    } finally {
      await fake.close();
    }
  });

  await test('a redirect is refused by the real transport, not followed', async () => {
    const fake = await startFakeJellyfin({ redirectTo: 'http://169.254.169.254/latest/meta-data' });
    try {
      const config = loadJellyfinControlConfig(enabledEnv(fake.baseUrl));
      assert(config.ok, 'configured');
      const client = new JellyfinDiscoveryClient({
        baseUrl: config.config.baseUrl, origin: config.config.origin, apiKey: config.config.apiKey,
        fetch: guardedJellyfinFetch(config.config.origin, globalThis.fetch as unknown as FetchLike), timeoutMs: 3000,
      });
      let error: unknown;
      try { await client.discover(); } catch (err) { error = err; }
      assert(error instanceof JellyfinDiscoveryError, 'the redirect produced a typed error');
      assert(['redirected', 'unreachable'].includes((error as JellyfinDiscoveryError).reason),
        `a redirect is refused (got ${(error as JellyfinDiscoveryError).reason})`);
      assertEq(fake.seen.length, 1, 'and the second request was never made');
    } finally {
      await fake.close();
    }
  });

  await test('a collection name marker is stripped safely, however malformed it is', () => {
    assertEq(stripManagedMarker('Weekend [cat:abc] picks').name, 'Weekend picks', 'a mid-name marker is removed');
    assertEq(stripManagedMarker('Weekend [cat:abc').name, 'Weekend', 'an unterminated marker truncates rather than leaks');
    assertEq(stripManagedMarker('Weekend [cat:abc').marked, false, 'and it is not claimed as marked');
    assertEq(stripManagedMarker('Plain').name, 'Plain', 'a name with no marker is unchanged');
    assertEq(stripManagedMarker(`${'a'.repeat(400)} [cat:x]`).name.length, 120, 'and a long name is bounded');
  });

  // -------------------------------------------------------------------------------------------------------
  // The endpoints.
  // -------------------------------------------------------------------------------------------------------

  await test('with the switch off, no transport exists and the discovery endpoint contacts nothing', async () => {
    assertEq(resolveJellyfinTransport(envWith({})), undefined, 'no switch, no transport');
    assertEq(resolveJellyfinTransport(envWith({ [JELLYFIN_ENABLE_NETWORK_ENV]: 'false' })), undefined, 'a falsey switch, no transport');
    assert(resolveJellyfinTransport(envWith({ [JELLYFIN_ENABLE_NETWORK_ENV]: 'true' })) !== undefined,
      'and the exact switch does produce one');

    // Hand the endpoint a transport that WOULD record a call, and prove none happens.
    const scripted = scriptedFetch(() => jsonResponse({}));
    const result = await jellyfinDiscoveryResponse({
      env: envWith({ JELLYFIN_BASE_URL: 'http://127.0.0.1:8096', JELLYFIN_API_KEY_FILE: KEY_FILE }),
      fetch: scripted.fetch,
    });
    capture(result.body);
    assertEq(result.status, 200, 'a disabled connector is a state, not a fault');
    assertEq(result.body.state, 'DISABLED', 'and it says so');
    assertEq(result.body.contacted, 'nothing', 'and it says it contacted nothing');
    assertEq(scripted.calls.length, 0, 'and it made no call at all');
  });

  await test('with the switch on and the configuration broken, the endpoint still contacts nothing', async () => {
    const scripted = scriptedFetch(() => jsonResponse({}));
    for (const env of [
      envWith({ [JELLYFIN_ENABLE_NETWORK_ENV]: 'true' }),
      envWith({ [JELLYFIN_ENABLE_NETWORK_ENV]: 'true', JELLYFIN_BASE_URL: 'http://evil.example.com', JELLYFIN_API_KEY_FILE: KEY_FILE }),
      envWith({ [JELLYFIN_ENABLE_NETWORK_ENV]: 'true', JELLYFIN_BASE_URL: 'http://127.0.0.1:8096', JELLYFIN_API_KEY: API_KEY }),
    ]) {
      const result = await jellyfinDiscoveryResponse({ env, fetch: scripted.fetch });
      capture(result.body);
      assertEq(result.status, 200, 'a misconfiguration is a state, not a fault');
      assertEq(result.body.state, 'NOT_CONFIGURED', 'and it says so');
      assertEq(result.body.contacted, 'nothing', 'and it says it contacted nothing');
    }
    assertEq(scripted.calls.length, 0, 'and none of them made a call');
  });

  await test('an unreachable server is a 503 carrying a reason class and nothing about the address', async () => {
    const scripted = scriptedFetch(() => ({ throws: new Error(`getaddrinfo ENOTFOUND jellyfin.internal for key ${API_KEY}`) }));
    const result = await jellyfinDiscoveryResponse({ env: enabledEnv('http://127.0.0.1:8096'), fetch: scripted.fetch });
    capture(result.body);
    assertEq(result.status, 503, 'an unreachable server is a 503');
    assertEq(result.body.state, 'UNREACHABLE', 'and it says so');
    assertEq(result.body.reason, 'unreachable', 'with a reason from the closed set');
    const text = JSON.stringify(result.body);
    for (const forbidden of [API_KEY, 'ENOTFOUND', 'jellyfin.internal', '127.0.0.1', KEY_FILE]) {
      assert(!text.includes(forbidden), `the refusal must not carry ${forbidden}`);
    }
  });

  await test('the status route reports the state and contacts nothing, in every configuration', () => {
    for (const env of [envWith({}), enabledEnv('http://127.0.0.1:8096'), envWith({ [JELLYFIN_ENABLE_NETWORK_ENV]: 'true' })]) {
      const previous = { ...process.env };
      try {
        for (const key of Object.keys(process.env)) if (key.startsWith('JELLYFIN_')) delete process.env[key];
        Object.assign(process.env, env);
        const result = capture(jellyfinStatusResponse(env));
        assertEq(result.status, 200, 'the status route always answers');
        assertEq(result.body.contacted, 'nothing', 'and always says it contacted nothing');
      } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, previous);
      }
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // The routes, over real HTTP.
  // -------------------------------------------------------------------------------------------------------

  await test('both routes require the operator token and refuse every method but GET', async () => {
    const config = validateOperatorUiServiceConfig({
      port: 8099, operatorSecretFile: TOKEN_FILE, promotionRecordsDir: WORK,
    });
    const auth = loadOperatorUiLocalAuthRuntime(TOKEN_FILE);
    const server = createOperatorUiServiceServer(config, auth);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const route of [JELLYFIN_STATUS_ROUTE, JELLYFIN_DISCOVERY_ROUTE]) {
        const noToken = await call(server, route);
        assertEq(noToken.status, 401, `${route} refuses an unauthenticated read`);
        assert(!JSON.stringify(noToken.body).includes(TOKEN), 'and the refusal carries no token');

        const wrongToken = await call(server, route, { token: `${TOKEN}x` });
        assertEq(wrongToken.status, 401, `${route} refuses a wrong token`);

        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
          const wrongMethod = await call(server, route, { token: TOKEN, method });
          assertEq(wrongMethod.status, 405, `${route} refuses ${method}`);
          assertEq(wrongMethod.headers.allow, 'GET', `${route} says which method it accepts`);
        }

        const ok = await call(server, route, { token: TOKEN });
        assertEq(ok.status, 200, `${route} answers an authenticated GET`);
        assertEq(ok.body.contacted, 'nothing', `${route} contacted nothing with the switch off`);
        assertEq(ok.headers['cache-control'], 'no-store', `${route} is never cached`);
        assertEq(ok.headers['x-content-type-options'], 'nosniff', `${route} cannot be sniffed`);
      }
      // A HEAD on a known route is a 405 with no body, exactly like every other route in this service.
      const head = await call(server, JELLYFIN_STATUS_ROUTE, { token: TOKEN, method: 'HEAD' });
      assertEq(head.status, 405, 'HEAD on a known route is a 405');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // The repository keeps its story straight.
  // -------------------------------------------------------------------------------------------------------

  await test('nothing under src reaches a bare fetch except the one gated resolver', () => {
    const files = [
      'src/core/adapters/jellyfin/discovery.ts',
      'src/core/adapters/jellyfin/guarded-fetch.ts',
      'src/core/adapters/jellyfin/http-client.ts',
      'src/ops/jellyfin-control-config.ts',
      'src/ops/operator-ui-collections-endpoint.ts',
      'src/ops/collection-execution.ts',
    ];
    for (const file of files) {
      const text = readRepo(file);
      // A bare `fetch(` call, as opposed to a property access on an injected transport or a type name.
      const bare = /(^|[^.\w])fetch\s*\(/.exec(text.replace(/globalThis\.fetch/g, 'INJECTED'));
      assert(bare === null, `${file} must not call a bare fetch (found ${bare?.[0]})`);
    }
    const endpoint = readRepo('src/ops/operator-ui-jellyfin-endpoint.ts');
    assertEq((endpoint.match(/globalThis as \{ fetch\?: unknown \}/g) ?? []).length, 1,
      'exactly one expression in the operator UI can produce a real transport');
  });

  await test('the shipped UI, docs and package describe this phase', () => {
    const html = readRepo('src/ops/operator-ui-service.ts');
    assert(html.includes('id="jellyfin-panel"'), 'the shell has the Jellyfin panel');
    assert(html.includes('#jellyfin-panel'), 'and the navigation links to it');
    const app = readRepo('src/ops/operator-ui-app.js');
    assert(app.includes("getElementById('jfCheck')"), 'the shipped script wires the discovery button');
    // The panel writes every dynamic value with textContent, like every other panel on this page.
    assert(!/jf[A-Z]\w*\.innerHTML/.test(app), 'no Jellyfin value is ever assigned to innerHTML');
    const doc = readRepo('docs/PHASE_266_268_JELLYFIN_CONTROL_PLANE.md');
    for (const needle of ['JELLYFIN_ENABLE_NETWORK', 'JELLYFIN_API_KEY_FILE', 'JELLYFIN_ALLOW_COLLECTION_WRITES']) {
      assert(doc.includes(needle), `the document names ${needle}`);
    }
    const pkg = JSON.parse(readRepo('package.json')) as { scripts: Record<string, string> };
    assert(pkg.scripts['test:phase266-local'] !== undefined, 'the package runs this suite');
  });

  await test('no response this suite produced carries a secret, an address or a Jellyfin id', () => {
    const all = emitted.join('\n');
    for (const forbidden of [API_KEY, TOKEN, KEY_FILE, TOKEN_FILE, 'clint-home-server',
      'server-id-should-never-appear', 'lib-movies', 'box-1']) {
      assert(!all.includes(forbidden), `something disclosed ${forbidden}`);
    }
    assert(emitted.length > 10, 'and the scan actually saw a meaningful number of bodies');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
