import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureJellyfinLiveEvidence } from '../src/ops/jellyfin-live-evidence-capture.js';
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

const SECRET = 'PHASE211-SUPER-SECRET-JELLYFIN-KEY';
const REF_VALUE = 'phase211-secret-ref-value';
const HOST = 'jellyfin-private-hostname';

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

function fixtureEnv(dir: string, overrides: Env = {}): Env {
  const keyFile = path.join(dir, 'jellyfin_api_key');
  writeFileSync(keyFile, `${SECRET}\n`, 'utf8');
  return {
    JELLYFIN_ENABLE_NETWORK: 'true',
    JELLYFIN_BASE_URL: `http://${HOST}:8096`,
    JELLYFIN_API_KEY_FILE: keyFile,
    ...overrides,
  };
}

function noLeak(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes(SECRET)
    && !text.includes(REF_VALUE)
    && !text.includes(HOST)
    && !text.includes('opaque-jellyfin-item-id')
    && !text.includes('192.168.');
}

console.log('Running Phase 211 Jellyfin live evidence capture suite:\n');

await test('phase record defines guarded save command without claiming live capture', () => {
  const doc = read('docs/PHASE_211_JELLYFIN_LIVE_EVIDENCE_CAPTURE_COMMAND.md');
  for (const required of [
    'phase-211-jellyfin-live-evidence-capture-command',
    'JELLYFIN_LIVE_EVIDENCE_CAPTURE_COMMAND_READY_SECRET_BLOCKED',
    'LIVE_EVIDENCE_CAPTURE_COMMAND_READY_AWAITING_SECRET',
    'f376a5c',
    'phase-210',
    'JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING',
    'npm run ops:jellyfin-live-evidence-capture --',
    '--out /mnt/user/appdata/catalog/evidence/phase-211-jellyfin-live-readonly-smoke.json',
    'does not claim live evidence has been captured',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('capture command writes redaction-safe Phase 209 evidence and summary', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-live-211-'));
  try {
    const outFile = path.join(dir, 'evidence', 'phase-211.json');
    const transport = new RecordingTransport();
    const result = await captureJellyfinLiveEvidence({
      env: fixtureEnv(dir),
      fetch: transport.fetch,
      ref: { type: 'tmdb', value: REF_VALUE },
      outFile,
      now: () => new Date('2026-07-13T12:30:00.000Z'),
    });
    assert(result.ok, 'capture ok');
    assertEq(result.report, 'phase-211-jellyfin-live-evidence-capture', 'capture report id');
    assertEq(result.smokeReport, 'phase-209-jellyfin-live-readonly-smoke', 'smoke report id');
    assertEq(result.smokeStatus, 'JELLYFIN_LIVE_READONLY_SMOKE_PASS', 'smoke pass');
    assert(result.evidenceDigest.length === 64, 'digest emitted');
    assert(result.bytesWritten > 0, 'bytes written');
    assert(existsSync(outFile), 'evidence file exists');
    const saved = JSON.parse(readFileSync(outFile, 'utf8')) as { report: string; ok: boolean; evidenceDigest: string };
    assertEq(saved.report, 'phase-209-jellyfin-live-readonly-smoke', 'saved phase 209 report');
    assertEq(saved.ok, true, 'saved report ok');
    assertEq(saved.evidenceDigest, result.evidenceDigest, 'summary digest matches saved report');
    assert(noLeak(result), 'summary redaction-safe');
    assert(noLeak(saved), 'saved evidence redaction-safe');
    assert(transport.requests.every((request) => request.method === 'GET'), 'only GET requests');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('missing or unsafe secret configuration fails before writing evidence', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-live-211-missing-'));
  try {
    for (const [name, env] of [
      ['missing file', { JELLYFIN_ENABLE_NETWORK: 'true', JELLYFIN_BASE_URL: `http://${HOST}:8096`, JELLYFIN_API_KEY_FILE: path.join(dir, 'missing') }],
      ['direct key', fixtureEnv(dir, { JELLYFIN_API_KEY: SECRET })],
      ['write mode', fixtureEnv(dir, { JELLYFIN_ALLOW_LIVE_PUBLISH: 'true' })],
    ] as const) {
      const outFile = path.join(dir, `${name.replace(/\s+/g, '-')}.json`);
      let err: unknown;
      try {
        await captureJellyfinLiveEvidence({ env, fetch: async () => ok({}), ref: { type: 'tmdb', value: REF_VALUE }, outFile });
      } catch (caught) { err = caught; }
      assert(err instanceof Error, `${name} rejected`);
      assert(!existsSync(outFile), `${name} wrote no evidence`);
      assert(noLeak((err as Error).message), `${name} rejection redaction-safe`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('package, deploy guard, and README wire Phase 211 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['ops:jellyfin-live-evidence-capture'] === 'tsx src/ops/jellyfin-live-evidence-capture-cli.ts', 'ops script present');
  assert(pkg.scripts['test:jellyfin-live-evidence-capture'] === 'tsx test/jellyfin-live-evidence-capture.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 211 Jellyfin live evidence capture command'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_LIVE_EVIDENCE_CAPTURE_COMMAND_READY_SECRET_BLOCKED'), 'deploy guard status');
  assert(readme.includes('Phase 211 adds `docs/PHASE_211_JELLYFIN_LIVE_EVIDENCE_CAPTURE_COMMAND.md`'), 'README ledger entry');
});

await test('phase record is redaction-safe and preserves deferred launch state', () => {
  const doc = read('docs/PHASE_211_JELLYFIN_LIVE_EVIDENCE_CAPTURE_COMMAND.md');
  for (const required of [
    'Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE`',
    'Phase 210 remains `JELLYFIN_LIVE_EVIDENCE_BLOCKED_SECRET_MISSING`',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
    'LAUNCH_WARNING_O5_DEFERRED_ACCEPTED',
  ]) assert(doc.includes(required), `status includes ${required}`);
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

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

