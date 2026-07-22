import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asMap,
  parseMount,
  parseYaml,
  service,
  stringList,
  yamlStrings,
  type YamlMap,
} from './helpers/compose-yaml.js';
import {
  OperatorUiServiceConfigError,
  createOperatorUiServiceServer,
  validateOperatorUiServiceConfig,
} from '../src/ops/operator-ui-service.js';
import { loadOperatorUiLocalAuthRuntime, OPERATOR_UI_LOCAL_AUTH_HEADER } from '../src/ops/operator-ui-local-auth-runtime.js';
import {
  PROMOTION_RECORDS_DEFAULT_DIR,
  PROMOTION_RECORDS_DIR_ENV,
  PromotionRecordsConfigError,
  buildPromotionChainSnapshot,
  resolvePromotionRecordsDir,
} from '../src/ops/operator-ui-promotion-chain.js';
import { CONSOLE_ARTIFACT_FILENAMES, CONSOLE_PHASES } from '../src/ops/promotion-operator-console.js';
import { CONSOLE_INTAKE_MAX_ARTIFACT_BYTES } from '../src/ops/promotion-operator-console-intake.js';
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

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

interface HttpResult { readonly statusCode: number; readonly headers: Record<string, string | string[] | undefined>; readonly body: string }

function httpGet(port: number, path: string, token?: string, method = 'GET'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers[OPERATOR_UI_LOCAL_AUTH_HEADER] = token;
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function choosePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { server.close(() => reject(new Error('no port'))); return; }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const TOKEN = 'phase244-operator-token-ABCDEFGH-12345';
function workspace(): string { return mkdtempSync(join(tmpdir(), 'P244MARKER-')); }
function layout(dir: string, reports: Reports): void {
  mkdirSync(dir, { recursive: true });
  for (const phase of CONSOLE_PHASES) {
    const value = reports[String(phase)];
    if (value !== undefined) writeFileSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[phase]![0]!), JSON.stringify(value, null, 2));
  }
}

// Stand the REAL service up, exactly as Compose does, pointed at a records directory.
async function withService(recordsDir: string, fn: (port: number, token: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'P244MARKER-token-'));
  const tokenFile = join(dir, 'operator_ui_token');
  writeFileSync(tokenFile, `${TOKEN}\n`, 'utf8');
  const port = await choosePort();
  const config = validateOperatorUiServiceConfig({ host: '127.0.0.1', port, operatorSecretFile: tokenFile, promotionRecordsDir: recordsDir });
  const server = createOperatorUiServiceServer(config, loadOperatorUiLocalAuthRuntime(tokenFile));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  try { await fn(port, TOKEN); }
  finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertNoLeak(text: string, where: string): void {
  for (const marker of ['P244MARKER', '/mnt/', '\\mnt\\', 'catalog-authority-test-library', REAL_ITEM_ID, REAL_APPROVAL_ID, 'chain-kit-synthetic', 'Chain Kit', 'source.mp4', TOKEN]) {
    assert(!text.includes(marker), `${where}: leaked ${marker}`);
  }
  for (const d of PARTICIPANT_DIGESTS) assert(!text.includes(d), `${where}: leaked a participant identity`);
  for (const t of PARTICIPANT_TIMESTAMPS) assert(!text.includes(t), `${where}: leaked a timestamp`);
}

console.log('Running Phase 244 operator UI promotion chain suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Configuration: the one value that decides what is read off disk
// ---------------------------------------------------------------------------------------------------------

test('the artifact directory comes from configuration, narrowly validated, and defaults to the container path', () => {
  assertEq(resolvePromotionRecordsDir({}), PROMOTION_RECORDS_DEFAULT_DIR, 'default container path');
  assertEq(PROMOTION_RECORDS_DEFAULT_DIR, '/var/lib/catalog/promotion-records', 'the fixed container path');
  assertEq(resolvePromotionRecordsDir({ [PROMOTION_RECORDS_DIR_ENV]: '/srv/records' }), '/srv/records', 'an absolute path is accepted');

  for (const bad of ['', ' ', 'relative/path', './records', '../escape', '/var/lib/../../etc', '/var/lib/catalog/../..',
    '/records\0/etc', ' /leading-space', '/trailing-space ', `/${'a'.repeat(600)}`, '/a//b', '/a/./b']) {
    let threw: unknown;
    try { resolvePromotionRecordsDir({ [PROMOTION_RECORDS_DIR_ENV]: bad }); } catch (err) { threw = err; }
    assert(threw instanceof PromotionRecordsConfigError, `rejects ${JSON.stringify(bad)}`);
    assert(!(threw as Error).message.includes(bad.trim() || 'IMPOSSIBLE'), 'and never echoes the rejected value');
  }
});

test('a misconfigured artifact directory refuses service startup rather than surfacing later', () => {
  const ok = validateOperatorUiServiceConfig({ operatorSecretFile: '/run/secrets/operator_ui_token' });
  assertEq(ok.promotionRecordsDir, PROMOTION_RECORDS_DEFAULT_DIR, 'the default is carried on the config');
  let threw: unknown;
  try {
    validateOperatorUiServiceConfig({ operatorSecretFile: '/run/secrets/operator_ui_token', promotionRecordsDir: '../escape' });
  } catch (err) { threw = err; }
  assert(threw instanceof OperatorUiServiceConfigError, 'a bad records directory is a config rejection');
});

// ---------------------------------------------------------------------------------------------------------
// The token boundary
// ---------------------------------------------------------------------------------------------------------

await test('the promotion chain route requires the operator token, exactly like every other operational route', async () => {
  const ws = workspace();
  try {
    const dir = join(ws, 'records');
    layout(dir, buildRealP227AChain());
    await withService(dir, async (port, token) => {
      assertEq((await httpGet(port, '/api/promotion-chain')).statusCode, 401, 'no token is unauthorized');
      assertEq((await httpGet(port, '/api/promotion-chain', 'wrong-token-value-ABCDEFGH-12345')).statusCode, 401, 'a wrong token is unauthorized');
      assertEq((await httpGet(port, '/api/promotion-chain', '')).statusCode, 401, 'an empty token is unauthorized');
      const unauth = await httpGet(port, '/api/promotion-chain');
      assertEq(JSON.parse(unauth.body).code, 'OPERATOR_UI_SERVICE_UNAUTHORIZED', 'the existing unauthorized contract is reused');
      assert(!unauth.body.includes('AUDIT'), 'and an unauthorized caller learns nothing about the chain');
      assertNoLeak(unauth.body, 'unauthorized body');

      // Health stays unauthenticated and redaction-safe, as the existing contract requires.
      const health = await httpGet(port, '/healthz');
      assertEq(health.statusCode, 200, 'health is open');
      assertNoLeak(health.body, 'health body');
      assert(!health.body.includes('AUDIT_'), 'health never leaks a chain verdict');

      assertEq((await httpGet(port, '/api/promotion-chain', token)).statusCode, 200, 'the token opens it');
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

await test('unsafe methods and targets fail closed on the promotion route too', async () => {
  const ws = workspace();
  try {
    const dir = join(ws, 'records');
    layout(dir, buildRealP227AChain());
    await withService(dir, async (port, token) => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
        assertEq((await httpGet(port, '/api/promotion-chain', token, method)).statusCode, 405, `${method} rejected`);
      }
      assertEq((await httpGet(port, '/..%2f..%2fapi/promotion-chain', token)).statusCode, 404, 'encoded traversal rejected');
      assertEq((await httpGet(port, '/api/promotion-chain/../../etc', token)).statusCode, 404, 'traversal rejected');
      // A query string is stripped for a known route, exactly as the existing service does -- and it cannot
      // influence which directory is read, because the directory never comes from the request.
      assertEq((await httpGet(port, '/api/promotion-chain?dir=/etc', token)).statusCode, 200, 'query stripped, not honoured');
      const body = JSON.parse((await httpGet(port, '/api/promotion-chain?dir=/etc', token)).body) as { artifactSourceIsBrowserSupplied: boolean };
      assertEq(body.artifactSourceIsBrowserSupplied, false, 'and the payload says so plainly');
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// What it serves
// ---------------------------------------------------------------------------------------------------------

await test('the ACTUAL P227-A chain renders AUDIT_OPEN through the authenticated route', async () => {
  const ws = workspace();
  try {
    const dir = join(ws, 'records');
    layout(dir, buildRealP227AChain());
    await withService(dir, async (port, token) => {
      const res = await httpGet(port, '/api/promotion-chain', token);
      assertEq(res.statusCode, 200, 'an honestly unfinished chain is healthy');
      const body = JSON.parse(res.body) as { ok: boolean; availability: string; report: string; view: Record<string, unknown> };
      assertEq(body.report, 'phase-244-operator-ui-promotion-chain', 'report id');
      assertEq(body.availability, 'READABLE', 'the directory was read');
      assertEq(body.ok, true, 'and an unfinished chain is not a fault');
      assertEq(body.view.overall, 'AUDIT_OPEN', 'the real chain is AUDIT_OPEN');
      assertEq(body.view.terminalPhase, 232, 'reaching Phase 232');
      assertEq(body.view.nextRequiredPhase, 232, 'with the undecided Phase 232 outstanding');
      assertEq(body.view.nextIsUnfinished, true, 'flagged as present-but-unfinished');
      assertEq((body.view.blockers as unknown[]).length, 0, 'and no blockers');
      assertEq((body.view.proofLimits as unknown[]).length, 11, 'the proof limits travel with the verdict');
      assert(String(body.view.headline).includes('honestly unfinished'), 'presented as normal');
      assert(String(body.view.caveat).includes('normal, not a defect'), 'explicitly not a defect');
      assert(res.body.includes('APPROVE or DECLINE'), 'and the outstanding human step is shown');
      assertNoLeak(res.body, 'promotion chain body');
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

await test('malformed, duplicate, symlinked and oversized artifacts fail closed through the route', async () => {
  const ws = workspace();
  try {
    const chain = buildSyntheticChain(ws);
    const dir = join(ws, 'records');
    layout(dir, chain);
    writeFileSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[234]![0]!), '{ truncated');
    writeFileSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[236]![1]!), JSON.stringify(chain['236']!));
    writeFileSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[237]![0]!), `{"report":"x","pad":"${'p'.repeat(CONSOLE_INTAKE_MAX_ARTIFACT_BYTES + 64)}"}`);
    const outside = join(ws, 'outside.json');
    writeFileSync(outside, JSON.stringify(chain['235']!));
    rmSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[235]![0]!));
    let linked = true;
    try { symlinkSync(outside, join(dir, CONSOLE_ARTIFACT_FILENAMES[235]![0]!), 'file'); }
    catch {
      const outsideDir = join(ws, 'outside-dir'); mkdirSync(outsideDir, { recursive: true });
      try { symlinkSync(outsideDir, join(dir, CONSOLE_ARTIFACT_FILENAMES[235]![0]!), 'junction'); }
      catch { linked = false; console.log('        (symlink case skipped: this host permits no link creation)'); }
    }

    await withService(dir, async (port, token) => {
      const res = await httpGet(port, '/api/promotion-chain', token);
      assertEq(res.statusCode, 503, 'a chain that does not hang together is not healthy');
      const body = JSON.parse(res.body) as { ok: boolean; view: { overall: string; artifacts: Array<{ phase: number; status: string }> } };
      assertEq(body.ok, false, 'reported unhealthy');
      assertEq(body.view.overall, 'AUDIT_INVALID', 'and invalid');
      const status = (phase: number): string => body.view.artifacts.find((a) => a.phase === phase)!.status;
      assertEq(status(234), 'MALFORMED', 'unparseable is malformed');
      assertEq(status(236), 'DUPLICATE', 'two names for one phase is a duplicate');
      assertEq(status(237), 'MALFORMED', 'oversized is malformed');
      if (linked) assertEq(status(235), 'MALFORMED', 'a symlink is refused, not followed');
      assert(!res.body.includes('pppppppppp'), 'no oversized content is ever parsed into the response');
      assertNoLeak(res.body, 'failed-closed body');
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

await test('a missing artifact directory is an honest configuration state, not a crash or a verdict', async () => {
  const ws = workspace();
  try {
    await withService(join(ws, 'does-not-exist'), async (port, token) => {
      const res = await httpGet(port, '/api/promotion-chain', token);
      assertEq(res.statusCode, 503, 'unavailable is not healthy');
      const body = JSON.parse(res.body) as { code: string; availability: string; view: null; unavailableGuidance: string[] };
      assertEq(body.code, 'PROMOTION_CHAIN_ARTIFACT_DIRECTORY_UNAVAILABLE', 'named as unavailable');
      assertEq(body.availability, 'ARTIFACT_DIRECTORY_UNAVAILABLE', 'and not confused with a chain verdict');
      assertEq(body.view, null, 'no view is invented');
      assert(body.unavailableGuidance.some((g) => g.includes('On a fresh install this is expected')), 'a fresh install is explained, not alarmed about');
      assert(body.unavailableGuidance.some((g) => g.includes('cannot be chosen, typed or uploaded')), 'and the boundary is restated');
      assertNoLeak(res.body, 'unavailable body');
      assert(!res.body.includes('does-not-exist'), 'the configured path is never echoed');
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('a directory that cannot be read never becomes a chain verdict at module level either', () => {
  const snapshot = buildPromotionChainSnapshot(join(tmpdir(), 'P244MARKER-absent-directory'));
  assertEq(snapshot.availability, 'ARTIFACT_DIRECTORY_UNAVAILABLE', 'unavailable');
  assertEq(snapshot.ok, false, 'not ok');
  assertEq(snapshot.view, null, 'and no verdict');
  assertEq(snapshot.artifactSourceIsBrowserSupplied, false, 'the source is never browser-supplied');
  assertEq(snapshot.mutationsOffered, 'none', 'and nothing is offered to change');
});

// ---------------------------------------------------------------------------------------------------------
// The page, and the routes that were already there
// ---------------------------------------------------------------------------------------------------------

await test('the UI shows a promotion chain panel and navigation, and injects nothing as markup', async () => {
  const ws = workspace();
  try {
    const dir = join(ws, 'records');
    layout(dir, buildRealP227AChain());
    await withService(dir, async (port) => {
      const page = await httpGet(port, '/');
      assertEq(page.statusCode, 200, 'root serves');
      assert(page.body.includes('Promotion Record Chain'), 'the panel is visible');
      assert(page.body.includes('id="promotion-panel"'), 'with a stable anchor');
      assert(page.body.includes('href="#promotion-panel"'), 'and navigation to it');
      assert(page.body.includes('<nav aria-label="Sections">'), 'the nav is labelled for a screen reader');
      for (const id of ['chainOutcome', 'chainReaches', 'chainNext', 'chainBlockerCount', 'chainArtifacts', 'chainBlockers', 'chainSteps', 'chainLimits']) {
        assert(page.body.includes(`id="${id}"`), `panel field ${id} present`);
      }
      assert(page.body.includes('/api/promotion-chain'), 'the panel reads the authenticated route');
      assert(page.body.includes('cache:\'no-store\''), 'and never caches a verdict');
      // Everything dynamic is built as TEXT. The only innerHTML in the shell is the pre-existing clear-to-empty.
      const scriptBody = page.body.slice(page.body.indexOf('<script>'));
      const innerHtmlWrites = [...scriptBody.matchAll(/innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1]!.trim());
      assert(innerHtmlWrites.every((v) => v === "''"), `no dynamic innerHTML write: ${innerHtmlWrites.join(' | ')}`);
      assert(scriptBody.includes('li.textContent = item'), 'lists are built with textContent');
      // The existing Phase 147 surface is intact.
      for (const required of ['Catalog Authority', 'Operator token', 'Needs Attention', 'passCount', 'warnCount', 'failCount']) {
        assert(page.body.includes(required), `existing UI keeps ${required}`);
      }
      assertNoLeak(page.body, 'root page');
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

await test('artifacts stuffed with markup cannot reach the response, and the headers still deny scripts a target', async () => {
  const ws = workspace();
  try {
    const chain = buildSyntheticChain(ws);
    const dir = join(ws, 'records');
    const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    layout(dir, { ...chain, 235: { report: payload, [payload]: payload, injected: payload } as unknown as Rec });
    await withService(dir, async (port, token) => {
      const res = await httpGet(port, '/api/promotion-chain', token);
      assert(!res.body.includes(payload), 'the payload never appears');
      assert(!res.body.includes('onerror'), 'nor any fragment of it');
      assert(!/<script/i.test(res.body), 'no script markup in the JSON');
      for (const [name, expected] of [['content-security-policy', "default-src 'none'"], ['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer'], ['x-frame-options', 'DENY'], ['cache-control', 'no-store']] as const) {
        assert(String(res.headers[name] ?? '').includes(expected), `${name} carries ${expected}`);
      }
      assertEq(res.headers['content-type'], 'application/json; charset=utf-8', 'served as JSON, never as HTML');
      assertNoLeak(res.body, 'injected-artifact body');
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

await test('the existing status and logs routes are unchanged by this phase', async () => {
  const ws = workspace();
  try {
    const dir = join(ws, 'records');
    layout(dir, buildRealP227AChain());
    await withService(dir, async (port, token) => {
      assertEq((await httpGet(port, '/api/status')).statusCode, 401, 'status still needs a token');
      assertEq((await httpGet(port, '/api/logs')).statusCode, 401, 'logs still need a token');
      const status = await httpGet(port, '/api/status', token);
      assertEq(status.statusCode, 503, 'status still reports an unavailable database as 503');
      const parsed = JSON.parse(status.body) as { report: string; mode: string; auth: string; forbidden: string[] };
      assertEq(parsed.report, 'phase-147-operator-ui-service', 'status report id unchanged');
      assertEq(parsed.mode, 'read-only-first', 'mode unchanged');
      assertEq(parsed.auth, 'local-admin-token-file', 'auth boundary unchanged');
      assert(parsed.forbidden.includes('runtime-mutations'), 'forbidden list unchanged');
      const logs = await httpGet(port, '/api/logs', token);
      assertEq(logs.statusCode, 200, 'logs still serve');
      const logBody = JSON.parse(logs.body) as { report: string; entries: Array<{ message: string; code: string }> };
      assertEq(logBody.report, 'phase-147-operator-ui-service-logs', 'logs report id unchanged');
      // The promotion route logs its verdict, and nothing about the filesystem.
      await httpGet(port, '/api/promotion-chain', token);
      const after = JSON.parse((await httpGet(port, '/api/logs', token)).body) as { entries: Array<{ message: string; code: string }> };
      assert(after.entries.some((e) => e.code === 'PROMOTION_CHAIN_READ'), 'the read is logged');
      assertNoLeak(JSON.stringify(after.entries), 'log entries');
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// Packaging: the Compose stack an operator actually installs
// ---------------------------------------------------------------------------------------------------------

const RUNTIME_SECRETS = ['postgres_password', 'admin_database_url', 'database_url',
  'completion_secret', 'custodian_kek', 'operator_ui_token'] as const;

// These assert what the stack IS, not how its file is typed: the compose files are parsed, so indentation
// width, key order, quoting and line endings cannot decide the verdict. A CRLF checkout is the same stack as
// an LF one, and a `cap_drop: [ALL]` under the WRONG service no longer passes for hardening.
const compose = (name: string): YamlMap => parseYaml(read(name));

/** Searches every CONFIGURED string — comments are excluded, because a comment configures nothing. */
function assertMentionsNothingOf(doc: YamlMap, forbidden: readonly string[], what: string): void {
  const strings = yamlStrings(doc).map((s) => s.toLowerCase());
  for (const term of forbidden) {
    assert(!strings.some((s) => s.includes(term.toLowerCase())), `${what} configures nothing mentioning ${term}`);
  }
}

test('the runtime Compose stack mounts the artifact folder read-only and hardens the app container', () => {
  const doc = compose('docker-compose.runtime.yml');
  const app = service(doc, 'app');
  const postgres = service(doc, 'postgres');

  const records = stringList(app.volumes ?? null, 'app volumes').map(parseMount)
    .find((mount) => mount.target === '/var/lib/catalog/promotion-records');
  assert(records !== undefined, 'the artifact folder is mounted at the fixed container path');
  assert(records!.options.includes('ro'), 'the artifact folder is mounted READ-ONLY');
  assertEq(records!.source, '${PROMOTION_RECORDS_HOST_DIR:-./promotion-records}', 'the host folder is operator-selected');
  const env = asMap(app.environment ?? null, 'app environment');
  assertEq(env.PROMOTION_RECORDS_DIR, records!.target, 'and the container is told where it is');
  assertEq(env.OPERATOR_UI_TOKEN_FILE, '/run/secrets/operator_ui_token', 'behind the existing token file');

  assertEq(app.read_only, true, 'the app filesystem is read-only');
  assertEq(stringList(app.cap_drop ?? null, 'app cap_drop').join('+'), 'ALL', 'all capabilities dropped');
  assert(stringList(app.security_opt ?? null, 'app security_opt').includes('no-new-privileges:true'), 'no privilege escalation');
  assertEq(app.user, 'node', 'runs as a non-root user');
  assert(stringList(app.tmpfs ?? null, 'app tmpfs').includes('/tmp'), 'with a tmpfs for scratch');
  for (const bound of ['pids_limit', 'mem_limit', 'cpus']) {
    assert(app[bound] !== undefined && app[bound] !== null, `bounded resources: ${bound}`);
  }
  assertEq(app.restart, 'unless-stopped', 'restart policy');
  const healthcheck = asMap(app.healthcheck ?? null, 'app healthcheck');
  assert(stringList(healthcheck.test ?? null, 'healthcheck test').some((part) => part.includes('/healthz')),
    'healthcheck against the unauthenticated health route');

  const published = stringList(app.ports ?? null, 'app ports').map(parseMount);
  assertEq(published.length, 1, 'exactly one published port');
  assertEq(published[0]!.source, '${OPERATOR_UI_BIND_ADDRESS:-127.0.0.1}', 'published to loopback by default');
  assertEq(published[0]!.target, '${OPERATOR_UI_HOST_PORT:-8099}', 'on an operator-selectable host port');
  assertEq(published[0]!.options.join('+'), '8099', 'forwarding to the service port');
  assert(stringList(app.command ?? null, 'app command').includes('ops:operator-ui-server'), 'runs the EXISTING operator UI service');

  // No second web server, no escape hatches, no live surfaces.
  for (const [name, svc] of Object.entries(asMap(doc.services ?? null, 'services'))) {
    const parsed = asMap(svc, `service ${name}`);
    assert(parsed.privileged !== true, `${name} is not privileged`);
    assert(parsed.network_mode === undefined, `${name} does not choose a host network mode`);
    const mounts = parsed.volumes === undefined || parsed.volumes === null ? [] : stringList(parsed.volumes, `${name} volumes`);
    for (const mount of mounts.map(parseMount)) {
      assert(!mount.source.includes('docker.sock') && !mount.target.includes('docker.sock'), `${name} mounts no Docker socket`);
    }
  }
  assertMentionsNothingOf(doc, ['docker.sock', 'promotion-operator-dashboard', 'JELLYFIN_ALLOW_LIVE_PUBLISH',
    'jellyfin', '/mnt/user/media/Movies', 'unraid-real-library-promotion'], 'the runtime stack');

  // Postgres is reachable only from the app, never published to the host.
  assertEq(postgres.ports, undefined, 'postgres is not published to the host');
  assert(stringList(postgres.expose ?? null, 'postgres expose').includes('5432'), 'it is only exposed on the compose network');

  // The secret files the stack declares are the ones the setup scripts write.
  const declared = Object.keys(asMap(doc.secrets ?? null, 'secrets')).sort();
  assertEq(declared.join(','), [...RUNTIME_SECRETS].sort().join(','), 'the declared secrets are the generated ones');
  for (const [name, definition] of Object.entries(asMap(doc.secrets ?? null, 'secrets'))) {
    assertEq(asMap(definition, `secret ${name}`).file, `./secrets/${name}`, `secret ${name} is a local file`);
  }
});

test('the CI and Unraid compose files are left as they were', () => {
  const ci = compose('docker-compose.yml');
  assertEq(stringList(service(ci, 'app').command ?? null, 'CI app command').join(' '), 'npm run ci', 'root compose is still the CI harness running the suite');
  assertMentionsNothingOf(ci, ['promotion-records', 'operator-ui-server'], 'the CI harness');
  const unraidRuntime = compose('docker-compose.unraid.runtime.yml');
  assert(stringList(service(unraidRuntime, 'app').command ?? null, 'Unraid app command').includes('ops:operator-ui-server'),
    'the Unraid runtime still runs the same service');
  assert(stringList(service(unraidRuntime, 'app').ports ?? null, 'Unraid app ports').map(parseMount).some((port) => port.target === '8099'),
    'on the same port');
  assertMentionsNothingOf(unraidRuntime, ['promotion-records'], 'the Unraid runtime stack');
  for (const other of ['docker-compose.unraid.yml', 'docker-compose.deploy.yml']) {
    assert(Object.keys(asMap(compose(other).services ?? null, `${other} services`)).length > 0, `${other} still exists and still declares services`);
  }
});

test('setup, docs and package scripts make the install runnable without reading the source', () => {
  for (const script of ['deploy/local-runtime-setup.sh', 'deploy/local-runtime-setup.ps1']) {
    const setup = read(script);
    for (const required of [...RUNTIME_SECRETS,
      'docker compose -f docker-compose.runtime.yml up -d', 'http://127.0.0.1:8099/', 'already exists']) {
      assert(setup.includes(required), `${script} covers ${required}`);
    }
    for (const forbidden of ['unraid-real-library-promotion', '/mnt/user/media/Movies', 'jellyfin', 'git push', 'git tag', 'docker compose up']) {
      assert(!setup.toLowerCase().includes(forbidden.toLowerCase()), `${script} never does ${forbidden}`);
    }
  }
  const doc = read('docs/PHASE_244_PROMOTION_CHAIN_OPERATOR_UI.md');
  for (const required of ['./deploy/local-runtime-setup.sh', '.\\deploy\\local-runtime-setup.ps1',
    'docker compose -f docker-compose.runtime.yml up -d',
    'docker compose -f docker-compose.runtime.yml down', 'http://127.0.0.1:8099/', 'PROMOTION_RECORDS_HOST_DIR',
    '/var/lib/catalog/promotion-records', ':ro', 'Operator token', 'healthz', 'Upgrading', 'AUDIT_OPEN']) {
    assert(doc.includes(required), `doc covers ${required}`);
  }
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:promotion-chain-operator-ui'], 'tsx test/promotion-chain-operator-ui.ts', 'test script');
  assertEq(pkg.scripts['test:phase244-local'], 'tsx test/promotion-chain-operator-ui.ts', 'phase-local script');
  assert((pkg.scripts.test ?? '').includes('tsx test/promotion-operator-dashboard.ts && tsx test/promotion-chain-operator-ui.ts'), 'aggregate order');
});

test('the README points an ordinary operator at the runtime stack, on either kind of machine', () => {
  const readme = read('README.md');
  assert(readme.includes('docker-compose.runtime.yml'), 'README names the runtime compose file');
  assert(readme.includes('deploy/local-runtime-setup.sh'), 'and the one-command setup for Linux and macOS');
  assert(readme.includes('deploy\\local-runtime-setup.ps1'), 'and the native Windows one');
});

// ---------------------------------------------------------------------------------------------------------
// Bootstrap: both setup scripts, run for real against a throwaway workspace
//
// The two scripts are one promise made twice. Reading them proves nothing about what they do, so each is
// staged into a temporary directory and executed there: the scripts resolve their own location, so a staged
// copy cannot reach the repository's real ./secrets, and the test asserts that too.
// ---------------------------------------------------------------------------------------------------------

interface BootstrapShell { readonly command: string; readonly args: (script: string) => string[] }

/** Stage a setup script alone in a throwaway repository-shaped directory. */
function stageSetupWorkspace(scriptName: string): string {
  const ws = mkdtempSync(join(tmpdir(), 'phase244-bootstrap-'));
  mkdirSync(join(ws, 'deploy'));
  writeFileSync(join(ws, 'deploy', scriptName), readFileSync(`${root}/deploy/${scriptName}`));
  return ws;
}

/** The first interpreter that can actually execute a staged script here — not merely one that is installed. */
function usableShell(candidates: readonly BootstrapShell[], probeName: string, probeBody: string): BootstrapShell | null {
  const ws = mkdtempSync(join(tmpdir(), 'phase244-probe-'));
  try {
    const probe = join(ws, probeName);
    writeFileSync(probe, probeBody);
    for (const shell of candidates) {
      const run = spawnSync(shell.command, shell.args(probe.replace(/\\/g, '/')), { cwd: ws, encoding: 'utf8', timeout: 120000 });
      if (run.status === 0 && (run.stdout ?? '').includes('phase244-ok')) return shell;
    }
    return null;
  } finally { rmSync(ws, { recursive: true, force: true }); }
}

const bashShell = usableShell(
  [{ command: 'bash', args: (s) => [s] },
   { command: `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\bin\\bash.exe`, args: (s) => [s] }],
  'probe.sh', 'echo phase244-ok\n');

const powershellShell = usableShell(
  [{ command: 'pwsh', args: (s) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', s] },
   { command: 'powershell', args: (s) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', s] }],
  'probe.ps1', "Write-Host 'phase244-ok'\n");

function runSetup(shell: BootstrapShell, ws: string, scriptName: string): string {
  const run = spawnSync(shell.command, shell.args(join(ws, 'deploy', scriptName).replace(/\\/g, '/')),
    { cwd: ws, encoding: 'utf8', timeout: 300000 });
  assertEq(run.status, 0, `${scriptName} exits cleanly: ${run.stderr ?? ''}`);
  return run.stdout ?? '';
}

/** Everything a generated secret file must be, whichever script wrote it. */
function assertBootstrapped(label: string, ws: string, stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of RUNTIME_SECRETS) {
    const raw = readFileSync(join(ws, 'secrets', name));
    assert(raw.length > 0, `${label}: ${name} is not empty`);
    assert(raw[0] !== 0xef, `${label}: ${name} carries no byte-order mark`);
    assert(!raw.includes(0x0d), `${label}: ${name} has no CR — the container would read it as part of the value`);
    assertEq(raw[raw.length - 1], 0x0a, `${label}: ${name} ends with a single newline`);
    values[name] = raw.toString('utf8').trim();
  }
  const password = values.postgres_password!;
  assert(/^[A-Za-z0-9]{32}$/.test(password), `${label}: the Postgres password is 32 URL-safe characters, got ${password.length}`);
  for (const url of ['admin_database_url', 'database_url'] as const) {
    assertEq(values[url], `postgresql://postgres:${password}@postgres:5432/catalog`, `${label}: ${url} uses the generated password`);
  }
  for (const name of ['completion_secret', 'custodian_kek', 'operator_ui_token'] as const) {
    assert(/^[A-Za-z0-9+/]{43}=$/.test(values[name]!), `${label}: ${name} is 32 random bytes, base64`);
  }
  const distinct = new Set([values.completion_secret, values.custodian_kek, values.operator_ui_token, password]);
  assertEq(distinct.size, 4, `${label}: every generated secret is drawn independently`);

  // Only the token an operator has to paste is printed; nothing else reaches the terminal or a scrollback.
  assert(stdout.includes(values.operator_ui_token!), `${label}: the operator token is printed`);
  for (const name of ['completion_secret', 'custodian_kek', 'postgres_password', 'admin_database_url', 'database_url'] as const) {
    assert(!stdout.includes(values[name]!), `${label}: ${name} is never printed`);
  }
  assert(existsSync(join(ws, 'promotion-records')), `${label}: the artifact folder is created`);
  assertEq(readdirSync(join(ws, 'promotion-records')).length, 0, `${label}: and it is left empty`);
  assertEq(readdirSync(ws).sort().join(','), 'deploy,promotion-records,secrets', `${label}: nothing else is created`);
  return values;
}

/** The repository's own secrets, as a fingerprint we can prove a staged run never touched. */
function repoSecretsFingerprint(): string {
  const dir = `${root}/secrets`;
  if (!existsSync(dir)) return 'absent';
  return readdirSync(dir).sort().map((name) => {
    const stat = statSync(join(dir, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
}

for (const [label, scriptName, shell] of [
  ['the Bash setup script', 'local-runtime-setup.sh', bashShell],
  ['the PowerShell setup script', 'local-runtime-setup.ps1', powershellShell],
] as const) {
  test(`${label} bootstraps a runnable stack, keeps every existing secret, and starts nothing`, () => {
    if (shell === null) { console.log(`        (skipped: no interpreter on this host can run ${scriptName})`); return; }
    const before = repoSecretsFingerprint();
    const ws = stageSetupWorkspace(scriptName);
    try {
      const first = assertBootstrapped(label, ws, runSetup(shell, ws, scriptName));

      // Re-running is the dangerous case: a regenerated token locks an operator out of a running stack.
      // Sentinels prove preservation rather than mere byte-equality of two identical generations.
      for (const name of RUNTIME_SECRETS) writeFileSync(join(ws, 'secrets', name), `kept-${name}\n`);
      const second = runSetup(shell, ws, scriptName);
      for (const name of RUNTIME_SECRETS) {
        assertEq(readFileSync(join(ws, 'secrets', name), 'utf8'), `kept-${name}\n`, `${label}: ${name} survives a re-run untouched`);
        assert(second.includes(`${name} (already exists)`), `${label}: the re-run says ${name} was kept`);
      }
      assert(second.includes('kept-operator_ui_token'), `${label}: the re-run prints the token that is actually in force`);
      assert(!second.includes(first.operator_ui_token!), `${label}: and not the one it generated the first time`);
    } finally { rmSync(ws, { recursive: true, force: true }); }
    assertEq(repoSecretsFingerprint(), before, `${label}: a staged run never touches the repository's own ./secrets`);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------------------------------------

// Two different capabilities, and conflating them produces a test that skips when it should run or hangs when
// it should skip. Rendering a compose file is pure client-side parsing; building and running a stack needs a
// live daemon, which a machine with the CLI installed may well not have.
function dockerCliAvailable(): boolean {
  return spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32' }).status === 0;
}
function dockerDaemonAvailable(): boolean {
  return spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32' }).status === 0;
}

await test('docker compose accepts the runtime stack as written', () => {
  if (!dockerCliAvailable()) { console.log('        (skipped: the Docker CLI is not installed on this host)'); return; }
  const secretsPresent = (() => { try { readFileSync(`${root}/secrets/operator_ui_token`); return true; } catch { return false; } })();
  if (!secretsPresent) { console.log('        (skipped: run ./deploy/local-runtime-setup.sh first to materialise ./secrets)'); return; }
  const config = spawnSync('docker', ['compose', '-f', 'docker-compose.runtime.yml', 'config'], { cwd: root, encoding: 'utf8', timeout: 180000, shell: process.platform === 'win32' });
  assertEq(config.status, 0, `docker compose config succeeds: ${config.stderr ?? ''}`);
  const rendered = config.stdout ?? '';
  assert(/promotion-records["']?:\s*$|promotion-records/.test(rendered), 'the artifact mount survives rendering');
  assert(rendered.includes('read_only: true'), 'hardening survives rendering');
  assert(/mode:\s*ro|read_only:\s*true/.test(rendered), 'the artifact mount is read-only in the rendered config');
});

await test('end-to-end: the container stack serves the chain behind the token', async () => {
  if (!dockerDaemonAvailable()) { console.log('        (skipped: no running Docker daemon on this host -- the CLI alone cannot build or start a stack)'); return; }
  if (process.env.PHASE244_DOCKER_SMOKE !== '1') {
    console.log('        (skipped: set PHASE244_DOCKER_SMOKE=1 to build and run the container stack; it takes minutes)');
    return;
  }
  const compose = (args: readonly string[], timeout = 900000) =>
    spawnSync('docker', ['compose', '-f', 'docker-compose.runtime.yml', ...args], { cwd: root, encoding: 'utf8', timeout, shell: process.platform === 'win32' });
  const up = compose(['up', '-d', '--build']);
  assertEq(up.status, 0, `stack starts: ${up.stderr ?? ''}`);
  try {
    const token = readFileSync(`${root}/secrets/operator_ui_token`, 'utf8').trim();
    let health = 0;
    for (let i = 0; i < 60 && health !== 200; i++) {
      try { health = (await httpGet(8099, '/healthz')).statusCode; } catch { health = 0; }
      if (health !== 200) await new Promise((r) => setTimeout(r, 2000));
    }
    assertEq(health, 200, 'the container reports healthy');
    assertEq((await httpGet(8099, '/api/promotion-chain')).statusCode, 401, 'the route is authenticated in the container');
    const res = await httpGet(8099, '/api/promotion-chain', token);
    const body = JSON.parse(res.body) as { availability: string; view: { overall: string } | null };
    assertEq(body.availability, 'READABLE', 'the mounted folder is readable in the container');
    assert(body.view === null || body.view.overall !== 'AUDIT_CLOSED', 'and nothing is ever reported as closed by accident');
    const page = await httpGet(8099, '/');
    assert(page.body.includes('Promotion Record Chain'), 'the panel is served from the container');
  } finally { compose(['down', '-v'], 300000); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
