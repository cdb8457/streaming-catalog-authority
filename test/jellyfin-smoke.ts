import { runReadOnlySmoke, runWriteSmoke, formatSmokeReport, type SmokeClient } from '../src/core/adapters/jellyfin/smoke.js';
import type { JellyfinRef } from '../src/core/adapters/jellyfin/client.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
const step = (r: { steps: Array<{ step: string; ok: boolean; detail: string }> }, name: string) => r.steps.find((s) => s.step === name);
let seq = 0;
const KEY = 'SUPER-SECRET-API-KEY';

/** In-memory fake Jellyfin client for the smoke logic. Injects failures + a duplicate/leftover scenario. */
class FakeSmokeClient implements SmokeClient {
  private readonly collections = new Map<string, string>(); // handle -> name(with marker)
  private counter = 0;
  constructor(private readonly library: Record<string, string> = {}, private readonly faults: Partial<Record<'find' | 'create' | 'findByToken' | 'delete', boolean>> = {}, private readonly leaveDuplicate = false) {}
  async findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]> {
    if (this.faults.find) throw new Error(`boom ${KEY}`); // a leaky error message
    const out: string[] = []; for (const r of refs) { const id = this.library[`${r.type}:${r.value}`]; if (id) out.push(id); } return out;
  }
  async createTaggedCollection(name: string, _itemIds: readonly string[], _token: string): Promise<string> {
    if (this.faults.create) throw new Error(`create boom ${KEY}`);
    const h = `col-${++this.counter}`; this.collections.set(h, name);
    if (this.leaveDuplicate) this.collections.set(`col-${++this.counter}`, name); // a same-token duplicate remains
    return h;
  }
  async findCollectionByToken(token: string): Promise<string | null> {
    if (this.faults.findByToken) throw new Error(`find boom ${KEY}`);
    for (const [h, n] of this.collections) if (n.includes(`[cat:${token}]`)) return h; return null;
  }
  async deleteCollection(handle: string): Promise<'deleted' | 'not_found'> {
    if (this.faults.delete) throw new Error(`delete boom ${KEY}`);
    return this.collections.delete(handle) ? 'deleted' : 'not_found';
  }
}
const REF: JellyfinRef = { type: 'tmdb', value: '603' };
const tok = () => `smoke-tok-${++seq}`;
const noSecret = (r: { steps: Array<{ detail: string }> }): boolean => !JSON.stringify(r).includes(KEY);
// the created collection name embeds the token marker so findByToken works:
class TaggingClient extends FakeSmokeClient {
  override async createTaggedCollection(name: string, itemIds: readonly string[], token: string): Promise<string> {
    return super.createTaggedCollection(`${name} [cat:${token}]`, itemIds, token);
  }
}

async function main(): Promise<void> {
  console.log('Running Phase 13 Jellyfin smoke-report suite (Stage 13.2, fake client):\n');

  await test('read-only smoke — reports the matched count; find failure is redaction-safe', async () => {
    const okR = await runReadOnlySmoke(new TaggingClient({ 'tmdb:603': 'item-1' }), REF);
    assert(okR.ok && /1 library item/.test(step(okR, 'find')!.detail), 'find ok with count');
    const badR = await runReadOnlySmoke(new TaggingClient({}, { find: true }), REF);
    assert(!badR.ok && !step(badR, 'find')!.ok, 'find failure surfaced'); assert(noSecret(badR), 'no api key in the report');
  });

  await test('write smoke — happy round-trip: create, find-by-token, delete, verify gone', async () => {
    const r = await runWriteSmoke(new TaggingClient({ 'tmdb:603': 'item-1' }), REF, { newToken: tok });
    assert(r.ok, 'all steps ok');
    for (const s of ['find', 'create', 'find-by-token', 'revoke', 'verify-gone']) assert(step(r, s)?.ok, `${s} ok`);
    assert(/no-duplicate/.test(step(r, 'verify-gone')!.detail), 'verify-gone documents the no-duplicate proof');
  });

  await test('write smoke — create failure fails closed (no round-trip), redaction-safe', async () => {
    const r = await runWriteSmoke(new TaggingClient({ 'tmdb:603': 'item-1' }, { create: true }), REF, { newToken: tok });
    assert(!r.ok && !step(r, 'create')!.ok, 'create failed'); assert(step(r, 'find-by-token') === undefined, 'no further steps after create failure'); assert(noSecret(r), 'no api key leaked');
  });

  await test('write smoke — cleanup that CANNOT be confirmed is flagged loudly (never silent)', async () => {
    // delete throws -> cleanup not confirmed
    const r = await runWriteSmoke(new TaggingClient({ 'tmdb:603': 'item-1' }, { delete: true }), REF, { newToken: tok });
    assert(!r.ok, 'report not ok'); assert(!step(r, 'verify-gone')!.ok && /CLEANUP NOT CONFIRMED/.test(step(r, 'verify-gone')!.detail), 'cleanup uncertainty surfaced');
    assert(noSecret(r), 'no api key leaked in the cleanup error');
  });

  await test('write smoke — a lingering same-token duplicate is caught by verify-gone', async () => {
    const r = await runWriteSmoke(new TaggingClient({ 'tmdb:603': 'item-1' }, {}, true), REF, { newToken: tok });
    assert(!step(r, 'verify-gone')!.ok && /remains/.test(step(r, 'verify-gone')!.detail), 'a leftover same-token collection is flagged');
  });

  await test('formatSmokeReport — renders redaction-safe lines', async () => {
    const r = await runWriteSmoke(new TaggingClient({ 'tmdb:603': 'item-1' }, { create: true }), REF, { newToken: tok });
    const text = formatSmokeReport(r);
    assert(/FAIL create/.test(text) && !text.includes(KEY), 'text shows the failure without leaking the key');
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('\nFailures:'); for (const [n, e] of failures) console.log(`  - ${n}: ${(e as Error).stack ?? e}`); process.exit(1); }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
