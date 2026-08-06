import { atLeast, exactly, type GateResult } from './media-server-dataplane.js';

// Projection Phase 1 — G27, the PATH LIFECYCLE, as rules rather than as prose.
//
// WHAT G27 SAYS, VERBATIM (`docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §4): "A successor that moves a
// carried entry's path is REFUSED by admission and the namespace does not change. The retire → grace →
// delete → add sequence is then run end to end; all three servers show the removal and the addition. Whether
// a server preserves watch state across that pair is RECORDED, not asserted — this plan does not claim it."
//
// TWO HALVES, AND ONLY ONE OF THEM IS NEW. The admission-refusal half is closed offline by
// `test/projection-publisher.ts`, which builds the moved-carried-entry snapshot directly and requires the
// named problem `PATH_CHANGED_FOR_CARRIED_ENTRY`. That test is untouched and stays the authority on the
// PUBLISHER's refusal. What this file is about is the half a unit test cannot reach: the same illegal move
// forged into a real artifact under a real pointer, refused by the DAEMON, with three real media servers
// watching the namespace not change — and then the lawful four-generation sequence run end to end past them.
//
// WHY EVERY ASSERTION HERE IS A SET DIFFERENCE RATHER THAN A COUNT. "All three servers show the removal" is
// satisfied by a count that happens to drop, by a scan that returned nothing, by a stale inventory read
// twice, and by a server that removed the wrong item and added another. Counts cannot tell those apart. So
// every phase compares two INVENTORIES — path, server-assigned item id, size — and reports what entered, what
// left, and what changed identity underneath a path that stayed.

/** One catalogued item, as one server sees it. `itemId` is that server's own stable identity. */
export interface InventoryItem {
  readonly key: string;
  readonly itemId: string;
  readonly sizeBytes: number;
  readonly ordinaryFile: boolean;
  readonly problems: readonly string[];
}

/** What one server catalogued at one moment, with the generation the daemon was serving when it did. */
export interface ServerInventory {
  readonly server: string;
  readonly generationId: string;
  readonly items: readonly InventoryItem[];
}

export const LIFECYCLE_SERVERS: readonly string[] = Object.freeze(['jellyfin', 'plex', 'emby']);

export interface InventoryDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Paths present on BOTH sides whose server-assigned item id changed. */
  readonly itemIdChurn: readonly string[];
  /** Paths present on both sides whose size changed. */
  readonly sizeDrift: readonly string[];
  /** Paths carried across unchanged in every respect. */
  readonly carried: readonly string[];
}

export function diffInventories(before: ServerInventory, after: ServerInventory): InventoryDiff {
  const beforeByKey = new Map(before.items.map((item) => [item.key, item]));
  const afterByKey = new Map(after.items.map((item) => [item.key, item]));
  const added: string[] = [];
  const removed: string[] = [];
  const itemIdChurn: string[] = [];
  const sizeDrift: string[] = [];
  const carried: string[] = [];
  for (const [key, item] of afterByKey) {
    const was = beforeByKey.get(key);
    if (was === undefined) { added.push(key); continue; }
    if (was.itemId !== item.itemId) itemIdChurn.push(key);
    else if (was.sizeBytes !== item.sizeBytes) sizeDrift.push(key);
    else carried.push(key);
  }
  for (const key of beforeByKey.keys()) if (!afterByKey.has(key)) removed.push(key);
  return {
    added: added.sort(), removed: removed.sort(), itemIdChurn: itemIdChurn.sort(),
    sizeDrift: sizeDrift.sort(), carried: carried.sort(),
  };
}

/**
 * Everything that makes an inventory unusable as evidence, as problems rather than a throw.
 *
 * FAIL CLOSED, AND SAY WHICH WAY. Every phase of G27 is a statement about a DIFFERENCE, and a difference
 * against an inventory that was never taken is zero — which is exactly what "no unrelated churn" wants to
 * hear. An empty listing, a duplicated path, or a listing taken while the daemon served a different
 * generation than the gate believes are each a way for a phase to pass by not having happened.
 */
export function inventoryProblems(
  inventory: ServerInventory, expectedGenerationId: string | undefined,
): readonly string[] {
  const problems: string[] = [];
  if (!LIFECYCLE_SERVERS.includes(inventory.server)) {
    problems.push(`"${inventory.server}" is not one of the three servers G27 is about`);
  }
  if (inventory.items.length === 0) {
    problems.push('the inventory is EMPTY; a server that catalogued nothing produces a difference of zero '
      + 'against anything, which is what every "no churn" assertion wants to hear');
  }
  const seen = new Set<string>();
  for (const item of inventory.items) {
    if (seen.has(item.key)) {
      problems.push(`"${item.key}" appears twice; two items for one path is the other shape of churn and a `
        + 'set comparison hides it');
    }
    seen.add(item.key);
    if (item.itemId === '') {
      problems.push(`"${item.key}" carries no server item id, so identity churn under it cannot be measured`);
    }
  }
  if (expectedGenerationId !== undefined && inventory.generationId !== expectedGenerationId) {
    problems.push(`the daemon was serving generation ${inventory.generationId} when this was taken, not `
      + `${expectedGenerationId}; the listing describes a different world than the phase believes`);
  }
  return problems;
}

function coherence(gate: string, inventories: readonly ServerInventory[],
  expectedGenerationId: string | undefined): GateResult {
  const problems: string[] = [];
  for (const server of LIFECYCLE_SERVERS) {
    const found = inventories.find((inventory) => inventory.server === server);
    if (found === undefined) {
      // A MISSING SERVER IS NOT A QUIET PASS. G27 says ALL THREE, and two of three is not that.
      problems.push(`${server} produced no inventory at all, and G27 is about all three servers`);
      continue;
    }
    for (const problem of inventoryProblems(found, expectedGenerationId)) {
      problems.push(`${server}: ${problem}`);
    }
  }
  return problems.length === 0
    ? { gate: `${gate}-inventories-coherent`, verdict: 'pass', measured: 0, budget: 0,
      note: `all three servers listed a non-empty, duplicate-free inventory${expectedGenerationId === undefined
        ? '' : ` while the daemon served ${expectedGenerationId}`}` }
    : { gate: `${gate}-inventories-coherent`, verdict: 'fail', measured: problems.length, budget: 0,
      note: problems.join('; ') };
}

const byServer = (inventories: readonly ServerInventory[], server: string): ServerInventory | undefined =>
  inventories.find((inventory) => inventory.server === server);

/** The seed: all three servers catalogue path A, exactly once, as an ordinary file. */
export function seedResults(
  gate: string, inventories: readonly ServerInventory[],
  options: { readonly pathA: string; readonly generationId: string },
): readonly GateResult[] {
  const results: GateResult[] = [coherence(gate, inventories, options.generationId)];
  if (results[0]?.verdict === 'fail') return results;
  for (const server of LIFECYCLE_SERVERS) {
    const inventory = byServer(inventories, server) as ServerInventory;
    const matches = inventory.items.filter((item) => item.key === options.pathA);
    results.push(exactly(`${gate}-seeded:${server}`, matches.length, 1,
      'the seeded path is catalogued exactly once — zero means the sequence never started, and two means '
      + 'the server has already duplicated it'));
    const problems = matches[0]?.problems ?? ['the item is absent'];
    results.push(exactly(`${gate}-ordinary-file:${server}`, problems.length, 0,
      problems.length === 0 ? 'and as an ordinary file, through this server\'s own predicate'
        : problems.join('; ')));
  }
  return results;
}

/**
 * The illegal move: refused, with NOTHING having moved anywhere.
 *
 * THE POINTER IS HALF THE EVIDENCE AND THE SERVERS ARE THE OTHER HALF. A daemon that refused the artifact but
 * advanced its pointer would have accepted it in the only sense that matters; three servers that saw no
 * change while the daemon quietly served a moved path would mean the servers had not looked.
 */
export function refusalResults(
  gate: string, before: readonly ServerInventory[], after: readonly ServerInventory[],
  options: {
    readonly generationBefore: string; readonly generationAfter: string;
    readonly pathA: string; readonly pathB: string;
  },
): readonly GateResult[] {
  const results: GateResult[] = [coherence(`${gate}-after`, after, options.generationAfter)];
  if (results[0]?.verdict === 'fail') return results;

  results.push(exactly(`${gate}-generation-unchanged`,
    options.generationAfter === options.generationBefore ? 0 : 1, 0,
    'the daemon is still serving the generation it was serving before the illegal successor was published. '
    + 'A pointer that advanced accepted the move in the only sense that matters'));

  for (const server of LIFECYCLE_SERVERS) {
    const diff = diffInventories(byServer(before, server) as ServerInventory,
      byServer(after, server) as ServerInventory);
    results.push(exactly(`${gate}-added:${server}`, diff.added.length, 0,
      diff.added.length === 0 ? 'nothing appeared' : `these appeared: ${diff.added.join(', ')}`));
    results.push(exactly(`${gate}-removed:${server}`, diff.removed.length, 0,
      diff.removed.length === 0 ? 'and nothing vanished' : `these vanished: ${diff.removed.join(', ')}`));
    results.push(exactly(`${gate}-item-id-churn:${server}`, diff.itemIdChurn.length, 0,
      'and no carried path was re-created under a new server id, which would lose everything attached to it'));
    // THE MOVED PATH MUST NOT EXIST ANYWHERE, which is the specific thing the refusal is about.
    const inventory = byServer(after, server) as ServerInventory;
    results.push(exactly(`${gate}-moved-path-absent:${server}`,
      inventory.items.filter((item) => item.key === options.pathB).length, 0,
      'the destination of the refused move is not in the namespace'));
    results.push(exactly(`${gate}-original-path-present:${server}`,
      inventory.items.filter((item) => item.key === options.pathA).length, 1,
      'and the original is still exactly where it was'));
  }
  return results;
}

/**
 * Retiring, and then the grace deadline passing.
 *
 * THE SECOND HALF IS THE ONE WITH TEETH. G5 says a retiring entry's grace deadline passing changes nothing;
 * an implementation that swept on a timer would pass every assertion about the retirement itself and fail
 * here, and only here.
 */
export function stillPresentResults(
  gate: string, before: readonly ServerInventory[], after: readonly ServerInventory[],
  options: { readonly pathA: string; readonly generationId: string; readonly readable: boolean },
): readonly GateResult[] {
  const results: GateResult[] = [coherence(gate, after, options.generationId)];
  if (results[0]?.verdict === 'fail') return results;

  for (const server of LIFECYCLE_SERVERS) {
    const inventory = byServer(after, server) as ServerInventory;
    results.push(exactly(`${gate}-present:${server}`,
      inventory.items.filter((item) => item.key === options.pathA).length, 1,
      'the path is still catalogued'));
    const diff = diffInventories(byServer(before, server) as ServerInventory, inventory);
    results.push(exactly(`${gate}-churn:${server}`,
      diff.added.length + diff.removed.length + diff.itemIdChurn.length, 0,
      diff.added.length + diff.removed.length + diff.itemIdChurn.length === 0
        ? 'and nothing else moved either'
        : `added ${diff.added.join(',')} removed ${diff.removed.join(',')} churned ${diff.itemIdChurn.join(',')}`));
  }
  results.push(exactly(`${gate}-readable`, options.readable ? 1 : 0, 1,
    'and the bytes still come back through the mount — a retiring entry that is listed but unreadable is '
    + 'a deletion the namespace has not admitted to'));
  return results;
}

/** The explicit deletion: exactly path A leaves, on all three, with nothing else touched. */
export function deletionResults(
  gate: string, before: readonly ServerInventory[], after: readonly ServerInventory[],
  options: { readonly pathA: string; readonly generationId: string },
): readonly GateResult[] {
  const results: GateResult[] = [coherence(gate, after, options.generationId)];
  if (results[0]?.verdict === 'fail') return results;

  for (const server of LIFECYCLE_SERVERS) {
    const diff = diffInventories(byServer(before, server) as ServerInventory,
      byServer(after, server) as ServerInventory);
    results.push(exactly(`${gate}-removed-exactly-one:${server}`, diff.removed.length, 1,
      diff.removed.length === 1 ? `the server observed the removal of ${diff.removed[0]}`
        : `it removed ${diff.removed.length}: ${diff.removed.join(', ')}`));
    results.push(exactly(`${gate}-removed-the-right-one:${server}`,
      diff.removed[0] === options.pathA ? 0 : 1, 0,
      'and it is the path the deletion generation named, not some other one'));
    results.push(exactly(`${gate}-added:${server}`, diff.added.length, 0,
      'a deletion adds nothing'));
    results.push(exactly(`${gate}-item-id-churn:${server}`, diff.itemIdChurn.length, 0,
      'and every surviving path keeps the identity it already had'));
  }
  return results;
}

/** The corrected path arrives as an ADDITION: exactly path B enters, on all three, and it is real. */
export function additionResults(
  gate: string, before: readonly ServerInventory[], after: readonly ServerInventory[],
  options: {
    readonly pathB: string; readonly generationId: string;
    readonly sizeBytes: number; readonly digestMatched: boolean;
  },
): readonly GateResult[] {
  const results: GateResult[] = [coherence(gate, after, options.generationId)];
  if (results[0]?.verdict === 'fail') return results;

  for (const server of LIFECYCLE_SERVERS) {
    const inventory = byServer(after, server) as ServerInventory;
    const diff = diffInventories(byServer(before, server) as ServerInventory, inventory);
    results.push(exactly(`${gate}-added-exactly-one:${server}`, diff.added.length, 1,
      diff.added.length === 1 ? `the server observed the addition of ${diff.added[0]}`
        : `it added ${diff.added.length}: ${diff.added.join(', ')}`));
    results.push(exactly(`${gate}-added-the-right-one:${server}`,
      diff.added[0] === options.pathB ? 0 : 1, 0,
      'at the corrected path, not somewhere else'));
    results.push(exactly(`${gate}-removed:${server}`, diff.removed.length, 0,
      'an addition removes nothing'));
    results.push(exactly(`${gate}-item-id-churn:${server}`, diff.itemIdChurn.length, 0,
      'and nothing that survived was re-created underneath its path'));

    const arrived = inventory.items.find((item) => item.key === options.pathB);
    results.push(exactly(`${gate}-ordinary-file:${server}`, arrived?.problems.length ?? 1, 0,
      arrived === undefined ? 'the added path is not in the inventory at all'
        : arrived.problems.length === 0 ? 'catalogued as an ordinary file, through this server\'s own predicate'
          : arrived.problems.join('; ')));
    results.push(exactly(`${gate}-size:${server}`, arrived?.sizeBytes ?? -1, options.sizeBytes,
      'at the size the control plane published'));
  }
  results.push(exactly(`${gate}-digest`, options.digestMatched ? 1 : 0, 1,
    'and the bytes read back through the mount match the digest recorded OUTSIDE it, before anything was '
    + 'published. A catalogue entry of the right size proves nothing about the bytes underneath it'));
  return results;
}

/**
 * Watch state across delete → add. RECORDED, ASSERTED BY NOTHING.
 *
 * THE PLAN REFUSES TO CLAIM THIS AND SO DOES THIS FUNCTION. A delete followed by an add is two operations on
 * two identities; whether a given server carries a play position, a watched flag or a user rating across them
 * is that server's business and this product has never promised it. The number is worth having — it is the
 * kind of thing an operator will ask about — and it is worth having ONLY if nobody can mistake it for a
 * guarantee, so the verdict is always `pass` and no budget is attached.
 */
export function watchStateObservations(
  gate: string, observations: readonly { readonly server: string; readonly preserved: boolean | undefined;
    readonly detail: string }[],
): readonly GateResult[] {
  return observations.map((observation) => ({
    gate: `${gate}-watch-state:${observation.server}`,
    verdict: 'pass' as const,
    note: `RECORDED, ASSERTED BY NOTHING — ${observation.preserved === undefined
      ? 'not determinable on this server' : observation.preserved ? 'preserved' : 'not preserved'}`
      + ` across delete+add: ${observation.detail}. The acceptance plan does not claim watch state survives `
      + 'a delete and an add, and neither does this gate',
  }));
}

/**
 * The sequence really ran: four generations, in order, each admitted.
 *
 * WITHOUT THIS, EVERY DIFFERENCE ABOVE IS A DIFFERENCE BETWEEN TWO IDENTICAL WORLDS. A gate whose publishes
 * silently no-oped would find nothing added and nothing removed at every step and report a clean lifecycle.
 */
export function sequenceResults(
  gate: string, generations: readonly string[],
): readonly GateResult[] {
  const distinct = new Set(generations.filter((id) => id !== ''));
  return [
    atLeast(`${gate}-generations-observed`, distinct.size, 4,
      'the daemon served four DISTINCT generations across the lifecycle — seed, retire, delete, add. A '
      + 'sequence whose publishes no-oped would compare a world against itself at every step and find it '
      + 'unchanged, which is what every assertion here wants to hear'),
    exactly(`${gate}-generations-empty`, generations.filter((id) => id === '').length, 0,
      'and the gate knew which generation was being served at every observation'),
  ];
}
