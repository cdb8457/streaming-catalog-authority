import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runWriteSmoke, formatSmokeReport, type SmokeClient } from '../src/core/adapters/jellyfin/smoke.js';
import { createRealJellyfinOutboxTarget, isJellyfinLivePublishAllowed, isJellyfinNetworkEnabled, JellyfinLivePublishDisabledError } from '../src/core/adapters/jellyfin/real-factory.js';
import type { JellyfinRef } from '../src/core/adapters/jellyfin/client.js';
import type { Env } from '../src/config/env.js';
import type { FetchLike, HttpResponseLike } from '../src/core/adapters/jellyfin/transport.js';

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
const SECRET = 'PHASE206-SUPER-SECRET-KEY';
const REF_VALUE = 'phase206-provider-ref-secret';
const JF_ITEM = 'phase206-jellyfin-item-secret';
const HANDLE = 'phase206-collection-handle-secret';
const REF: JellyfinRef = { type: 'tmdb', value: REF_VALUE };

class DisposableClient implements SmokeClient {
  readonly events: string[] = [];
  private readonly collections = new Map<string, string>();
  constructor(private readonly faults: Partial<Record<'createThenThrow' | 'delete' | 'findByToken', boolean>> = {}) {}

  async findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]> {
    this.events.push(`find:${refs.length}`);
    return [JF_ITEM];
  }

  async createTaggedCollection(name: string, itemIds: readonly string[], token: string): Promise<string> {
    this.events.push(`create:${itemIds.length}`);
    this.collections.set(HANDLE, token);
    if (this.faults.createThenThrow) throw new Error(`create lost ${SECRET}`);
    return HANDLE;
  }

  async findCollectionByToken(token: string): Promise<string | null> {
    this.events.push('find-by-token');
    if (this.faults.findByToken) throw new Error(`find token ${SECRET}`);
    for (const [handle, marker] of this.collections) if (marker === token) return handle;
    return null;
  }

  async deleteCollection(handle: string): Promise<'deleted' | 'not_found'> {
    this.events.push('delete');
    if (this.faults.delete) throw new Error(`delete ${SECRET}`);
    return this.collections.delete(handle) ? 'deleted' : 'not_found';
  }

  count(): number { return this.collections.size; }
}

const noLeak = (value: unknown): boolean => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return ![SECRET, REF_VALUE, JF_ITEM, HANDLE].some((needle) => text.includes(needle));
};

console.log('Running Phase 206 Jellyfin disposable write proof suite:\n');

await test('phase record defines disposable write gates and boundaries', () => {
  const doc = read('docs/PHASE_206_JELLYFIN_DISPOSABLE_WRITE_PROOF.md');
  for (const required of [
    'phase-206-jellyfin-disposable-write-proof',
    'JELLYFIN_DISPOSABLE_WRITE_PROOF_READY',
    '55352a1',
    'phase-204',
    '10d3355',
    'phase-205',
    'JELLYFIN_ENABLE_NETWORK=true',
    'JELLYFIN_ALLOW_LIVE_PUBLISH=true',
    'smoke:jellyfin -- --write <refType> <refValue>',
    'CLEANUP NOT CONFIRMED',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('write proof happy path creates, recovers, deletes, and verifies gone', async () => {
  const client = new DisposableClient();
  const report = await runWriteSmoke(client, REF, { newToken: () => 'phase206-token', name: 'catalog disposable smoke' });
  const formatted = formatSmokeReport(report);
  assert(report.ok, 'write proof ok');
  for (const step of ['find', 'create', 'find-by-token', 'revoke', 'verify-gone']) {
    assert(report.steps.some((s) => s.step === step && s.ok), `${step} ok`);
  }
  assertEq(client.count(), 0, 'collection cleaned up');
  assertEq(client.events.join(','), 'find:1,create:1,find-by-token,delete,find-by-token', 'expected disposable write sequence');
  assert(noLeak(report), 'structured report redacts secret values');
  assert(noLeak(formatted), 'formatted report redacts secret values');
});

await test('ambiguous create is recovered by token and cleaned up', async () => {
  const client = new DisposableClient({ createThenThrow: true });
  const report = await runWriteSmoke(client, REF, { newToken: () => 'phase206-token' });
  assert(!report.ok, 'ambiguous create still marks proof failed');
  assert(report.steps.some((s) => s.step === 'verify-gone' && s.ok && /cleaned up/.test(s.detail)), 'cleanup by token confirmed');
  assertEq(client.count(), 0, 'no collection left behind');
  assert(noLeak(report), 'ambiguous report redacts secret values');
});

await test('cleanup uncertainty fails loudly and leaves retry blocked for operator cleanup', async () => {
  const client = new DisposableClient({ delete: true });
  const report = await runWriteSmoke(client, REF, { newToken: () => 'phase206-token' });
  assert(!report.ok, 'proof failed');
  assert(report.steps.some((s) => s.step === 'verify-gone' && !s.ok && /CLEANUP NOT CONFIRMED/.test(s.detail)), 'cleanup uncertainty surfaced');
  assertEq(client.count(), 1, 'fixture models collection requiring manual cleanup');
  assert(noLeak(report), 'cleanup failure report redacts secret values');
});

await test('live write gates remain default-off and triple gated', () => {
  assertEq(isJellyfinNetworkEnabled({} as Env), false, 'network default off');
  assertEq(isJellyfinLivePublishAllowed({} as Env), false, 'live publish default off');
  let err: unknown;
  try {
    createRealJellyfinOutboxTarget((async () => ok({})) as FetchLike, {
      JELLYFIN_ENABLE_NETWORK: 'true',
      JELLYFIN_BASE_URL: 'http://jellyfin.invalid',
      JELLYFIN_API_KEY: SECRET,
    } as Env);
  } catch (e) { err = e; }
  assert(err instanceof JellyfinLivePublishDisabledError, 'outbox target requires live publish gate');

  const cli = read('src/ops/jellyfin-smoke-cli.ts');
  assert(cli.includes("args.includes('--write')"), 'CLI requires --write flag');
  assert(cli.includes('isJellyfinLivePublishAllowed'), 'CLI checks live publish gate');
  assert(cli.includes('runWriteSmoke'), 'CLI routes write proof through self-cleaning smoke');
});

await test('package, deploy guard, and README wire Phase 206 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  const readme = read('README.md');
  assert(pkg.scripts['test:jellyfin-disposable-write'] === 'tsx test/jellyfin-disposable-write.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/jellyfin-live-readonly-smoke-runner.ts && tsx test/jellyfin-live-evidence-capture-preflight.ts && tsx test/jellyfin-live-evidence-capture.ts && tsx test/jellyfin-secret-readiness.ts && tsx test/jellyfin-container-command-shape.ts && tsx test/jellyfin-secret-install-operator-packet.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 206 Jellyfin disposable write proof'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_DISPOSABLE_WRITE_PROOF_READY'), 'deploy guard status');
  assert(readme.includes('Phase 206 adds `docs/PHASE_206_JELLYFIN_DISPOSABLE_WRITE_PROOF.md`'), 'README ledger entry');
});

await test('phase record is redaction-safe and runtime-bounded', () => {
  const doc = read('docs/PHASE_206_JELLYFIN_DISPOSABLE_WRITE_PROOF.md');
  for (const forbidden of [
    SECRET,
    REF_VALUE,
    JF_ITEM,
    HANDLE,
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'wrappedHex',
    'dekBase64',
    '192.168.',
    'O5_CLOSED',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
  assert(doc.includes('No live Jellyfin write evidence is committed in this phase'), 'no live evidence claim');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
