import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import { findRedactionProblems } from '../src/core/projection/media-server-dataplane.js';
import {
  LIFECYCLE_SERVERS, additionResults, deletionResults, diffInventories, inventoryProblems, refusalResults,
  seedResults, sequenceResults, stillPresentResults, watchStateObservations,
  type ServerInventory,
} from '../src/core/projection/path-lifecycle.js';

// Projection Phase 1 — G27's three-server half, refused offline.
//
// WHAT THIS SUITE IS FOR. The gate itself needs a Linux host, a FUSE mount and three real media servers, so
// it runs rarely and slowly. Every RULE it applies lives in `src/core/projection/path-lifecycle.ts` and can
// be attacked here in milliseconds. So each test below builds the world in which the gate SHOULD fail and
// requires that it does — because a gate that cannot fail is not evidence, it is decoration.
//
// THE ATTACKS ARE THE FAILURE MODES THIS PARTICULAR GATE INVITES, not a generic list. A path-lifecycle gate
// is unusually easy to pass for the wrong reason: almost every assertion is about something being ABSENT, and
// absence is what you also get from a scan that never ran, a server that was never asked, an inventory read
// twice, and a publish that silently no-oped.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const repoFile = (path: string): string => readFileSync(join(HERE, '..', path), 'utf8');

let passed = 0;
let failed = 0;
const failures: [string, unknown][] = [];

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push([name, error]);
    console.log(`FAIL  ${name}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------------------------------------
// A world builder, so each attack differs from the honest run in exactly one way
// ---------------------------------------------------------------------------------------------------------

const PATH_A = 'A.bin';
const PATH_B = 'B.bin';
const SIZE_A = 6291456;
const SIZE_B = 7340032;

interface Spec { readonly key: string; readonly itemId: string; readonly sizeBytes?: number }

/** One inventory per server, all three agreeing, which is what an honest observation looks like. */
function world(generationId: string, items: readonly Spec[],
  overrides: Partial<Record<string, readonly Spec[]>> = {}): ServerInventory[] {
  return LIFECYCLE_SERVERS.map((server) => ({
    server,
    generationId,
    items: (overrides[server] ?? items).map((spec) => ({
      key: spec.key,
      itemId: spec.itemId,
      sizeBytes: spec.sizeBytes ?? (spec.key === PATH_B ? SIZE_B : SIZE_A),
      ordinaryFile: true,
      problems: [],
    })),
  }));
}

// THE BYSTANDER IS IN EVERY WORLD, exactly as it is in every generation the gate publishes. It is what makes
// "nothing else changed" a claim about a world that still contains something, and what makes a zero-work scan
// distinguishable from a correct deletion: without it, the world after the deletion is empty, and an empty
// listing is what a scan that never ran also produces.
const BYSTANDER: Spec = { key: 'C.bin', itemId: 'ic' };
const AT_A: readonly Spec[] = [{ key: PATH_A, itemId: 'ia' }, BYSTANDER];
const AT_B: readonly Spec[] = [{ key: PATH_B, itemId: 'ib' }, BYSTANDER];
const NOTHING: readonly Spec[] = [BYSTANDER];

const failedGates = (results: readonly { gate: string; verdict: string }[]): string[] =>
  results.filter((result) => result.verdict === 'fail').map((result) => result.gate);

const refuses = (results: readonly { gate: string; verdict: string }[], why: string): void => {
  assert(failedGates(results).length > 0, why);
};

async function main(): Promise<void> {
  console.log('\nprojection path lifecycle (G27, three-server half)\n');

  // -------------------------------------------------------------------------------------------------------
  // The honest run passes. Without this, every test below is satisfied by a module that fails everything.
  // -------------------------------------------------------------------------------------------------------

  await test('THE HONEST LIFECYCLE PASSES END TO END', () => {
    const seed = world('1', AT_A);
    const retired = world('2', AT_A);
    const deleted = world('3', NOTHING);
    const added = world('4', AT_B);
    const all = [
      ...seedResults('L1', seed, { pathA: PATH_A, generationId: '1' }),
      ...refusalResults('L2', seed, seed,
        { generationBefore: '1', generationAfter: '1', pathA: PATH_A, pathB: PATH_B }),
      ...stillPresentResults('L3', seed, retired, { pathA: PATH_A, generationId: '2', readable: true }),
      ...deletionResults('L5', retired, deleted, { pathA: PATH_A, generationId: '3' }),
      ...additionResults('L6', deleted, added,
        { pathB: PATH_B, generationId: '4', sizeBytes: SIZE_B, digestMatched: true }),
      ...sequenceResults('L8', ['1', '2', '3', '4']),
    ];
    assert(failedGates(all).length === 0, `an honest lifecycle failed: ${failedGates(all).join(', ')}`);
    assert(all.length > 30, 'and it is not a handful of assertions pretending to be a gate');
  });

  // -------------------------------------------------------------------------------------------------------
  // The attacks
  // -------------------------------------------------------------------------------------------------------

  await test('AN ILLEGAL MOVE THAT WAS ACCEPTED IS REFUSED', () => {
    // The defect: the daemon admits a successor that relocates a carried entry. The namespace now shows B
    // where it showed A, and no deletion and no addition was ever published. This is THE thing G27 exists to
    // forbid, and a gate that only checked "three servers still have one item each" would pass it.
    const before = world('1', AT_A);
    const moved = world('2', AT_B);
    refuses(refusalResults('L2', before, moved,
      { generationBefore: '1', generationAfter: '2', pathA: PATH_A, pathB: PATH_B }),
    'a moved carried entry was admitted and the gate said nothing');
  });

  await test('A POINTER THAT ADVANCED IS REFUSED EVEN IF THE NAMESPACE HAPPENS NOT TO HAVE MOVED YET', () => {
    // A daemon that accepted the artifact but had not yet re-projected it is still a daemon that accepted it.
    // Waiting a little longer would have shown the move; the gate must not depend on having waited long
    // enough, so the pointer is evidence in its own right.
    const before = world('1', AT_A);
    refuses(refusalResults('L2', before, world('2', AT_A),
      { generationBefore: '1', generationAfter: '2', pathA: PATH_A, pathB: PATH_B }),
    'the served generation advanced past a forged successor and the gate accepted it');
  });

  await test('A GRACE-BASED DISAPPEARANCE IS REFUSED', () => {
    // The defect this phase exists for: an implementation that sweeps retiring entries when their grace
    // deadline passes. Every assertion about the retirement itself still holds; only this one bites.
    refuses(stillPresentResults('L4-past-grace', world('2', AT_A), world('2', NOTHING),
      { pathA: PATH_A, generationId: '2', readable: true }),
    'the entry vanished when its grace deadline passed and the gate called that fine');
  });

  await test('A RETIRING ENTRY THAT IS LISTED BUT UNREADABLE IS REFUSED', () => {
    // Listed-but-unreadable is a deletion the namespace has not admitted to. A server would catalogue it and
    // a player would fail on it, which is worse than an honest removal.
    refuses(stillPresentResults('L3', world('2', AT_A), world('2', AT_A),
      { pathA: PATH_A, generationId: '2', readable: false }),
    'the bytes stopped coming back and the gate only checked the listing');
  });

  await test('A DELETION THAT NO SERVER OBSERVED IS REFUSED', () => {
    refuses(deletionResults('L5', world('2', AT_A), world('3', AT_A),
      { pathA: PATH_A, generationId: '3' }),
    'the deletion generation was published and nothing left, and the gate passed');
  });

  await test('A DELETION THAT ONLY SOME SERVERS OBSERVED IS REFUSED', () => {
    // "All three servers show the removal" is the clause. Two out of three is a failure, and the failing
    // gate must NAME the server, so an operator is not left diffing three inventories by hand.
    const after = world('3', NOTHING, { emby: AT_A });
    const bad = failedGates(deletionResults('L5', world('2', AT_A), after,
      { pathA: PATH_A, generationId: '3' }));
    assert(bad.length > 0, 'one server never observed the deletion and the gate passed');
    assert(bad.some((gate) => gate.endsWith(':emby')), `the failure must name the server; got ${bad.join(',')}`);
  });

  await test('A DELETION THAT REMOVED THE WRONG PATH IS REFUSED', () => {
    // A count-based gate cannot tell this from a correct deletion: one item left in both worlds.
    const before = world('2', [{ key: PATH_A, itemId: 'ia' }, { key: 'other.bin', itemId: 'io' }]);
    const after = world('3', [{ key: PATH_A, itemId: 'ia' }, BYSTANDER]);
    refuses(deletionResults('L5', before, after, { pathA: PATH_A, generationId: '3' }),
      'the wrong path was removed and the count still dropped by exactly one');
  });

  await test('AN ADDITION THAT NEVER ARRIVED IS REFUSED', () => {
    refuses(additionResults('L6', world('3', NOTHING), world('4', NOTHING),
      { pathB: PATH_B, generationId: '4', sizeBytes: SIZE_B, digestMatched: true }),
    'the corrected path was published and never appeared, and the gate passed');
  });

  await test('AN ADDITION WHOSE BYTES DO NOT MATCH THE SOURCE IS REFUSED', () => {
    // The digest is recorded OUTSIDE the mount before anything is published, so this catches a namespace
    // that produced a file of the right name and the right length and the wrong contents.
    refuses(additionResults('L6', world('3', NOTHING), world('4', AT_B),
      { pathB: PATH_B, generationId: '4', sizeBytes: SIZE_B, digestMatched: false }),
    'the projected bytes did not match the source and the gate only checked the listing');
  });

  await test('AN ADDITION AT THE WRONG SIZE IS REFUSED', () => {
    refuses(additionResults('L6', world('3', NOTHING), world('4', [{ key: PATH_B, itemId: 'ib', sizeBytes: 1 }, BYSTANDER]),
      { pathB: PATH_B, generationId: '4', sizeBytes: SIZE_B, digestMatched: true }),
    'the server catalogued the addition at a size the source never had');
  });

  await test('UNRELATED CHURN ALONGSIDE A CORRECT DELETION IS REFUSED', () => {
    // "Exactly the removal of path A" — a deletion that also silently dropped and re-added a bystander is
    // not exactly that, and on a real library it is how a rescan quietly loses somebody's watch history.
    const before = world('2', [{ key: PATH_A, itemId: 'ia' }, { key: 'other.bin', itemId: 'io' }]);
    const after = world('3', [{ key: 'other.bin', itemId: 'DIFFERENT' }, BYSTANDER]);
    refuses(deletionResults('L5', before, after, { pathA: PATH_A, generationId: '3' }),
      'a bystander changed identity underneath an unchanged path and the gate passed');
  });

  await test('UNRELATED CHURN ALONGSIDE A CORRECT ADDITION IS REFUSED', () => {
    const before = world('3', [{ key: 'other.bin', itemId: 'io' }, BYSTANDER]);
    const after = world('4', [{ key: 'other.bin', itemId: 'io' }, { key: PATH_B, itemId: 'ib' },
      { key: 'surprise.bin', itemId: 'is' }, BYSTANDER]);
    refuses(additionResults('L6', before, after,
      { pathB: PATH_B, generationId: '4', sizeBytes: SIZE_B, digestMatched: true }),
    'something else arrived with the addition and the gate passed');
  });

  await test('A STALE SERVER INVENTORY IS REFUSED', () => {
    // The subtlest failure available here: the gate triggers a scan, the server does not finish it, and the
    // listing that comes back is the PREVIOUS one. Every phase would then compare a world against itself.
    // The generation stamp is what discriminates: an inventory is tagged with the generation it was taken
    // under, and one carrying the wrong stamp is not evidence about this generation.
    const stale: ServerInventory[] = world('4', AT_B).map((inventory, index) =>
      (index === 0 ? { ...inventory, generationId: '3' } : inventory));
    refuses(additionResults('L6', world('3', NOTHING), stale,
      { pathB: PATH_B, generationId: '4', sizeBytes: SIZE_B, digestMatched: true }),
    'an inventory taken under a different generation was read as fresh');
  });

  await test('A ZERO-WORK SCAN IS REFUSED AT THE SEED, BEFORE ANYTHING ELSE CAN BE MEASURED', () => {
    // An empty inventory satisfies every later "it is gone" assertion. It has to die at the first phase.
    refuses(seedResults('L1', world('1', NOTHING), { pathA: PATH_A, generationId: '1' }),
      'no server catalogued anything and the gate started the lifecycle anyway');
    assert(inventoryProblems({ server: 'plex', generationId: '1', items: [] }, '1').length > 0,
      'and an empty inventory is a problem in its own right, not merely a small one');
  });

  await test('A DUPLICATED PATH IS REFUSED', () => {
    // Two catalogue entries for one projected path means a later "exactly one removal" can be satisfied
    // while the path is still visible.
    const duplicated = world('1', [{ key: PATH_A, itemId: 'ia' }, { key: PATH_A, itemId: 'ia2' }, BYSTANDER]);
    refuses(seedResults('L1', duplicated, { pathA: PATH_A, generationId: '1' }),
      'a server catalogued the same projected path twice and the gate accepted it');
    assert(inventoryProblems(duplicated[0] as ServerInventory, '1').some((p) => /appears twice/.test(p)),
      'and the problem says which failure it is');
  });

  await test('A MISSING SERVER IS REFUSED, NOT SILENTLY AVERAGED OVER', () => {
    // The failure mode: one server never came up, its inventory is absent, and a gate that iterated over
    // whatever it was given would report a clean two-server lifecycle as a three-server pass.
    const twoOfThree = world('3', NOTHING).filter((inventory) => inventory.server !== 'plex');
    refuses(deletionResults('L5', world('2', AT_A), twoOfThree, { pathA: PATH_A, generationId: '3' }),
      'a server was missing entirely and the gate proceeded on the other two');
  });

  await test('A LIFECYCLE WHOSE PUBLISHES ALL NO-OPED IS REFUSED', () => {
    // Every difference this gate measures is a difference between two worlds. If no generation was ever
    // admitted, every phase compares one world against itself, finds nothing added and nothing removed, and
    // reports a clean lifecycle. This is the assertion that makes all the others mean something.
    refuses(sequenceResults('L8', ['1', '1', '1', '1']),
      'the same generation was served throughout and the gate called it a four-step lifecycle');
    refuses(sequenceResults('L8', ['1', '2', '', '4']),
      'the gate did not know what was being served at one of its observations');
  });

  // -------------------------------------------------------------------------------------------------------
  // Watch state: recorded, and structurally incapable of being asserted
  // -------------------------------------------------------------------------------------------------------

  await test('WATCH STATE CANNOT FAIL THE GATE, WHICHEVER WAY IT COMES OUT', () => {
    // The plan says RECORDED, NOT ASSERTED, and this is the mechanism rather than the intention: the
    // function has no budget and no comparison, so there is no value of `preserved` that produces a failure.
    // The risk being closed is a later edit that "tightens" this into a real assertion, at which point the
    // product would be claiming something it has never promised — that a delete and an add preserve a play
    // position — and a correct server that reassigns item ids would fail an acceptance gate.
    for (const preserved of [true, false, undefined]) {
      const results = watchStateObservations('L7', LIFECYCLE_SERVERS.map((server) => ({
        server, preserved, detail: 'measured',
      })));
      assert(results.length === LIFECYCLE_SERVERS.length, 'every server is recorded');
      assert(results.every((result) => result.verdict === 'pass'),
        `watch state produced a non-pass verdict for preserved=${String(preserved)}`);
      assert(results.every((result) => result.measured === undefined && result.budget === undefined),
        'a measurement with a budget is an assertion wearing a different hat');
      assert(results.every((result) => /ASSERTED BY NOTHING/.test(result.note ?? '')),
        'and the report says so where an operator will read it');
    }
  });

  await test('THE GATE SCRIPT DOES NOT ASSERT WATCH STATE EITHER', () => {
    const gate = repoFile('deploy/projection-path-lifecycle-gate.sh');
    assert(/RECORDED, NEVER ASSERTED/.test(gate), 'the phase says what it is');
    assert(!/die .*watch/i.test(gate), 'and no watch-state observation can kill the run');
  });

  // -------------------------------------------------------------------------------------------------------
  // The diff primitive itself
  // -------------------------------------------------------------------------------------------------------

  await test('THE DIFF DISTINGUISHES THE FOUR THINGS A COUNT CANNOT', () => {
    const before: ServerInventory = { server: 'plex', generationId: '1', items: [
      { key: 'kept.bin', itemId: 'k', sizeBytes: 10, ordinaryFile: true, problems: [] },
      { key: 'churned.bin', itemId: 'old', sizeBytes: 10, ordinaryFile: true, problems: [] },
      { key: 'drifted.bin', itemId: 'd', sizeBytes: 10, ordinaryFile: true, problems: [] },
      { key: 'gone.bin', itemId: 'g', sizeBytes: 10, ordinaryFile: true, problems: [] },
    ] };
    const after: ServerInventory = { server: 'plex', generationId: '2', items: [
      { key: 'kept.bin', itemId: 'k', sizeBytes: 10, ordinaryFile: true, problems: [] },
      { key: 'churned.bin', itemId: 'new', sizeBytes: 10, ordinaryFile: true, problems: [] },
      { key: 'drifted.bin', itemId: 'd', sizeBytes: 99, ordinaryFile: true, problems: [] },
      { key: 'fresh.bin', itemId: 'f', sizeBytes: 10, ordinaryFile: true, problems: [] },
    ] };
    const diff = diffInventories(before, after);
    assert(diff.added.join() === 'fresh.bin', `added: ${diff.added.join()}`);
    assert(diff.removed.join() === 'gone.bin', `removed: ${diff.removed.join()}`);
    assert(diff.itemIdChurn.join() === 'churned.bin', `churn: ${diff.itemIdChurn.join()}`);
    assert(diff.sizeDrift.join() === 'drifted.bin', `drift: ${diff.sizeDrift.join()}`);
    // The count is identical in both worlds. That is the whole point.
    assert(before.items.length === after.items.length, 'and a count-based gate would have seen no change');
  });

  // -------------------------------------------------------------------------------------------------------
  // The wrapper's accounting, exercised as behaviour
  // -------------------------------------------------------------------------------------------------------

  const runWrapper = (status: number, runs: string): { code: number; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'lifecycle-wrapper-'));
    const stub = join(dir, 'stub.sh');
    writeFileSync(stub, `#!/usr/bin/env bash\nexit ${status}\n`);
    const result = spawnSync('bash', [join(HERE, '..', 'deploy/projection-path-lifecycle-gate-three.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PROJECTION_LIFECYCLE_GATE_COMMAND: stub, PROJECTION_LIFECYCLE_GATE_RUNS: runs },
    });
    return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
  };

  await test('A SKIPPED RUN IS NOT FOLDED INTO SUCCESS', () => {
    // The worst failure available to this repository is a green tranche-closing command that proved nothing.
    const { code, out } = runWrapper(77, '3');
    assert(code === 77, `a skip must propagate 77, got ${code}`);
    assert(/CLOSES NOTHING/.test(out), 'and say so where an operator reads it');
    assert(!/consecutive path-lifecycle runs completed/.test(out), 'and never print the closing message');
  });

  await test('A FAILING RUN STOPS THE SEQUENCE AT ONCE', () => {
    const { code, out } = runWrapper(1, '3');
    assert(code === 1, `a failure must propagate, got ${code}`);
    assert(/run 1 of 3/.test(out), 'and name the run it stopped at');
    assert(!/consecutive path-lifecycle runs completed/.test(out), 'without announcing a sequence');
  });

  await test('A ZERO-RUN SEQUENCE CANNOT ANNOUNCE A COMPLETED ONE', () => {
    const { code, out } = runWrapper(0, '0');
    assert(code !== 0, `zero runs must not exit 0, got ${code}`);
    assert(/refusing to report a completed sequence/.test(out), 'and must say why');
  });

  await test('THREE CLEAN RUNS DO ANNOUNCE ONE, AND STILL CLOSE NOTHING ELSE', () => {
    const { code, out } = runWrapper(0, '3');
    assert(code === 0, `three clean runs must exit 0, got ${code}`);
    assert(/3 of 3 consecutive path-lifecycle runs completed/.test(out), 'the closing message');
    assert(/no real provider endpoint has still never been contacted|never been contacted/.test(out),
      'and it still refuses Phase 1 closure on the ground that remains');
  });

  // -------------------------------------------------------------------------------------------------------
  // Cleanup, isolation and the things a gate leaks
  // -------------------------------------------------------------------------------------------------------

  await test('THE GATE CLEANS UP EVERY KIND OF THING IT CREATES', () => {
    const gate = repoFile('deploy/projection-path-lifecycle-gate.sh');
    assert(/trap cleanup EXIT/.test(gate), 'cleanup runs however the gate ends, including on a failure');
    for (const [what, pattern] of [
      ['the three media servers', /docker rm -f "\$PLEX_CONTAINER" "\$JF_CONTAINER" "\$EMBY_CONTAINER"/],
      ['the daemon', /docker rm -f "\$MOUNT_CONTAINER"/],
      ['the database', /docker compose -f "\$COMPOSE_FILE" down -v --remove-orphans/],
      ['the network', /docker network rm "\$NETWORK"/],
      ['the mount and the run directory', /projection_gate_cleanup_run "\$GATE_ROOT" "\$WORK"/],
      ['and it reports what it left behind', /projection_gate_report_cleanliness/],
    ] as const) {
      assert(pattern.test(gate), `cleanup does not remove ${what}`);
    }
    // The media servers must be removed BEFORE the unmount: each holds open handles on the mount, and a FUSE
    // mount with a live reader does not unmount cleanly.
    assert(gate.indexOf('docker rm -f "$PLEX_CONTAINER"') < gate.indexOf('projection_gate_cleanup_run'),
      'the readers must be gone before the unmount is attempted');
  });

  await test('THE GATE IS ISOLATED FROM EVERY OTHER GATE AND FROM PRODUCTION', () => {
    const gate = repoFile('deploy/projection-path-lifecycle-gate.sh');
    const compose = repoFile('docker-compose.projection-lifecycle.yml');
    // Its own port, so it can run beside the six other database Compose files rather than stealing one.
    assert(/PROJECTION_LIFECYCLE_GATE_PG_PORT:-5550/.test(compose), 'its own database port');
    assert(/name: projection-lifecycle-gate/.test(compose), 'its own Compose project name');
    // Container names carry the shell's pid, so a second copy of this gate cannot collide with it.
    for (const name of ['MOUNT_CONTAINER', 'JF_CONTAINER', 'PLEX_CONTAINER', 'EMBY_CONTAINER']) {
      assert(new RegExp(`${name}="projection-lc-[a-z]+-\\$\\$"`).test(gate),
        `${name} is not pid-scoped, so two runs could remove each other's containers`);
    }
    // And it works entirely inside its own gate root.
    assert(/GATE_ROOT="\$PWD\/\.projection-lifecycle-gate"/.test(gate), 'its own gate root');
    assert(!/\/mnt\/user\/media|appdata\/catalog\/repo/.test(gate),
      'the gate must not name a production path at all');
    // The database is throwaway: three consecutive runs mean three runs from nothing.
    assert(/tmpfs:/.test(compose) && /\/var\/lib\/postgresql\/data/.test(compose),
      'the database must not survive its container');
  });

  await test('THE GATE SKIPS RATHER THAN PASSES WHERE IT CANNOT RUN, AND SAYS SO', () => {
    const gate = repoFile('deploy/projection-path-lifecycle-gate.sh');
    assert(/GATE_SKIP_STATUS=77/.test(gate), 'the skip status is the established one');
    assert(/exit "\$GATE_SKIP_STATUS"/.test(gate), 'and a host that cannot host it exits with it');
    assert(/It is not a pass and must not be reported as one/.test(gate),
      'and the skip message refuses to be read as a pass');
  });

  await test('EVERY VERDICT IS DECIDED IN THE MODULE, NOT IN THE SHELL', () => {
    // The rule this repository keeps: shell drives the world, TypeScript decides what it meant. A threshold
    // written into the gate script would be one nothing above can attack.
    const gate = repoFile('deploy/projection-path-lifecycle-gate.sh');
    const phases = ['seed', 'refusal', 'still-there', 'deletion', 'addition', 'watch-state', 'sequence'];
    for (const phase of phases) {
      assert(new RegExp(`lifecycle ${phase} `).test(gate), `the ${phase} phase is not driven through the CLI`);
    }
  });

  await test('THE REPORT IS REDACTION-SAFE, AND THE CHECK IS THE SHARED ONE', () => {
    const results = [
      ...seedResults('L1', world('1', AT_A), { pathA: PATH_A, generationId: '1' }),
      ...sequenceResults('L8', ['1', '2', '3', '4']),
      ...watchStateObservations('L7', [{ server: 'plex', preserved: true, detail: 'measured' }]),
    ];
    const problems = findRedactionProblems(results);
    assert(problems.length === 0, `the gate's own results would leak: ${JSON.stringify(problems.slice(0, 3))}`);
    assert(repoFile('src/ops/projection-path-lifecycle-cli.ts').includes('findRedactionProblems'),
      'and the CLI applies that same check before it prints anything');
  });

  await test('THE PUBLISHER HALF OF G27 IS STILL CLOSED WHERE IT ALWAYS WAS', () => {
    // This gate proves the DAEMON refuses a forged move. It does not replace the offline proof that the
    // PUBLISHER refuses to emit one, and deleting that test while adding this gate would be a net loss.
    const publisher = repoFile('test/projection-publisher.ts');
    assert(/a relocated path is refused as a carried entry/.test(publisher),
      'the publisher-side refusal test has gone missing');
    assert(/PATH_CHANGED_FOR_CARRIED_ENTRY/.test(publisher), 'along with the named problem it requires');
  });

  await test('this suite runs in the aggregate', () => {
    assert(AGGREGATE_SUITE_COMMAND.includes('tsx test/projection-path-lifecycle.ts'),
      'a suite nobody runs is a suite that stops being true');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const [name, error] of failures) console.error(`FAILED ${name}\n  ${String(error)}`);
    process.exit(1);
  }
}

void main();
