import type { JellyfinClient } from '../src/core/adapters/jellyfin/client.js';

/**
 * Phase 11 — shared JellyfinClient behavioral contract. Run against BOTH the Phase 10
 * FakeJellyfinClient and the Phase 11 real client (over a fixture transport) to prove behavioral
 * parity — the same expectations must hold regardless of implementation. Exported (no `main`) so it
 * is never executed on import; each test file supplies its own harness + `make`.
 */
export interface ContractHarness {
  test(name: string, fn: () => Promise<void> | void): Promise<void>;
  assert(cond: unknown, msg: string): void;
  assertEq(a: unknown, b: unknown, msg: string): void;
}

/** `make(library)` returns a client whose "server" knows exactly the given `"type:value" -> itemId` refs. */
export async function runJellyfinClientContract(
  label: string,
  h: ContractHarness,
  make: (library: Record<string, string>) => JellyfinClient,
): Promise<void> {
  await h.test(`${label} — findItemsByRefs matches known refs and drops unknown`, async () => {
    const c = make({ 'tmdb:603': 'item-a', 'imdb:tt0133093': 'item-b' });
    h.assertEq((await c.findItemsByRefs([{ type: 'tmdb', value: '603' }])).join(','), 'item-a', 'known tmdb');
    h.assertEq((await c.findItemsByRefs([{ type: 'tmdb', value: 'nope' }])).length, 0, 'unknown dropped');
    const mixed = await c.findItemsByRefs([{ type: 'tmdb', value: '603' }, { type: 'imdb', value: 'tt0133093' }, { type: 'tmdb', value: 'x' }]);
    h.assertEq([...mixed].sort().join(','), 'item-a,item-b', 'matched subset only');
  });

  await h.test(`${label} — no refs / no matches -> empty match set`, async () => {
    const c = make({ 'tmdb:1': 'a' });
    h.assertEq((await c.findItemsByRefs([])).length, 0, 'no refs');
    h.assertEq((await c.findItemsByRefs([{ type: 'imdb', value: 'ttX' }])).length, 0, 'no match');
  });

  await h.test(`${label} — create then delete, then delete again -> not_found`, async () => {
    const c = make({ 'tmdb:1': 'a', 'tmdb:2': 'b' });
    const ids = await c.findItemsByRefs([{ type: 'tmdb', value: '1' }, { type: 'tmdb', value: '2' }]);
    const handle = await c.createCollection('My Collection', ids);
    h.assert(typeof handle === 'string' && handle.length > 0, 'created collection returns an opaque handle');
    h.assertEq(await c.deleteCollection(handle), 'deleted', 'first delete -> deleted');
    h.assertEq(await c.deleteCollection(handle), 'not_found', 'second delete -> not_found');
  });
}
