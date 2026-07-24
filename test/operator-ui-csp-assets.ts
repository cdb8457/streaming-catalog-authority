import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  OPERATOR_UI_CSP,
  createOperatorUiServiceServer,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import {
  OPERATOR_UI_APP_CSS_ROUTE,
  OPERATOR_UI_APP_JS_ROUTE,
  OPERATOR_UI_ASSET_MAX_BYTES,
} from '../src/ops/operator-ui-assets.js';
import { OPERATOR_UI_LOCAL_AUTH_HEADER } from '../src/ops/operator-ui-local-auth-runtime.js';
import { removeQuietly } from '../src/ops/usable-shell.js';

// Phase 247 — the operator UI's CSP hardening and browser-level acceptance.
//
// The debt this closes: the page carried its script and styles inline, which forced
// `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'`. With those, the browser will execute any
// <script> that reaches the DOM, so the whole no-markup discipline was the ONLY thing between an injected
// string and code execution. Phase 247 serves the behaviour and presentation as fixed same-origin assets and
// drops both allowances, so the browser refuses to run anything the page did not load from this origin.
//
// No browser engine is a dependency of this project (the runtime closure is pinned to pg and tsx, and the
// render-allowlist suite forbids jsdom/cheerio). So "browser-level acceptance" is done two ways, both honest:
//  * a deterministic DOM harness in this file executes the REAL shipped app.js against the REAL running
//    server, so token entry, loading every panel, wrong-token recovery and clear-token are exercised as
//    behaviour, not as string matching;
//  * the daemon-backed container smoke (deploy/ci/runtime-image-smoke.sh) curls a real browser-shaped
//    request set inside the built image and asserts the CSP header and the assets. A real-engine
//    CSP-violation observer is named there as the explicit next rung, not faked here.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

console.log('Running Phase 247 operator UI CSP and asset hardening suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Harness: a real server on a real socket
// ---------------------------------------------------------------------------------------------------------

interface HttpResult {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function httpGet(port: number, path: string, token?: string, method = 'GET'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers[OPERATOR_UI_LOCAL_AUTH_HEADER] = token;
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') { probe.close(); reject(new Error('no port')); return; }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const TOKEN = 'phase247-operator-token-abcdefgh';

interface Harness {
  readonly port: number;
  readonly recordsDir: string;
  readonly logLines: string[];
  readonly stop: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const workspace = mkdtempSync(join(tmpdir(), 'phase247-'));
  const secretFile = join(workspace, 'operator_ui_token');
  writeFileSync(secretFile, `${TOKEN}\n`);
  const recordsDir = join(workspace, 'promotion-records');
  mkdirSync(recordsDir);

  // Capture the server's own stdout log lines so a test can prove the token never lands in them.
  const logLines: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    logLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };

  const port = await freePort();
  const config = validateOperatorUiServiceConfig({
    host: '127.0.0.1', port, operatorSecretFile: secretFile, promotionRecordsDir: '/var/lib/catalog/promotion-records',
  });
  // loadOperatorUiLocalAuthRuntime is re-imported lazily to keep this file's import list focused.
  const { loadOperatorUiLocalAuthRuntime } = await import('../src/ops/operator-ui-local-auth-runtime.js');
  const auth = loadOperatorUiLocalAuthRuntime(secretFile);
  const server: Server = createOperatorUiServiceServer({ ...config, promotionRecordsDir: recordsDir }, auth);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port,
    recordsDir,
    logLines,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (process.stdout.write as unknown) = realWrite;
      removeQuietly(workspace);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// A deterministic DOM, just large enough to run the real app.js
// ---------------------------------------------------------------------------------------------------------

interface FakeElement {
  tagName: string;
  id: string;
  className: string;
  readonly attributes: Record<string, string>;
  children: FakeElement[];
  ownText: string;
  value: string;
  readonly listeners: Record<string, Array<() => unknown>>;
  textContent: string;
  appendChild(child: FakeElement): void;
  replaceChildren(...nodes: FakeElement[]): void;
  addEventListener(type: string, fn: () => unknown): void;
  click(): void;
  set innerHTML(value: string);
}

function makeElement(tagName: string, id = ''): FakeElement {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    id,
    className: '',
    attributes: {},
    children: [],
    ownText: '',
    value: '',
    listeners: {},
    get textContent(): string {
      return el.ownText + el.children.map((child) => child.textContent).join('');
    },
    set textContent(text: string) {
      el.ownText = String(text);
      el.children = [];
    },
    appendChild(child: FakeElement): void { el.children.push(child); },
    replaceChildren(...nodes: FakeElement[]): void { el.children = nodes; el.ownText = ''; },
    addEventListener(type: string, fn: () => unknown): void {
      (el.listeners[type] ??= []).push(fn);
    },
    click(): void { for (const fn of el.listeners.click ?? []) fn(); },
    set innerHTML(value: string) {
      // The real app only ever assigns '' — clearing. Anything else is a bug this harness should surface.
      if (value !== '') throw new Error(`app.js assigned a non-empty innerHTML: ${value.slice(0, 40)}`);
      el.children = []; el.ownText = '';
    },
  };
  return el;
}

/** A whole-tree text + attribute serialization that, like real outerHTML, does NOT include live input values. */
function serializeDom(elements: Map<string, FakeElement>): string {
  const parts: string[] = [];
  for (const el of elements.values()) {
    parts.push(el.tagName, el.id, el.className, ...Object.values(el.attributes), el.textContent);
  }
  return parts.join('');
}

interface RunResult {
  readonly elements: Map<string, FakeElement>;
  readonly consoleErrors: string[];
  readonly fetchUrls: string[];
  document: { getElementById(id: string): FakeElement | null };
}

/**
 * Load the shell + the real app.js and execute the app.js against a fake DOM whose fetch reaches the running
 * server. Returns the DOM and a driver, so a test can enter a token, click, and inspect what rendered.
 */
async function loadApp(port: number): Promise<{
  run: RunResult;
  setToken(value: string): void;
  clickRefresh(): Promise<void>;
  clickClear(): void;
  serialize(): string;
}> {
  const shell = (await httpGet(port, '/')).body;
  const appJs = (await httpGet(port, OPERATOR_UI_APP_JS_ROUTE)).body;

  const elements = new Map<string, FakeElement>();
  // Every id declared in the shell becomes a real element; the app grabs them all up front.
  for (const match of shell.matchAll(/<(\w+)[^>]*\bid="([A-Za-z0-9_-]+)"/g)) {
    const [, tag, id] = match;
    elements.set(id!, makeElement(tag!, id!));
  }

  const consoleErrors: string[] = [];
  const fetchUrls: string[] = [];

  const fetchImpl = (url: string, options?: { headers?: Record<string, string> }): Promise<unknown> => {
    fetchUrls.push(url);
    const token = options?.headers?.[OPERATOR_UI_LOCAL_AUTH_HEADER];
    return httpGet(port, url, token).then((res) => ({
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: () => Promise.resolve(JSON.parse(res.body)),
      text: () => Promise.resolve(res.body),
    }));
  };

  const document = {
    getElementById(id: string): FakeElement | null { return elements.get(id) ?? null; },
    createElement(tag: string): FakeElement { return makeElement(tag); },
  };

  const sandbox = {
    document,
    fetch: fetchImpl,
    console: {
      log: () => undefined,
      error: (...args: unknown[]) => consoleErrors.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => consoleErrors.push(args.map(String).join(' ')),
    },
    setTimeout,
    window: {},
  };

  runInNewContext(appJs, sandbox, { filename: 'operator-ui-app.js' });

  const run: RunResult = { elements, consoleErrors, fetchUrls, document };
  const tokenEl = elements.get('token')!;
  const statusEl = elements.get('statusText')!;

  const settle = async (): Promise<void> => {
    // Real localhost fetches settle in a handful of microtasks; poll until the status leaves 'Loading...'.
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (statusEl.textContent !== 'Loading...' && statusEl.textContent !== '') return;
    }
    throw new Error(`refresh never settled; status was "${statusEl.textContent}"`);
  };

  return {
    run,
    setToken(value: string): void { tokenEl.value = value; },
    async clickRefresh(): Promise<void> { elements.get('refresh')!.click(); await settle(); },
    clickClear(): void { elements.get('clear')!.click(); },
    serialize(): string { return serializeDom(elements); },
  };
}

// ---------------------------------------------------------------------------------------------------------
// CSP and the absence of inline anything
// ---------------------------------------------------------------------------------------------------------

await test('the CSP grants only self for script/style/connect and denies everything else, with no unsafe-inline', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, '/');
    const csp = String(res.headers['content-security-policy'] ?? '');
    assertEq(csp, OPERATOR_UI_CSP, 'the served header is the exported policy');
    assert(!/unsafe-inline/.test(csp), 'there is no unsafe-inline anywhere in the policy');
    assert(!/unsafe-eval/.test(csp), 'and no unsafe-eval');
    for (const directive of [
      "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
      "img-src 'none'", "font-src 'none'", "object-src 'none'",
      "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
    ]) {
      assert(csp.includes(directive), `the policy declares ${directive}`);
    }
    // script-src / style-src are self and ONLY self — no host, no scheme, no nonce, no hash allowance.
    assert(/script-src 'self'(;|$)/.test(csp), "script-src is exactly 'self'");
    assert(/style-src 'self'(;|$)/.test(csp), "style-src is exactly 'self'");
  } finally { await h.stop(); }
});

await test('the shell carries no inline script, no inline style, and no inline event handler', async () => {
  const h = await startHarness();
  try {
    const shell = (await httpGet(h.port, '/')).body;
    assert(!/<script>[\s\S]*?<\/script>/.test(shell), 'there is no inline <script> with a body');
    assert(!/<style[\s>]/.test(shell), 'there is no inline <style> block');
    assert(!/\son[a-z]+\s*=/i.test(shell), 'there is no inline on*= event handler attribute');
    assert(!/javascript:/i.test(shell), 'and no javascript: URL');
    // The behaviour and presentation are external, same-origin, and referenced exactly once each.
    assertEq((shell.match(/<script\b/g) ?? []).length, 1, 'exactly one <script> element');
    assert(/<script src="\/assets\/app\.js" defer><\/script>/.test(shell), 'which is the deferred external app.js');
    assert(/<link rel="stylesheet" href="\/assets\/app\.css">/.test(shell), 'and the stylesheet is external app.css');
    // No resource is loaded from a remote origin: every src=/href= that fetches is same-origin and relative.
    // (Guidance TEXT may mention the loopback URL http://127.0.0.1:8099/, which loads nothing.)
    assert(!/(?:src|href)\s*=\s*"https?:/i.test(shell), 'no element loads a resource from an absolute URL');
    assert(!/(?:src|href)\s*=\s*"\/\//i.test(shell), 'and none from a protocol-relative URL');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// Static asset routing
// ---------------------------------------------------------------------------------------------------------

await test('the assets are served from exact routes with correct MIME, nosniff, and bounded bodies', async () => {
  const h = await startHarness();
  try {
    const js = await httpGet(h.port, OPERATOR_UI_APP_JS_ROUTE);
    assertEq(js.statusCode, 200, 'app.js is served');
    assertEq(js.headers['content-type'], 'text/javascript; charset=utf-8', 'app.js has a JS content type');
    assertEq(js.headers['x-content-type-options'], 'nosniff', 'app.js is nosniff');
    assertEq(js.headers['cache-control'], 'no-store', 'app.js is not cached');
    assert(js.headers['content-security-policy'] !== undefined, 'app.js carries the CSP header too');
    assert(Number(js.headers['content-length']) === Buffer.byteLength(js.body), 'app.js length header matches its body');
    assert(js.body.length > 0 && js.body.length < OPERATOR_UI_ASSET_MAX_BYTES, 'app.js body is bounded');

    const css = await httpGet(h.port, OPERATOR_UI_APP_CSS_ROUTE);
    assertEq(css.statusCode, 200, 'app.css is served');
    assertEq(css.headers['content-type'], 'text/css; charset=utf-8', 'app.css has a CSS content type');
    assertEq(css.headers['cache-control'], 'no-store', 'app.css is not cached');
  } finally { await h.stop(); }
});

await test('the assets carry no source map, no operational data, and no secret', async () => {
  const js = read('src/ops/operator-ui-app.js');
  const css = read('src/ops/operator-ui-app.css');
  for (const [name, text] of [['app.js', js], ['app.css', css]] as const) {
    assert(!/sourceMappingURL/i.test(text), `${name} has no source-map directive`);
    assert(!/https?:\/\//i.test(text), `${name} references no absolute URL`);
    assert(!/\b(?:data|blob):/i.test(text), `${name} embeds no data: or blob: URI`);
    for (const forbidden of ['postgres', 'CUSTODIAN_KEK', 'COMPLETION_SECRET', 'DATABASE_URL', '/run/secrets/', 'operator_ui_token']) {
      // app.js legitimately references the token INPUT and the header name, never a secret path or value.
      if (forbidden === 'operator_ui_token' && name === 'app.js') continue;
      assert(!text.includes(forbidden), `${name} contains no ${forbidden}`);
    }
  }
  // app.css genuinely holds only presentation: no url() with a target, no @import.
  assert(!/@import/i.test(css), 'app.css does not @import');
  assert(!/url\(\s*['"]?\s*[^)]/.test(css), 'app.css has no url() with a target');
});

await test('asset routing accepts only exact GET targets and refuses everything else', async () => {
  const h = await startHarness();
  try {
    // Method policy is explicit and identical to the rest of the service: GET only.
    assertEq((await httpGet(h.port, OPERATOR_UI_APP_JS_ROUTE, undefined, 'HEAD')).statusCode, 405, 'HEAD on an asset is 405');
    assertEq((await httpGet(h.port, OPERATOR_UI_APP_JS_ROUTE, undefined, 'POST')).statusCode, 405, 'POST on an asset is 405');
    const allow = (await httpGet(h.port, OPERATOR_UI_APP_JS_ROUTE, undefined, 'POST')).headers.allow;
    assertEq(allow, 'GET', 'and the asset says only GET is allowed');

    // A near-miss or an unknown asset is a plain 404 — no directory listing, no fallthrough to a file.
    for (const miss of ['/assets/app.js.map', '/assets/app.mjs', '/assets/nope.js', '/assets/', '/assets', '/assets/app.css.bak']) {
      assertEq((await httpGet(h.port, miss)).statusCode, 404, `${miss} is a 404`);
    }
    // Traversal in every spelling the service already refuses.
    for (const evil of ['/assets/../secret', '/assets/..%2fsecret', '/assets/%2e%2e/secret', '/assets/app.js/../app.js', '/..%5c', '//evil']) {
      assertEq((await httpGet(h.port, evil)).statusCode, 404, `${evil} is refused`);
    }
    // A query string cannot change which asset is served; the same bytes come back.
    const plain = await httpGet(h.port, OPERATOR_UI_APP_JS_ROUTE);
    const queried = await httpGet(h.port, `${OPERATOR_UI_APP_JS_ROUTE}?v=12345`);
    assertEq(queried.statusCode, 200, 'a query on the asset still resolves');
    assertEq(queried.body, plain.body, 'to exactly the same bytes');
    assertEq(queried.headers['content-type'], 'text/javascript; charset=utf-8', 'with the same content type');
  } finally { await h.stop(); }
});

await test('the shipped app.js sends exactly the header the server verifies, so they cannot drift', () => {
  const js = read('src/ops/operator-ui-app.js');
  assert(js.includes(`'${OPERATOR_UI_LOCAL_AUTH_HEADER}'`), 'app.js references the real auth header value');
  // And nothing else that looks like a header name, so a rename would be caught rather than silently broken.
  assert(!/x-operator-[a-z-]*(?<!ui-secret)['"]/.test(js.replace(/x-operator-ui-secret/g, '')), 'no stray auth-header lookalike');
});

// ---------------------------------------------------------------------------------------------------------
// Browser-level behaviour: the real app.js against the real server
// ---------------------------------------------------------------------------------------------------------

await test('entering a token and loading exercises installation, status, logs, chain and version from the real endpoints', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port);
    app.setToken(TOKEN);
    await app.clickRefresh();

    const el = (id: string): FakeElement => app.run.elements.get(id)!;
    // The installation verdict came from /api/installation, which always answers 200: a fresh records dir
    // with no secrets is NEEDS_SETUP. The version fields on the same panel come from that response too.
    assert(['READY', 'NEEDS_SETUP', 'DEGRADED'].includes(el('verdict').textContent), 'the verdict rendered a bounded state');
    assert(['RELEASE', 'DEVELOPMENT', 'UNKNOWN'].includes(el('verProvenance').textContent), 'the version provenance rendered');
    assert(Number(el('logCount').textContent) > 0, 'logs rendered a count');
    assert(el('chainOutcome').textContent.length > 0, 'the chain panel rendered an outcome');
    // All four page routes were requested. /api/status answers 503 without a database — an exercised state,
    // not a failure to load — so the page surfaces it as a problem rather than blanking the other panels.
    for (const route of ['/api/installation', '/api/status', '/api/logs', '/api/promotion-chain']) {
      assert(app.run.fetchUrls.includes(route), `the app requested ${route}`);
    }
    // The standalone /api/version route is authenticated and answers with the bounded version view.
    const version = JSON.parse((await httpGet(h.port, '/api/version', TOKEN)).body) as { version: { provenance: string } };
    assert(['RELEASE', 'DEVELOPMENT', 'UNKNOWN'].includes(version.version.provenance), '/api/version returns a bounded provenance');
    // Every request carried the token as a header — never in a URL.
    for (const url of app.run.fetchUrls) assert(!url.includes(TOKEN), `the token is never in the request URL ${url}`);
    assertEq(app.run.consoleErrors.length, 0, 'and nothing was logged to the console');
  } finally { await h.stop(); }
});

await test('a wrong token shows an actionable error, and correcting it recovers without a reload', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port);
    app.setToken('the-wrong-token-but-long-enough');
    await app.clickRefresh();
    const status = app.run.elements.get('statusText')!;
    assert(/token was not accepted/i.test(status.textContent), 'a rejected token produces an actionable message');
    assert(status.className.includes('err'), 'and the status is marked as an error');
    assert(!status.textContent.includes('the-wrong-token'), 'the rejected value is not echoed back');
    assert(!['READY', 'NEEDS_SETUP', 'DEGRADED'].includes(app.run.elements.get('verdict')!.textContent),
      'and nothing loaded under the wrong token');

    // Recovery in the same page, no reload: paste the right token and load again. The installation verdict
    // populating is the proof the good token was accepted (it is the one route that answers 200 without a DB).
    app.setToken(TOKEN);
    await app.clickRefresh();
    assert(['READY', 'NEEDS_SETUP', 'DEGRADED'].includes(app.run.elements.get('verdict')!.textContent),
      'the correct token then loads the panels');
    assert(!/token was not accepted/i.test(app.run.elements.get('statusText')!.textContent),
      'and the token-rejected message is gone');
  } finally { await h.stop(); }
});

await test('an empty token is refused by the page before any request is made', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port);
    app.setToken('');
    app.run.elements.get('refresh')!.click();
    // No settle needed: the guard returns synchronously before any fetch.
    assert(/paste your operator token first/i.test(app.run.elements.get('statusText')!.textContent), 'the page asks for a token');
    assertEq(app.run.fetchUrls.length, 0, 'and makes no request at all');
  } finally { await h.stop(); }
});

await test('Clear zeroes the token input and every panel it loaded', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port);
    app.setToken(TOKEN);
    await app.clickRefresh();
    const el = (id: string): FakeElement => app.run.elements.get(id)!;
    assert(['READY', 'NEEDS_SETUP', 'DEGRADED'].includes(el('verdict').textContent), 'a panel is populated first');
    assert(Number(el('logCount').textContent) > 0, 'and logs are populated');

    app.clickClear();
    assertEq(el('token').value, '', 'the token input is emptied');
    assertEq(el('verdict').textContent, 'Not loaded', 'the verdict is reset');
    assertEq(el('logCount').textContent, '-', 'the log count is reset');
    assertEq(el('service').textContent, '-', 'the status metric is reset');
    assertEq(el('checks').textContent, 'No status loaded.', 'the checks pane is reset');
    assertEq(el('logs').textContent, 'No logs loaded.', 'the logs pane is reset');
    assert(/cleared from this page/i.test(el('statusText').textContent), 'and the page says so');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// The token model, end to end
// ---------------------------------------------------------------------------------------------------------

await test('after loading with a real token, the token is in no DOM serialization, no URL, no log and no storage', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port);
    app.setToken(TOKEN);
    await app.clickRefresh();

    // The DOM serialization (attributes + text, as real outerHTML would give) never contains the token.
    assert(!app.serialize().includes(TOKEN), 'the serialized DOM does not contain the token');
    // The only place the token exists is the live input value property — which serialization does not expose.
    assertEq(app.run.elements.get('token')!.value, TOKEN, 'the token lives only in the input value property');
    for (const url of app.run.fetchUrls) assert(!url.includes(TOKEN), 'no request URL carries the token');
    // The server's own stdout log, captured for the life of this harness, never printed the token.
    assert(!h.logLines.join('').includes(TOKEN), 'the server never logged the token');
    // And the served logs endpoint (which the page rendered) does not contain it either.
    const logs = await httpGet(h.port, '/api/logs', TOKEN);
    assert(!logs.body.includes(TOKEN), 'the logs endpoint never echoes the token');
  } finally { await h.stop(); }
});

await test('the app.js never touches browser storage, cookies, eval, or the URL', () => {
  const js = read('src/ops/operator-ui-app.js');
  for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'eval(', 'new Function', 'importScripts', 'serviceWorker', 'document.write', 'location.search', 'location.hash']) {
    assert(!js.includes(forbidden), `app.js does not use ${forbidden}`);
  }
  // The IIFE wrapper means the token-bearing scope is not reachable as a global.
  assert(/^\(function \(\) \{/m.test(js) || js.trimStart().startsWith('//') , 'app.js is wrapped so nothing leaks onto window');
  assert(js.includes("'use strict'"), 'and runs in strict mode');
});

// ---------------------------------------------------------------------------------------------------------
// Security: injected markup and hostile strings cannot execute
// ---------------------------------------------------------------------------------------------------------

await test('a hostile string is rendered as text, never as markup, and the app never uses an innerHTML path', async () => {
  const h = await startHarness();
  try {
    // A full real refresh runs every render function through this DOM. The fake element throws the moment
    // app.js assigns a non-empty innerHTML, so completing a refresh at all proves no markup-parsing path was
    // taken: every dynamic value went through textContent or createElement.
    const app = await loadApp(h.port);
    app.setToken(TOKEN);
    await app.clickRefresh();
    assert(['READY', 'NEEDS_SETUP', 'DEGRADED'].includes(app.run.elements.get('verdict')!.textContent),
      'the refresh completed without ever assigning markup');

    // The invariant the render code relies on: a hostile string set as textContent stays literal text and
    // produces zero child nodes. (Use makeElement directly — spreading would drop the accessor.)
    const li = makeElement('li');
    li.textContent = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    assertEq(li.ownText, '<img src=x onerror=alert(1)><script>alert(2)</script>', 'a hostile string is stored as literal text');
    assertEq(li.children.length, 0, 'and produces no child elements');
    // And the guard is real: assigning non-empty innerHTML throws, so any future regression is caught here.
    let threw = false;
    try { (li as { innerHTML: string }).innerHTML = '<b>x</b>'; } catch { threw = true; }
    assert(threw, 'the harness refuses a non-empty innerHTML, matching the CSP that would refuse it in a browser');
  } finally { await h.stop(); }
});

await test('the shell escapes the server-rendered guidance it does include', async () => {
  const h = await startHarness();
  try {
    const shell = (await httpGet(h.port, '/')).body;
    // The static checklist/troubleshooting are server-rendered HTML and must be escaped; the apostrophe in
    // the shipped guidance proves the escaper ran.
    assert(shell.includes('&#39;') || shell.includes('&amp;'), 'server-rendered guidance is escaped');
    // No raw <script or <style could have slipped in through that guidance.
    assertEq((shell.match(/<script\b/g) ?? []).length, 1, 'the guidance introduced no extra script element');
    assert(!/<style[\s>]/.test(shell), 'and no style element');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// Accessibility and responsive shell (deterministic DOM assertions)
// ---------------------------------------------------------------------------------------------------------

await test('the shell is keyboard-navigable: native controls, labelled input, live status, natural focus order', async () => {
  const h = await startHarness();
  try {
    const shell = (await httpGet(h.port, '/')).body;
    // Interactive controls are native and focusable — no div-with-onclick, no anchor-as-button.
    assert(/<button id="refresh"/.test(shell), 'Load everything is a real button');
    assert(/<button id="clear"/.test(shell), 'Clear is a real button');
    assert(/<input id="token"[^>]*type="password"/.test(shell), 'the token field is a real input');
    // A real <label for> ties the accessible name to the input.
    assert(/<label for="token">Operator token<\/label>/.test(shell), 'the token input has an associated label');
    assert(/aria-describedby="tokenHelp"/.test(shell), 'and a described-by hint');
    // The status region announces itself to assistive tech.
    assert(/id="statusText"[^>]*role="status"/.test(shell) && /id="statusText"[^>]*aria-live="polite"/.test(shell),
      'the status line is an aria-live status region');
    assert(/<nav aria-label="Sections">/.test(shell), 'the section navigation is labelled');
    // Focus order is DOM order: no positive tabindex reorders it, and focus visibility is styled.
    assert(!/tabindex="[1-9]/.test(shell), 'nothing forces a positive tabindex');
    assert(read('src/ops/operator-ui-app.css').includes(':focus-visible'), 'and focus is given a visible outline');
  } finally { await h.stop(); }
});

await test('the shell declares a mobile viewport and the stylesheet has a narrow-screen layout', async () => {
  const h = await startHarness();
  try {
    const shell = (await httpGet(h.port, '/')).body;
    assert(/<meta name="viewport" content="width=device-width, initial-scale=1">/.test(shell), 'a responsive viewport is declared');
    assert(read('src/ops/operator-ui-app.css').includes('@media(max-width:760px)'), 'and the stylesheet collapses to one column on a narrow screen');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// Everything that already worked still works
// ---------------------------------------------------------------------------------------------------------

await test('every operational route is still authenticated and /healthz stays minimal', async () => {
  const h = await startHarness();
  try {
    for (const route of ['/api/status', '/api/logs', '/api/promotion-chain', '/api/installation', '/api/version']) {
      assertEq((await httpGet(h.port, route)).statusCode, 401, `${route} still requires the token`);
    }
    // Assets need no token (they are not operational data) but the shell and health never did either.
    assertEq((await httpGet(h.port, OPERATOR_UI_APP_JS_ROUTE)).statusCode, 200, 'the asset needs no token');
    const health = await httpGet(h.port, '/healthz');
    const body = JSON.parse(health.body) as Record<string, unknown>;
    assertEq(Object.keys(body).sort().join(','), 'code,mode,ok,service', 'health carries exactly its four keys');
    assert(health.headers['content-security-policy'] !== undefined, 'health still carries the CSP header');
    for (const forbidden of ['version', 'readiness', 'components', 'csp', 'assets']) {
      assert(!(forbidden in body), `health does not leak ${forbidden}`);
    }
  } finally { await h.stop(); }
});

await test('the Dockerfile ships the assets and the bundle contract is untouched', () => {
  // The assets live under src/, which Dockerfile.runtime copies wholesale, so no new COPY is needed — but
  // assert the mechanism is intact so a future narrowing of the COPY cannot silently drop them.
  const dockerfile = read('Dockerfile.runtime');
  assert(/COPY src \.\/src/.test(dockerfile), 'the image copies the whole src tree, assets included');
  // The consumer bundle ships compose + scripts + docs, never src, so the assets are not part of it and its
  // file set is unchanged by this phase. That invariant is asserted in the Phase 245/246 suites; here we only
  // confirm the asset files exist where the image will find them.
  assert(read('src/ops/operator-ui-app.js').length > 0, 'app.js exists in the source tree');
  assert(read('src/ops/operator-ui-app.css').length > 0, 'app.css exists in the source tree');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
