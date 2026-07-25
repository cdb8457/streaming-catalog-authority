import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Phase 258 — the aggregate suite command, reconstructed from the inventory.
//
// WHY THIS EXISTS. Before Phase 258 the aggregate was a single `&&` chain in `package.json`, and 105 suites
// asserted against that string — most of them "my suite runs in the aggregate", several of them "my suite
// runs immediately after that other one". Those are real guarantees and every one of them is still worth
// holding; what changed is where the aggregate LIVES. It is now `test/suite-inventory.json`, and the runner
// spawns from it rather than from a shell string.
//
// So this reconstructs the same string from the inventory. The assertions keep their exact wording and their
// exact meaning — "is my suite wired in, and in the right place?" — while the thing they interrogate is the
// file that now actually decides what runs. Rewriting 105 suites to each parse the inventory would have been
// 105 opportunities to weaken an assertion; a shared derivation is one.
//
// SUITES WITH A REQUIREMENT ARE EXCLUDED, exactly as the default run excludes them. The two Docker-only
// acceptance suites were never in the old chain either, so their absence here means the same thing it always
// meant, and `test/test-runner.ts` is what asserts they are inventoried and reported rather than dropped.

interface InventorySuite {
  readonly file: string;
  readonly args?: readonly string[];
  readonly requires?: readonly string[];
}

/**
 * `tsx test/a.ts && tsx test/b.ts && …` — the suites a default `npm test` runs, in inventory order,
 * rendered in the form the pre-Phase-258 `package.json` used.
 *
 * MEMBERSHIP AND ORDER, NOT ARGUMENTS. The old chain carried each database suite's port inline, and roughly
 * ten assertions pin an ADJACENCY across such a suite (`…mapping.ts && tsx …write.ts`). Including the port
 * would break every one of them the first time a suite gained or changed one — which is a change to how a
 * suite gets its throwaway database, not to what runs or in what order. The ports are checked where they
 * matter instead: `auditInventory` refuses two suites sharing one, and `test/test-runner.ts` refuses a suite
 * that boots a database without declaring one.
 */
export const AGGREGATE_SUITE_COMMAND: string = (() => {
  const path = fileURLToPath(new URL('./suite-inventory.json', import.meta.url));
  const inventory = JSON.parse(readFileSync(path, 'utf8')) as { suites: readonly InventorySuite[] };
  return inventory.suites
    .filter((suite) => (suite.requires ?? []).length === 0)
    .map((suite) => `tsx test/${suite.file}`)
    .join(' && ');
})();
