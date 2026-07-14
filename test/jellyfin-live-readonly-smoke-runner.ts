import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJellyfinLiveReadOnlySmoke } from '../src/ops/jellyfin-live-readonly-smoke.js';
import type { Env } from '../src/config/env.js';
import type { FetchLike, HttpRequestInit, HttpResponseLike } from '../src/core/adapters/jellyfin/transport.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const ok = (body: unknown): HttpResponseLike => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const status = (code: number): HttpResponseLike => ({ ok: code >= 200 && code < 300, status: code, json: async () => ({}), text: async () => '' });

const SECRET = 'PHASE209-SUPER-SECRET-JELLYFIN-KEY';
const REF_VALUE = 'phase209-secret-ref-value';
const HOST = 'jellyfin-private-hostname';
const tmp = mkdtempSync(path.join(tmpdir(), 'jf-live-209-'));
const keyFile = path.join(tmp, 'jellyfin_api_key');
writeFileSync(keyFile, `${SECRET}\n`, 'utf8');

class RecordingTransport {
  readonly requests: Array<{ method: string; path: string; url: string; headers: Record<string, string> }> = [];
  constructor(private readonly opts: { failSystemInfo?: boolean } = {}) {}
  readonly fetch: FetchLike = async (url: string, init?: HttpRequestInit): Promise<HttpResponseLike> => {
    const method = init?.method ?? 'GET';
    const u = new URL(url);
    this.requests.push({ method, path: u.pathname, url, headers: init?.headers ?? {} });
    if (method === 'GET' && u.pathname === '/System/Info') return this.opts.failSystemInfo ? status(401) : ok({ ServerName: 'fixture', Version: '10.fixture' });
    if (method === 'GET' && u.pathname === '/Items') return ok({ Items: [{ Id: 'opaque-jellyfin-item-id', ProviderIds: { Tmdb: REF_VALUE } }] });
    return status(405);
  };
}

function env(overrides: Env = {}): Env {
  return {
    JELLYFIN_ENABLE_NETWORK: 'true',
    JELLYFIN_BASE_URL: `http://${HOST}:8096`,
    JELLYFIN_API_KEY_FILE: keyFile,
    ...overrides,
  };
}

function noLeak(value: unknown): boolean {
  const text = JSON.stringify(value);
  return !text.includes(SECRET)
    && !text.includes(REF_VALUE)
    && !text.includes(HOST)
    && !text.includes('opaque-jellyfin-item-id')
    && !text.includes('192.168.');
}

console.log('Running Phase 209 Jellyfin live read-only smoke runner suite:\n');

await test('phase record defines the live read-only runner without capture or install', () => {
  const doc = read('docs/PHASE_209_JELLYFIN_LIVE_READONLY_SMOKE_RUNNER.md');
  for (const required of [
    'phase-209-jellyfin-live-readonly-smoke-runner',
    'JELLYFIN_LIVE_READONLY_SMOKE_RUNNER_READY',
    'LIVE_READONLY_SMOKE_RUNNER_READY_NO_EVIDENCE_CAPTURED',
    '447c4ec',
    'phase-208',
    'http://<unraid-host>:8096',
    'npm run ops:jellyfin-live-readonly-smoke -- --ref-type <type> --ref-value <value>',
    'requires `JELLYFIN_API_KEY_FILE`',
    'refuses direct `JELLYFIN_API_KEY`',
    'refuses `JELLYFIN_ALLOW_LIVE_PUBLISH=true`',
    'does not claim that live evidence has been captured',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('runner performs only read-only Jellyfin requests and emits redaction-safe evidence', async () => {
  const transport = new RecordingTransport();
  const report = await runJellyfinLiveReadOnlySmoke({
    env: env(),
    fetch: transport.fetch,
    ref: { type: 'tmdb', value: REF_VALUE },
    now: () => new Date('2026-07-13T12:00:00.000Z'),
  });
  assert(report.ok, 'report ok');
  assertEq(report.report, 'phase-209-jellyfin-live-readonly-smoke', 'report id');
  assertEq(report.status, 'JELLYFIN_LIVE_READONLY_SMOKE_PASS', 'pass status');
  assertEq(report.target.port, 8096, 'port captured');
  assertEq(report.target.hostEchoed, false, 'host not echoed');
  assertEq(report.credentialBoundary.apiKeySource, 'JELLYFIN_API_KEY_FILE', 'secret-file source');
  assertEq(report.credentialBoundary.apiKeyEchoed, false, 'key not echoed');
  assertEq(report.operationBoundary.writeMode, false, 'write mode false');
  assertEq(report.inputRef.valueEchoed, false, 'ref value not echoed');
  assert(report.evidenceDigest.length === 64, 'digest emitted');
  assert(noLeak(report), 'report redacts key, host, ref value, and item id');
  assertEq(transport.requests.length, 2, 'server info plus one item lookup');
  assert(transport.requests.every((r) => r.method === 'GET'), 'only GET requests');
  assertEq(transport.requests[0]!.path, '/System/Info', 'server info path');
  assertEq(transport.requests[1]!.path, '/Items', 'items path');
  assert(transport.requests.every((r) => r.headers['X-Emby-Token'] === SECRET), 'key sent only in header');
  assert(transport.requests.every((r) => !r.url.includes(SECRET)), 'key never in URL');
});

await test('runner fails safely on auth/base-url proof failure without item lookup', async () => {
  const transport = new RecordingTransport({ failSystemInfo: true });
  const report = await runJellyfinLiveReadOnlySmoke({
    env: env(),
    fetch: transport.fetch,
    ref: { type: 'tmdb', value: REF_VALUE },
  });
  assert(!report.ok, 'report not ok');
  assertEq(report.status, 'JELLYFIN_LIVE_READONLY_SMOKE_FAIL', 'fail status');
  assertEq(report.summary.fail, 1, 'one failed step');
  assertEq(transport.requests.length, 1, 'stops after system-info failure');
  assert(noLeak(report), 'failed report remains redaction-safe');
});

await test('runner refuses unsafe credential and write-mode configuration', async () => {
  for (const [name, badEnv] of [
    ['missing file', env({ JELLYFIN_API_KEY_FILE: undefined })],
    ['direct key', env({ JELLYFIN_API_KEY: SECRET })],
    ['write mode', env({ JELLYFIN_ALLOW_LIVE_PUBLISH: 'true' })],
    ['network disabled', env({ JELLYFIN_ENABLE_NETWORK: 'false' })],
  ] as const) {
    let err: unknown;
    try {
      await runJellyfinLiveReadOnlySmoke({ env: badEnv, fetch: async () => ok({}), ref: { type: 'tmdb', value: REF_VALUE } });
    } catch (caught) { err = caught; }
    assert(err instanceof Error, `${name} rejected`);
    assert(noLeak((err as Error).message), `${name} rejection is redaction-safe`);
  }
});

await test('package, deploy guard, and README wire Phase 209 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['ops:jellyfin-live-readonly-smoke'] === 'tsx src/ops/jellyfin-live-readonly-smoke-cli.ts', 'ops script present');
  assert(pkg.scripts['test:jellyfin-live-readonly-smoke-runner'] === 'tsx test/jellyfin-live-readonly-smoke-runner.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/jellyfin-live-capture-launcher.ts && tsx test/arcane-jellyfin-live-capture-button.ts && tsx test/scheduled-doctor-alert-fix.ts && tsx test/jellyfin-live-readonly-evidence-acceptance.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 209 Jellyfin live read-only smoke runner'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_LIVE_READONLY_SMOKE_RUNNER_READY'), 'deploy guard status');
  assert(readme.includes('Phase 209 adds `docs/PHASE_209_JELLYFIN_LIVE_READONLY_SMOKE_RUNNER.md`'), 'README ledger entry');
});

await test('phase record is redaction-safe and preserves deferred launch state', () => {
  const doc = read('docs/PHASE_209_JELLYFIN_LIVE_READONLY_SMOKE_RUNNER.md');
  for (const required of [
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
  ]) assert(doc.includes(required), `doc includes ${required}`);
  for (const forbidden of [
    SECRET,
    REF_VALUE,
    HOST,
    '192.168.',
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'O5_CLOSED',
    'JELLYFIN_INTEGRATION_LAUNCHED',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

