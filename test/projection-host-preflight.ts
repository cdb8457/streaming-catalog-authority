import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  CONSUMER_NEEDS_TRAVERSAL_OF_THE_RUN_DIRECTORY, HOST_REQUIREMENTS,
  RSHARED_REQUIRES_A_SHARED_SOURCE_MOUNT, TRAVERSABLE_MODE, checkPropagation, mountFor, parseMountInfo,
  traversalProblems,
} from '../src/core/projection/host-preflight.js';

// Projection Phase 1 — the offline half of the HOST preflight.
//
// WHAT THIS SUITE IS FOR, AND WHY IT MATTERS MORE THAN MOST. Every media-server gate in this repository has
// only ever run on Windows / Docker Desktop, which `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6 says closes
// NONE of G7-G13. The tranche closes on a Linux or Unraid host. So every host-shaped assumption the gates make
// is currently untested in the one environment that counts — and Docker Desktop actively hides the whole class,
// because its bind sources sit inside a VM whose root is already shared and it ignores uid, gid and mode.
//
// A host-shaped defect therefore produces a green run here, every time, forever.
//
// SO THE AWKWARD HOSTS ARE TESTED AS DATA. An Unraid `shfs` share, a private root, a mount that is
// shared-and-slave at once, a path with a space in it, a host with no mount table at all: each is a string,
// each is checked from this machine, and none of them has to be present.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1; console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1; failures.push([name, error]); console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

console.log('Projection Phase 1 — host preflight (offline)');

// ---------------------------------------------------------------------------------------------------------
// Real mountinfo shapes
// ---------------------------------------------------------------------------------------------------------

/** A systemd host: `/` is remounted shared during early boot, which is why this usually just works. */
const SYSTEMD_ROOT = [
  '25 0 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
  '26 25 0:5 / /dev rw,nosuid shared:2 - devtmpfs devtmpfs rw',
  '31 25 0:28 / /sys/fs/cgroup ro,nosuid shared:9 - cgroup2 cgroup2 rw',
].join('\n');

/**
 * An Unraid-shaped host. Two things are true of it at once and both matter:
 * `/` is **private**, because Unraid is not systemd; and `/mnt/user` is `shfs`, a FUSE share, also private.
 */
const UNRAID = [
  '20 1 0:19 / / rw,relatime - overlay rootfs rw',
  '30 20 0:33 / /mnt/disk1 rw,noatime - xfs /dev/md1 rw',
  '31 20 0:34 / /mnt/user rw,noatime - fuse.shfs /dev/shfs rw',
  '32 20 0:35 / /mnt/cache rw,noatime - btrfs /dev/nvme0n1p1 rw',
].join('\n');

test('a systemd host, whose root is shared, is allowed', () => {
  const check = checkPropagation('/home/op/streaming-catalog-authority/.projection-emby-gate', SYSTEMD_ROOT);
  assertEq(check.verdict, 'shared', 'a shared root permits an rshared bind');
  assertEq(check.mountPoint, '/', 'and the mount it found is the root');
  assertEq(check.problem, '', 'with nothing to report');
});

test('an Unraid checkout under /mnt/user is REFUSED, with the remedy named', () => {
  // THIS IS THE MOST LIKELY FIRST FAILURE OF THE FIRST UNRAID RUN, and no Docker Desktop run could ever have
  // revealed it: there the bind source lives inside a VM whose root is already shared.
  const check = checkPropagation('/mnt/user/appdata/streaming-catalog-authority/.projection-plex-gate', UNRAID);
  assertEq(check.verdict, 'not-shared', 'the daemon container would be refused outright');
  assertEq(check.mountPoint, '/mnt/user', 'and the LONGEST matching mount is named, not the root');
  assertEq(check.filesystem, 'fuse.shfs', 'as the FUSE share it actually is');
  assert(check.problem.includes('mount --make-rshared /mnt/user'),
    'and the remedy names the exact mount, so it can be acted on rather than researched');
  assert(check.problem.includes('deliberately not'), 'while making clear the gate will not do it for you');
});

test('an Unraid checkout on the private ROOT is refused too, and names the root', () => {
  const check = checkPropagation('/root/streaming-catalog-authority/.projection-jellyfin-gate', UNRAID);
  assertEq(check.verdict, 'not-shared', 'a private root is just as fatal as a private share');
  assertEq(check.mountPoint, '/', 'and it is the root that has to be made shared');
});

test('the LONGEST matching mount wins, which is the whole reason to parse the table', () => {
  // `/` is a prefix of every path. A first-match scan would answer the propagation question about the root
  // filesystem every time there is a nested mount — which on Unraid is always.
  const entries = parseMountInfo(UNRAID);
  assertEq(mountFor('/mnt/user/appdata/x', entries)?.mountPoint, '/mnt/user', 'nested mount wins over root');
  assertEq(mountFor('/mnt/cache/x', entries)?.mountPoint, '/mnt/cache', 'and so does a sibling');
  assertEq(mountFor('/opt/x', entries)?.mountPoint, '/', 'and the root still catches everything else');
});

test('a prefix is matched on path boundaries, not on characters', () => {
  // `/mnt/userdata` is NOT inside `/mnt/user`, and a naive startsWith says it is — which would report the
  // propagation of the wrong filesystem, confidently.
  const entries = parseMountInfo(UNRAID);
  assertEq(mountFor('/mnt/userdata/x', entries)?.mountPoint, '/', 'a longer sibling name is not a child');
  assertEq(mountFor('/mnt/user', entries)?.mountPoint, '/mnt/user', 'and the mount point itself matches');
});

test('a mount that is shared AND a slave counts as shared', () => {
  // `shared:2 master:1` is a mount that receives from its master and propagates onward. For the only question
  // this module asks — may a bind from it be rshared — that mount IS shared. Reading the tags in the wrong
  // order would refuse a host that works.
  const entries = parseMountInfo('40 25 0:40 / /srv rw,relatime shared:2 master:1 - ext4 /dev/sdb1 rw');
  assertEq(entries[0]?.propagation, 'shared', 'shared wins over master');
  assertEq(checkPropagation('/srv/gate', '40 25 0:40 / /srv rw shared:2 master:1 - ext4 /dev/sdb1 rw')
    .verdict, 'shared', 'and the check agrees');
});

test('a slave-only mount is not shared, and an unbindable one is refused too', () => {
  const slave = '41 25 0:41 / /slv rw,relatime master:1 - ext4 /dev/sdc1 rw';
  assertEq(parseMountInfo(slave)[0]?.propagation, 'slave', 'master without shared is a slave');
  assertEq(checkPropagation('/slv/x', slave).verdict, 'not-shared', 'which cannot carry an rshared bind');
  const unbindable = '42 25 0:42 / /ub rw,relatime unbindable - ext4 /dev/sdd1 rw';
  assertEq(parseMountInfo(unbindable)[0]?.propagation, 'unbindable', 'and unbindable is its own thing');
  assertEq(checkPropagation('/ub/x', unbindable).verdict, 'not-shared', 'and is equally fatal');
});

test('the optional-tag count varies, so the " - " separator is the only landmark', () => {
  // Zero tags, one, and three. A parser that indexed fields from the left for `fstype` would read the
  // filesystem of a mount with tags as one of its tags — and would do it silently.
  const lines = [
    '20 1 0:19 / /none rw - ext4 /dev/sda1 rw',
    '21 1 0:20 / /one rw shared:1 - xfs /dev/sdb1 rw',
    '22 1 0:21 / /three rw shared:2 master:1 propagate_from:1 - btrfs /dev/sdc1 rw',
  ].join('\n');
  const entries = parseMountInfo(lines);
  assertEq(entries.length, 3, 'all three parse');
  assertEq(entries[0]?.filesystem, 'ext4', 'no tags');
  assertEq(entries[1]?.filesystem, 'xfs', 'one tag');
  assertEq(entries[2]?.filesystem, 'btrfs', 'three tags — the filesystem is still read correctly');
  assertEq(entries[0]?.propagation, 'private', 'and no tags means private');
});

test('an octal-escaped mount point is unescaped, because this gate lives among paths with spaces', () => {
  // The kernel writes a space as `\040`. Every media file this gate generates has spaces in its name, and a
  // checkout under a directory with one is not exotic. Unescaped, the prefix match would simply never fire.
  const entries = parseMountInfo('50 25 0:50 / /mnt/My\\040Share rw shared:1 - ext4 /dev/sde1 rw');
  assertEq(entries[0]?.mountPoint, '/mnt/My Share', 'the escape is decoded');
  assertEq(checkPropagation('/mnt/My Share/gate', '50 25 0:50 / /mnt/My\\040Share rw shared:1 - ext4 /d rw')
    .verdict, 'shared', 'and the path matches it');
});

test('a malformed line is skipped rather than guessed at', () => {
  // A line invented as `private` by default would be a fabricated reason to refuse a host that is fine.
  const entries = parseMountInfo([
    'this is not a mountinfo line',
    '',
    '25 0 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
    'short - ext4 x rw',
  ].join('\n'));
  assertEq(entries.length, 1, 'only the well-formed line is read');
  assertEq(entries[0]?.mountPoint, '/', 'and it is read correctly');
});

test('UNDETERMINED is a third answer, and it is not a pass', () => {
  // A Windows host has no /proc/self/mountinfo, and the gates demonstrably pass there. A check that treated
  // absence as failure would break the only environment this has ever run in, to enforce a rule about an
  // environment it has never run in. A check that treated absence as success would bless a host nobody looked
  // at. So: three values.
  for (const absent of [undefined, '', '   \n  ']) {
    const check = checkPropagation('/anywhere', absent);
    assertEq(check.verdict, 'undetermined', 'no mount table means undetermined');
    assert(check.problem.includes('not a check that passed'),
      'and it says so in exactly those terms, so a transcript cannot be misread');
  }
  // A table that exists but contains nothing matching is also undetermined rather than refused: that should
  // be impossible on Linux, and inventing a verdict from it would be inventing a reason.
  assertEq(checkPropagation('/x', '99 1 0:1 / /somewhere-else rw - ext4 /dev/x rw').verdict, 'undetermined',
    'a table with no containing mount cannot speak for the path');
});

test('the finding this module exists for is recorded', () => {
  assert(RSHARED_REQUIRES_A_SHARED_SOURCE_MOUNT, 'the kernel rule is stated');
  const source = read('src/core/projection/host-preflight.ts');
  assert(source.includes('Unraid is not systemd'), 'and why Unraid in particular is exposed to it');
  assert(source.includes('DIAGNOSES AND IT DOES NOT REPAIR'),
    'and that the gate will not mutate an operator\'s host to make itself pass');
});

// ---------------------------------------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------------------------------------

test('a permissive leaf under a private parent is caught', () => {
  // THE DEFECT, EXACTLY. The gates chmod 777 the leaves the container writes into; those leaves are reached
  // THROUGH the run root, which `mkdir -p` created under the operator's umask. At 077 it is 0700 and uid 1000
  // cannot traverse it, however permissive the leaf is.
  assert(CONSUMER_NEEDS_TRAVERSAL_OF_THE_RUN_DIRECTORY, 'the finding is recorded');
  const problems = traversalProblems([
    { path: '/gate-root', mode: 0o700 },
    { path: '/gate-root/run-1/out', mode: 0o777 },
  ]);
  assertEq(problems.length, 1, 'the parent is the problem, not the leaf');
  assert(problems[0]?.includes('/gate-root'), 'and it is named');
  assert(problems[0]?.includes('however permissive it is'),
    'with the reason a reader would otherwise miss: the leaf being 777 does not help');
});

test('the mode the gates set is traversable, and 0750 is not', () => {
  assertEq(traversalProblems([{ path: '/x', mode: TRAVERSABLE_MODE }]).length, 0, '0755 traverses');
  assertEq(traversalProblems([{ path: '/x', mode: 0o777 }]).length, 0, 'and so does 0777');
  assertEq(traversalProblems([{ path: '/x', mode: 0o711 }]).length, 0, 'and 0711, which is enough');
  // OWNER-EXECUTE SAYS NOTHING ABOUT A CONTAINER UID THAT IS SOMEBODY ELSE, and group-execute only helps if
  // the uid happens to be in the group — which is not something the gate arranges or could rely on.
  assertEq(traversalProblems([{ path: '/x', mode: 0o750 }]).length, 1, 'group-execute alone is not enough');
  assertEq(traversalProblems([{ path: '/x', mode: 0o700 }]).length, 1, 'nor is owner-execute alone');
  assertEq(traversalProblems([{ path: '/x', mode: 0o644 }]).length, 1, 'and read without execute is not it');
});

test('the traversal check is three-valued too, and its own first run is why', () => {
  // ON WINDOWS, NODE REPORTS EVERY DIRECTORY AS 666 — no execute bit for anybody, because NTFS has none to
  // report. Judged as a POSIX mode that reads as "no container uid could ever traverse this", and the check
  // failed all three gates on the one host they demonstrably pass on. It was enforcing a rule about Linux by
  // breaking Windows, which is the shape of defect this whole module exists to stop.
  assertEq(traversalProblems([{ path: '/x', mode: 0o666 }]).length, 1,
    'as a POSIX mode, 666 genuinely is untraversable — the pure function is right');
  const cli = read('src/ops/projection-host-preflight-cli.ts');
  assert(cli.includes("process.platform === 'win32'"),
    '...so the CLI, not the pure function, is what declines to judge a host with no POSIX modes');
  assert(cli.includes('not a check that passed'),
    'and says it did not run rather than passing quietly');
});

// ---------------------------------------------------------------------------------------------------------
// The gates actually run it
// ---------------------------------------------------------------------------------------------------------

const GATES = ['jellyfin', 'plex', 'emby'] as const;

test('all three gates run the preflight, and BEFORE they build or start anything', () => {
  for (const server of GATES) {
    const gate = read(`deploy/projection-${server}-dataplane-gate.sh`);
    assert(gate.includes('projection-host-preflight-cli.ts propagation --path "$GATE_ROOT" --require'),
      `${server}: the propagation check runs, and --require makes a not-shared answer fatal`);
    assert(gate.includes('projection-host-preflight-cli.ts traversal --path "$GATE_ROOT" --path "$WORK"'),
      `${server}: and the traversal check covers both directories a container reaches through`);
    // BEFORE THE EXPENSIVE PART. A gate that learns its host cannot host it AFTER building an image,
    // migrating a database and encoding four minutes of video has wasted the operator's time to find out
    // something it could have said in a second.
    const preflightAt = gate.indexOf('projection-host-preflight-cli.ts propagation');
    const buildAt = gate.indexOf('docker build -t "$IMAGE"');
    assert(preflightAt > 0 && buildAt > 0, `${server}: both landmarks are findable`);
    assert(preflightAt < buildAt, `${server}: the preflight runs before the image build`);
  }
});

test('all three gates make the run directory traversable rather than inheriting a umask', () => {
  for (const server of GATES) {
    const gate = read(`deploy/projection-${server}-dataplane-gate.sh`);
    assert(gate.includes('chmod 755 "$GATE_ROOT" "$WORK"'),
      `${server}: the path a container reaches through is made traversable explicitly`);
    // 0755 RATHER THAN 0777, because traversal is all that is needed and the writable leaves are already
    // 0777. Widening a parent that does not need to be writable would be doing more than the problem asks.
    assert(!/chmod 777 "\$GATE_ROOT"/.test(gate), `${server}: and not made writable, which it need not be`);
    assert(gate.includes('umask'), `${server}: and the reason — the umask — is stated where it is done`);
  }
});

test('all three gates can tell a warm playback window from a bypassed daemon', () => {
  // A DEFECT FOUND BY RUNNING A GATE, NOT BY READING IT, AND IT WAS ONLY IN ONE OF THE THREE.
  //
  // Each gate's playback traffic windows once asserted an unconditional floor of one provider request, on the
  // reasoning that a window which never reached the provider must have been served by something other than
  // the daemon. A daemon repair falsified that: once a handle release stopped deleting the playback cache, an
  // object that fits in memory is served from memory on every later open. Plex diagnosed it and replaced its
  // floors; Emby inherited the replacement. **Jellyfin was never re-run against the repaired daemon**, kept
  // the invalidated inference, and failed at `JD18-paced-play-traffic-range-requests-floor` measuring 0
  // against 1 — in a run where independent decoders proved 300 s of real playback.
  //
  // The floor was not dropped anywhere. A zero-provider window has to be EXPLAINED by the daemon's own
  // cumulative playback-cache counters over exactly that window.
  for (const server of GATES) {
    const gate = read(`deploy/projection-${server}-dataplane-gate.sh`);
    const cli = read(`src/ops/projection-${server}-dataplane-cli.ts`);
    assert(gate.includes('"statusAddr": "127.0.0.1:9099"'),
      `${server}: the daemon publishes its status surface, on LOOPBACK only`);
    assert(gate.includes('--network "container:$MOUNT_CONTAINER"'),
      `${server}: and the reader joins the daemon's namespace rather than a port being published for it`);
    for (const window of ['seeks', 'play', 'soak']) {
      assert(gate.includes(`daemon_counters "$WORK/out/daemon-before-${window}.json"`),
        `${server}: the ${window} window snapshots the daemon before it`);
      assert(gate.includes(`daemon_counters "$WORK/out/daemon-after-${window}.json"`), `${server}: and after`);
      assert(gate.includes(`--daemon-before "$REL/out/daemon-before-${window}.json"`),
        `${server}: and hands them to the ${window} assertion`);
    }
    assert(cli.includes('range-requests-warm-capable'),
      `${server}: a zero-provider window is judged on daemon cache evidence`);
    assert(cli.includes('warm-daemon-cache-hit-bytes'),
      `${server}: on BYTES as well as hits, since a hit count alone cannot separate a served window from one `
      + 'trivial read');
    assert(cli.includes('provider-counters-coherent'),
      `${server}: and a FALLEN provider counter is a broken instrument rather than a warm window`);
    // THE COLD ARM MUST BE UNCHANGED. A window that did reach the provider is still held to the original
    // floor, under its original name, so a cold run's verdicts do not move.
    assert(cli.includes('range-requests-floor'), `${server}: the cold floor survives under its own name`);
  }
});

test('the host requirements name the one that will strand an Unraid operator', () => {
  const node = HOST_REQUIREMENTS.find((requirement) => requirement.id === 'node');
  assert(node !== undefined, 'Node.js on the host is listed as a requirement');
  assert(node.why.includes('stock Unraid installation has no Node.js'),
    'and says plainly that the tranche-closing host does not have it by default');
  for (const id of ['docker-compose-v2', 'dev-fuse', 'shared-mount', 'no-selinux-relabel']) {
    assert(HOST_REQUIREMENTS.some((requirement) => requirement.id === id), `${id} is listed`);
  }
  // EVERY REQUIREMENT CARRIES A COMMAND, so a runbook can be checked rather than read.
  for (const requirement of HOST_REQUIREMENTS) {
    assert(requirement.probe.trim() !== '', `${requirement.id} carries a probe an operator can run`);
    assert(requirement.why.trim() !== '', `${requirement.id} says why it is needed`);
  }
});

test('package, inventory and the aggregate run are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-host-preflight'], 'tsx test/projection-host-preflight.ts', 'test script');
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-host-preflight.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as {
    suites: Array<{ file: string; group: string }>;
  };
  const entry = inventory.suites.find((suite) => suite.file === 'projection-host-preflight.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry?.group, 'offline', 'and needs no database');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`\n${name}\n  ${(error as Error).stack ?? error}`);
  process.exit(1);
}
