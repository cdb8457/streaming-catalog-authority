import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  createOperatorUiServiceServer,
  SUPPORT_REPORT_PANEL_NOTE,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import {
  buildSupportReportEndpointResult,
  SUPPORT_REPORT_FAILED_CODE,
  SUPPORT_REPORT_FAILED_MESSAGE,
  SUPPORT_REPORT_OK_CODE,
  SUPPORT_REPORT_ROUTE,
} from '../src/ops/operator-ui-support-report-endpoint.js';
import {
  assertSupportReportIsRedactionSafe,
  buildSupportReport,
  renderSupportReportText,
  SUPPORT_REPORT_ID,
  SupportReportRedactionError,
  type SupportReport,
} from '../src/ops/operator-ui-support-report.js';
import { OPERATOR_UI_LOCAL_AUTH_HEADER } from '../src/ops/operator-ui-local-auth-runtime.js';
import { removeQuietly } from '../src/ops/usable-shell.js';

// Phase 255 — the support report, reachable by the person who needs it.
//
// The defect: Phase 246 designed the support report around "a user in trouble will paste whatever we print,
// into a public tracker" and then made the only way to print it `npm run ops:support-report` — a command
// requiring Node.js and a source checkout, neither of which the release bundle ships and neither of which the
// intended reader has. The artifact was unobtainable by its own audience.
//
// What is proved here:
//  * the route is authenticated exactly like every other operational route, and leaks nothing when it is not;
//  * the bytes that are SENT pass the redaction scan — not the object, not the two renderings separately;
//  * a scan rejection withholds the ENTIRE report and is byte-indistinguishable from any other failure;
//  * the page and the CLI render the same report, so the two can never start disagreeing;
//  * it answers with no database, which is the condition it exists to be usable in;
//  * the copy path degrades honestly where the Clipboard API is unavailable — which is the LAN-address case,
//    i.e. exactly the Unraid installs whose operator is least likely to have a terminal open.

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

console.log('Running Phase 255 operator UI support report endpoint suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Harness
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

const TOKEN = 'phase255-operator-token-abcdefgh';

interface Harness {
  readonly port: number;
  readonly recordsDir: string;
  readonly workspace: string;
  readonly logLines: string[];
  readonly stop: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const workspace = mkdtempSync(join(tmpdir(), 'phase255-'));
  const secretFile = join(workspace, 'operator_ui_token');
  writeFileSync(secretFile, `${TOKEN}\n`);
  const recordsDir = join(workspace, 'promotion-records');
  mkdirSync(recordsDir);

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
  const { loadOperatorUiLocalAuthRuntime } = await import('../src/ops/operator-ui-local-auth-runtime.js');
  const auth = loadOperatorUiLocalAuthRuntime(secretFile);
  const server: Server = createOperatorUiServiceServer({ ...config, promotionRecordsDir: recordsDir }, auth);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port,
    recordsDir,
    workspace,
    logLines,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (process.stdout.write as unknown) = realWrite;
      removeQuietly(workspace);
    },
  };
}

interface SupportBody {
  readonly ok: boolean;
  readonly code: string;
  readonly message?: string;
  readonly report?: SupportReport;
  readonly text?: string;
}

// ---------------------------------------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------------------------------------

await test('the route requires the operator token and says nothing without one', async () => {
  const h = await startHarness();
  try {
    for (const token of [undefined, '', 'not-the-token', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const res = await httpGet(h.port, SUPPORT_REPORT_ROUTE, token);
      assertEq(res.statusCode, 401, `a request with token=${String(token)} is refused`);
      assert(!res.body.includes(SUPPORT_REPORT_ID), 'and no report identifier appears in the refusal');
      assert(!res.body.includes('"report"'), 'and no report field appears in the refusal');
      assert(!res.body.includes('Components'), 'and no rendered report text appears in the refusal');
    }
  } finally { await h.stop(); }
});

await test('only GET reaches it; every other method is 405 with Allow: GET, and HEAD has no body', async () => {
  const h = await startHarness();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await httpGet(h.port, SUPPORT_REPORT_ROUTE, TOKEN, method);
      assertEq(res.statusCode, 405, `${method} is refused`);
      assertEq(String(res.headers.allow), 'GET', `${method} is told what is allowed`);
      assert(!res.body.includes(SUPPORT_REPORT_ID), `${method} produced no report`);
    }
    const head = await httpGet(h.port, SUPPORT_REPORT_ROUTE, TOKEN, 'HEAD');
    assertEq(head.statusCode, 405, 'HEAD is refused like every other non-GET');
    assertEq(head.body, '', 'and carries no body at all');
    // The 405 (rather than 404) proves the route is KNOWN. A method probe must not be a route oracle in the
    // other direction either: an unknown path is still 404 for the same method.
    assertEq((await httpGet(h.port, '/api/support-reports', TOKEN, 'POST')).statusCode, 404,
      'a path that does not exist is still 404 for a disallowed method');
  } finally { await h.stop(); }
});

await test('the token never appears in the response or in the service log', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, SUPPORT_REPORT_ROUTE, TOKEN);
    assertEq(res.statusCode, 200, 'the authenticated request succeeded');
    assert(!res.body.includes(TOKEN), 'the token is not echoed in the body');
    const log = h.logLines.join('');
    assert(log.includes('SUPPORT_REPORT_READ'), 'the read is logged');
    assert(!log.includes(TOKEN), 'and the log line does not carry the token');
  } finally { await h.stop(); }
});

await test('the response carries the same safety headers as every other route', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, SUPPORT_REPORT_ROUTE, TOKEN);
    assertEq(String(res.headers['cache-control']), 'no-store', 'a diagnostics dump is never cached');
    assertEq(String(res.headers['x-content-type-options']), 'nosniff', 'the content type is not second-guessed');
    assertEq(String(res.headers['referrer-policy']), 'no-referrer', 'no referrer leaves this page');
    assert(res.headers['content-security-policy'] !== undefined, 'the CSP header is present');
    assertEq(String(res.headers['content-type']), 'application/json; charset=utf-8', 'it is JSON');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// What it returns
// ---------------------------------------------------------------------------------------------------------

await test('an authenticated request returns a complete report and its rendered text', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, SUPPORT_REPORT_ROUTE, TOKEN);
    assertEq(res.statusCode, 200, 'it answered');
    const body = JSON.parse(res.body) as SupportBody;
    assertEq(body.ok, true, 'ok is true');
    assertEq(body.code, SUPPORT_REPORT_OK_CODE, 'the code is the success code');
    assertEq(body.report?.report, SUPPORT_REPORT_ID, 'the report identifies itself');
    assertEq(body.report?.liveCallsMade, 'none', 'and states that it made no live calls');
    assert(typeof body.text === 'string' && body.text.includes('Catalog Authority'), 'the text rendering is present');
    assert(body.text!.includes('Redaction'), 'and carries its own redaction statement');
    assert(Number.isFinite(Date.parse(body.report!.generatedAt)), 'generatedAt is a real timestamp');
  } finally { await h.stop(); }
});

await test('the bytes that are SENT pass the redaction scan, with a real temp records path configured', async () => {
  const h = await startHarness();
  try {
    const res = await httpGet(h.port, SUPPORT_REPORT_ROUTE, TOKEN);
    // The service was configured with an absolute temp directory. If any field echoed it, this throws — and
    // that is the whole point of scanning the serialised envelope rather than the object.
    assertSupportReportIsRedactionSafe(res.body);
    assert(!res.body.includes(h.recordsDir), 'the configured records directory is not in the response');
    assert(!res.body.includes(h.workspace), 'nor is the workspace it lives under');
    assert(!/[a-z][a-z0-9+.-]*:\/\//i.test(res.body), 'no URL of any scheme appears');
  } finally { await h.stop(); }
});

await test('the page and the CLI render the same report, so they cannot drift apart', async () => {
  const h = await startHarness();
  try {
    const body = JSON.parse((await httpGet(h.port, SUPPORT_REPORT_ROUTE, TOKEN)).body) as SupportBody;
    // Rebuild the way the CLI does, with the SAME generatedAt so the two are comparable byte for byte.
    const local = buildSupportReport({ promotionRecordsDir: h.recordsDir, generatedAt: body.report!.generatedAt });
    assertEq(body.text, renderSupportReportText(local), 'the served text equals the CLI rendering');
    assertEq(JSON.stringify(body.report), JSON.stringify(local), 'and so does the structured report');
  } finally { await h.stop(); }
});

await test('it answers with no database at all — the condition it exists to be usable in', async () => {
  const h = await startHarness();
  try {
    // This harness has no PostgreSQL, which is why /api/status genuinely reports itself unavailable.
    assertEq((await httpGet(h.port, '/api/status', TOKEN)).statusCode, 503, 'the status route cannot answer');
    const res = await httpGet(h.port, SUPPORT_REPORT_ROUTE, TOKEN);
    assertEq(res.statusCode, 200, 'the support report still answers');
    const body = JSON.parse(res.body) as SupportBody;
    assertEq(body.report?.liveCallsMade, 'none', 'because it contacts nothing');
    // A database that was never probed must never be reported as healthy. The report passes the
    // `NOT_PROBED` fact in, which the component model renders as UNKNOWN with ADVISORY severity — an
    // unanswered question, not a passing check and not a fault.
    const database = body.report!.components.find((component) => component.id === 'database');
    assertEq(database?.state, 'UNKNOWN', 'the database component is UNKNOWN, not OK');
    assertEq(database?.severity, 'ADVISORY', 'and an unprobed database does not make the report claim a fault');
    assert(body.text!.includes('database') || body.text!.includes('Components'), 'the text carries the component table');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// Failing closed
// ---------------------------------------------------------------------------------------------------------

const SAFE_INPUT = { promotionRecordsDir: '/var/lib/catalog/promotion-records', generatedAt: '2026-07-25T00:00:00.000Z' };

await test('a redaction rejection withholds the entire report rather than part of it', () => {
  const hostile = 'postgresql://operator:hunter2@db.internal:5432/catalog';
  const result = buildSupportReportEndpointResult(SAFE_INPUT, {
    build: buildSupportReport,
    // A rendering that smuggled a URL through. The real renderer scans its own output; this proves the
    // ENDPOINT refuses too, which is what protects a future field nobody thought to check.
    renderText: (report) => `${renderSupportReportText(report)}\nleaked: ${hostile}\n`,
  });
  assertEq(result.status, 503, 'the endpoint refuses');
  assertEq(result.ok, false, 'and reports itself as not ok');
  assert(!result.json.includes(hostile), 'the hostile value is not in the response');
  assert(!result.json.includes('hunter2'), 'nor any part of it');
  assert(!result.json.includes('Components'), 'and no fragment of the report survives');
  const body = JSON.parse(result.json) as SupportBody;
  assertEq(body.ok, false, 'ok is false');
  assertEq(body.code, SUPPORT_REPORT_FAILED_CODE, 'the code names the refusal');
  assertEq(body.message, SUPPORT_REPORT_FAILED_MESSAGE, 'and the message is the fixed sentence');
  assertEq(body.report, undefined, 'there is no report field at all');
  assertEq(body.text, undefined, 'and no text field');
});

await test('the refusal message names no field, quotes no value and points at the CLI', () => {
  const result = buildSupportReportEndpointResult(SAFE_INPUT, {
    build: buildSupportReport,
    renderText: () => { throw new SupportReportRedactionError('a private key'); },
  });
  assertEq(result.status, 503, 'it refuses');
  assert(!result.json.includes('private key'), 'the reason the scan gave is not repeated to the caller');
  assert(result.json.includes('ops:support-report'), 'and the caller is pointed at the CLI, which fails the same way');
});

await test('an unexpected failure is byte-identical to a redaction refusal', () => {
  const redaction = buildSupportReportEndpointResult(SAFE_INPUT, {
    build: buildSupportReport,
    renderText: () => { throw new SupportReportRedactionError('a URL'); },
  });
  const unexpected = buildSupportReportEndpointResult(SAFE_INPUT, {
    build: () => { throw new TypeError('something entirely different went wrong'); },
    renderText: renderSupportReportText,
  });
  assertEq(unexpected.status, 503, 'an unexpected throw also refuses');
  assertEq(unexpected.json, redaction.json, 'and produces exactly the same bytes');
  assert(!unexpected.json.includes('something entirely different'), 'the internal message never escapes');
});

await test('the success path really is the scanned path — the same function produces both outcomes', () => {
  const ok = buildSupportReportEndpointResult(SAFE_INPUT);
  assertEq(ok.status, 200, 'the default dependencies produce a report');
  assertEq(ok.ok, true, 'which is ok');
  assertSupportReportIsRedactionSafe(ok.json);
  assert(ok.json.endsWith('\n'), 'the body is newline-terminated like every other JSON response');
  assertEq(JSON.parse(ok.json).code, SUPPORT_REPORT_OK_CODE, 'and carries the success code');
});

// ---------------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------------

await test('the shell carries the panel and the copy button, and no report content', async () => {
  const h = await startHarness();
  try {
    const shell = (await httpGet(h.port, '/')).body;
    assert(shell.includes('id="support-panel"'), 'the panel exists');
    assert(shell.includes('id="supportReport"'), 'with a place for the report');
    assert(shell.includes('id="copySupport"'), 'and a copy button');
    assert(shell.includes('href="#support-panel"'), 'and the nav links to it');
    // The note is rendered from the exported constant, escaped like every other server-rendered string.
    assert(shell.includes(SUPPORT_REPORT_PANEL_NOTE.slice(0, 40)), 'the panel note is the exported sentence');
    // Nothing about THIS installation is in the shell: the shell needs no token, the report does.
    assert(!shell.includes(SUPPORT_REPORT_ID), 'no report is baked into the token-free shell');
    assert(!shell.includes('Secret files'), 'and no rendered report section');
    assert(shell.includes('No support report loaded.'), 'the panel starts empty');
  } finally { await h.stop(); }
});

await test('the shipped script sends the auth header for the report and never stores it', async () => {
  const h = await startHarness();
  try {
    const appJs = (await httpGet(h.port, '/assets/app.js')).body;
    assert(appJs.includes(SUPPORT_REPORT_ROUTE), 'the script requests the report route');
    assert(appJs.includes(`'${OPERATOR_UI_LOCAL_AUTH_HEADER}'`), 'using the auth header');
    // The asset loader already refuses storage APIs at startup; asserted here as a property of THIS change.
    assert(!/localStorage|sessionStorage|indexedDB|document\.cookie/i.test(appJs), 'and no browser storage is used');
    assert(!/\.innerHTML\s*=\s*(?!'')(?!"")/.test(appJs), 'and nothing is written as markup');
  } finally { await h.stop(); }
});

// A deterministic DOM, just large enough to run the real shipped script and click the real buttons.
interface FakeElement {
  tagName: string;
  id: string;
  className: string;
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
    children: [],
    ownText: '',
    value: '',
    listeners: {},
    get textContent(): string { return el.ownText + el.children.map((child) => child.textContent).join(''); },
    set textContent(text: string) { el.ownText = String(text); el.children = []; },
    appendChild(child: FakeElement): void { el.children.push(child); },
    replaceChildren(...nodes: FakeElement[]): void { el.children = nodes; el.ownText = ''; },
    addEventListener(type: string, fn: () => unknown): void { (el.listeners[type] ??= []).push(fn); },
    click(): void { for (const fn of el.listeners.click ?? []) fn(); },
    set innerHTML(value: string) {
      if (value !== '') throw new Error('the shipped script assigned a non-empty innerHTML');
      el.children = []; el.ownText = '';
    },
  };
  return el;
}

interface ClipboardStub {
  readonly writeText?: (value: string) => Promise<void>;
}

interface AppRun {
  readonly el: (id: string) => FakeElement;
  readonly consoleErrors: string[];
  readonly selections: string[];
  readonly clipboardWrites: string[];
  readonly setToken: (value: string) => void;
  readonly clickRefresh: () => Promise<void>;
  readonly clickCopy: () => void;
}

/** `clipboard` is what `navigator.clipboard` will be; `undefined` models a non-secure context. */
async function loadApp(port: number, clipboard: ClipboardStub | undefined): Promise<AppRun> {
  const shell = (await httpGet(port, '/')).body;
  const appJs = (await httpGet(port, '/assets/app.js')).body;
  const elements = new Map<string, FakeElement>();
  for (const match of shell.matchAll(/<(\w+)[^>]*\bid="([A-Za-z0-9_-]+)"/g)) {
    const [, tag, id] = match;
    elements.set(id!, makeElement(tag!, id!));
  }
  const consoleErrors: string[] = [];
  const selections: string[] = [];
  const clipboardWrites: string[] = [];

  const document = {
    getElementById(id: string): FakeElement | null { return elements.get(id) ?? null; },
    createElement(tag: string): FakeElement { return makeElement(tag); },
    createRange(): { selectNodeContents(node: FakeElement): void; readonly node: FakeElement | null } {
      const range = { node: null as FakeElement | null, selectNodeContents(node: FakeElement): void { range.node = node; } };
      return range;
    },
  };
  const selection = {
    removeAllRanges(): void { /* nothing to model */ },
    addRange(range: { readonly node: FakeElement | null }): void { selections.push(range.node?.id ?? ''); },
  };

  const sandbox: Record<string, unknown> = {
    document,
    fetch: (url: string, options?: { headers?: Record<string, string> }) => httpGet(port, url, options?.headers?.[OPERATOR_UI_LOCAL_AUTH_HEADER]).then((res) => ({
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: () => Promise.resolve(JSON.parse(res.body)),
    })),
    console: { log: () => undefined, error: (...a: unknown[]) => consoleErrors.push(a.map(String).join(' ')), warn: () => undefined },
    setTimeout,
    window: { getSelection: () => selection },
  };
  if (clipboard !== undefined) {
    sandbox.navigator = {
      clipboard: clipboard.writeText === undefined ? {} : {
        writeText: (value: string) => { clipboardWrites.push(value); return clipboard.writeText!(value); },
      },
    };
  }

  runInNewContext(appJs, sandbox, { filename: 'operator-ui-app.js' });

  const statusEl = elements.get('statusText')!;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (statusEl.textContent !== 'Loading...' && statusEl.textContent !== '') return;
    }
    throw new Error(`refresh never settled; status was "${statusEl.textContent}"`);
  };

  return {
    el: (id: string): FakeElement => elements.get(id)!,
    consoleErrors,
    selections,
    clipboardWrites,
    setToken(value: string): void { elements.get('token')!.value = value; },
    async clickRefresh(): Promise<void> { elements.get('refresh')!.click(); await settle(); },
    clickCopy(): void { elements.get('copySupport')!.click(); },
  };
}

await test('loading everything renders the report into the panel, byte-identical to the endpoint', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port, { writeText: () => Promise.resolve() });
    app.setToken(TOKEN);
    await app.clickRefresh();
    const rendered = app.el('supportReport').textContent;
    assert(rendered.includes('Catalog Authority'), 'the report rendered');
    assert(rendered.includes('Redaction'), 'including its redaction statement');
    const body = JSON.parse((await httpGet(h.port, SUPPORT_REPORT_ROUTE, TOKEN)).body) as SupportBody;
    // Compare everything except the timestamp line, which is the one thing that legitimately differs.
    const strip = (text: string): string => text.split('\n').filter((line) => !line.startsWith('generated:')).join('\n');
    assertEq(strip(rendered), strip(body.text!), 'the page shows exactly what the endpoint sent, unreformatted');
    assertEq(app.consoleErrors.length, 0, 'and nothing was logged to the console');
  } finally { await h.stop(); }
});

await test('the copy button uses the Clipboard API when there is one', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port, { writeText: () => Promise.resolve() });
    app.setToken(TOKEN);
    await app.clickRefresh();
    app.clickCopy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertEq(app.clipboardWrites.length, 1, 'the report was written to the clipboard');
    assert(app.clipboardWrites[0]!.includes('Catalog Authority'), 'and it was the report');
    assert(app.el('supportStatus').textContent.includes('Copied'), 'and the operator is told it worked');
    assert(app.el('supportStatus').textContent.includes('safe to publish'), 'and that it is safe to paste');
  } finally { await h.stop(); }
});

// The case this fallback exists for: the UI reached over http://<lan-address>, which is NOT a secure context,
// so navigator.clipboard is undefined. That is a documented, supported Unraid configuration — and it is
// exactly the install whose operator is least likely to have a shell open on the machine.
await test('with no Clipboard API the report is selected and the operator is told which keys to press', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port, undefined);
    app.setToken(TOKEN);
    await app.clickRefresh();
    app.clickCopy();
    assertEq(app.clipboardWrites.length, 0, 'nothing was written to a clipboard that does not exist');
    assertEq(app.selections.join(','), 'supportReport', 'the report itself was selected');
    const status = app.el('supportStatus').textContent;
    assert(status.includes('Ctrl+C'), 'the operator is told which keys to press');
    assert(status.includes('Cmd+C'), 'on either kind of machine');
    assert(!status.includes('Copied'), 'and is NOT told it was copied, because it was not');
  } finally { await h.stop(); }
});

await test('a Clipboard API that rejects falls back rather than claiming success', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port, { writeText: () => Promise.reject(new Error('denied')) });
    app.setToken(TOKEN);
    await app.clickRefresh();
    app.clickCopy();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const status = app.el('supportStatus').textContent;
    assert(!status.includes('Copied'), 'a rejected write is never reported as a copy');
    assert(status.includes('Ctrl+C'), 'and the manual route is offered instead');
    assertEq(app.selections.join(','), 'supportReport', 'with the report selected');
  } finally { await h.stop(); }
});

await test('copying before anything is loaded says so instead of copying a placeholder', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port, { writeText: () => Promise.resolve() });
    app.clickCopy();
    assertEq(app.clipboardWrites.length, 0, 'nothing was copied');
    assert(app.el('supportStatus').textContent.includes('no report to copy'), 'and the operator is told why');
  } finally { await h.stop(); }
});

await test('clearing the token removes the loaded report from the page', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port, { writeText: () => Promise.resolve() });
    app.setToken(TOKEN);
    await app.clickRefresh();
    assert(app.el('supportReport').textContent.includes('Catalog Authority'), 'a report was loaded');
    app.el('clear').click();
    assertEq(app.el('supportReport').textContent, 'No support report loaded.', 'and clearing removed it');
    assertEq(app.el('supportStatus').textContent, '', 'along with anything the copy button said');
  } finally { await h.stop(); }
});

await test('a rejected token leaves no report on the page and is reported once', async () => {
  const h = await startHarness();
  try {
    const app = await loadApp(h.port, { writeText: () => Promise.resolve() });
    app.setToken('the-wrong-token-entirely');
    await app.clickRefresh();
    assert(!app.el('supportReport').textContent.includes('Catalog Authority'), 'no report rendered');
    assert(app.el('supportStatus').textContent.length > 0, 'the panel says what happened');
    assert(app.el('statusText').textContent.includes('token was not accepted'), 'and the banner names the real cause');
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------------------------------------
// Wiring that must not rot
// ---------------------------------------------------------------------------------------------------------

await test('the CLI and the route are two doors onto one report module', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cli = readFileSync(join(root, 'src/ops/operator-ui-support-report-cli.ts'), 'utf8');
  const endpoint = readFileSync(join(root, 'src/ops/operator-ui-support-report-endpoint.ts'), 'utf8');
  for (const source of [cli, endpoint]) {
    assert(source.includes("from './operator-ui-support-report.js'"), 'both import the one report module');
  }
  // Neither re-implements the report; a second builder is how the two would start disagreeing.
  assert(!endpoint.includes('interface SupportReport {'), 'the endpoint does not redeclare the report shape');
  assert(endpoint.includes('assertSupportReportIsRedactionSafe'), 'and it runs the shared scan itself');
});

await test('package.json still exposes the CLI, which this phase adds to rather than replaces', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:support-report'], 'tsx src/ops/operator-ui-support-report-cli.ts',
    'the CLI is still the answer when there is no page to open');
  assertEq(pkg.scripts['test:operator-ui-support-report-endpoint'], 'tsx test/operator-ui-support-report-endpoint.ts',
    'and this suite has its own script');
  assert(pkg.scripts.test?.includes('test/operator-ui-support-report-endpoint.ts'), 'and runs in the aggregate suite');
});

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`\nFAILED: ${name}\n${(err as Error).stack ?? String(err)}`);
process.exit(failed === 0 ? 0 : 1);
