import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  Deadline, GATE_CLIENT, MEDIA_SERVER_BUDGETS, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_POLL_INTERVAL_MS,
  TRANSCODE_SOURCE_VIDEO_CODEC, TRANSCODE_TARGET_VIDEO_CODEC, atLeast, directPlayPath, exactly,
  findRedactionProblems, forcedTranscodePath, mediaServerAuthHeader, movieLibraryRequest, opaqueRef,
  withinBudget,
} from '../src/core/projection/media-server-dataplane.js';
import { absolutePath } from '../src/ops/projection-jellyfin-dataplane.js';

// Projection Phase 1 — the offline half of the media-server data-plane gate.
//
// WHAT THIS SUITE IS FOR. The gate itself needs Docker, /dev/fuse, a real PostgreSQL and a real Jellyfin, and
// it takes minutes. This suite runs everywhere, in a second, and holds the rules the gate depends on: that
// every wait is bounded, that the request shapes are the ones that force what they claim to force, that the
// report cannot leak, and that the whole thing is wired into package, inventory and the aggregate run.
//
// IT IS NOT A SUBSTITUTE FOR THE GATE and does not pretend to be. Nothing here proves a media server can read
// a mount. What it proves is that the thing which does is correctly constructed and honestly described.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const exists = (rel: string): boolean => existsSync(`${root}/${rel}`);

/**
 * The file with its comments removed.
 *
 * A "this construct is forbidden" check must look at CODE. The first version of the assertions below read the
 * raw source and failed on the comments that explain WHY each construct is forbidden — which would have left
 * exactly two ways out: delete the explanation, or weaken the check. Both are worse than stripping comments.
 */
const readCode = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

console.log('Running projection media-server data-plane suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Deadlines — a hang is a failure
// ---------------------------------------------------------------------------------------------------------

test('every deadline is a finite, positive number of milliseconds', () => {
  const entries = Object.entries(MEDIA_SERVER_DEADLINES_MS);
  assert(entries.length >= 9, 'there is a deadline for each kind of wait');
  for (const [name, value] of entries) {
    assert(Number.isFinite(value) && value > 0, `${name} is a positive finite budget`);
    // A ceiling as well as a floor: a "deadline" of an hour is how an unbounded wait gets reintroduced with
    // a straight face.
    assert(value <= 300_000, `${name} is at most five minutes`);
  }
  assert(MEDIA_SERVER_POLL_INTERVAL_MS > 0, 'polling has an interval');
  assert(MEDIA_SERVER_POLL_INTERVAL_MS <= 5_000, 'and it is small enough to be responsive');
});

test('a deadline is absolute, and its message names the wait it blew', () => {
  const deadline = new Deadline('the library scan', 1_000, 10_000);
  assert(!deadline.expired(10_500), 'not expired before its budget');
  assert(deadline.expired(11_000), 'expired at its budget');
  assertEq(deadline.remaining(10_400), 600, 'remaining is measured from the start, not from the last poll');
  assert(deadline.message().includes('the library scan'),
    'a timeout says what it was waiting for, so a failed run is diagnosable from the log alone');
});

test('THE DRIVER HAS NO UNBOUNDED WAIT, and no timeout that cannot keep the process alive', () => {
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');

  // The one polling primitive, and every wait goes through it. The patterns are anchored to the start of a
  // statement so that a COMMENT explaining why a construct is forbidden does not itself trip the check —
  // which it did, the first time this was written.
  assert(/async function until</.test(driver), 'there is a single bounded polling helper');
  assert(!/^\s*while\s*\(\s*true\s*\)/m.test(driver + cli), 'no unbounded `while` loop in the driver or CLI');
  const loops = (driver.match(/^\s*for\s*\(;;\)/gm) ?? []).length;
  assertEq(loops, 2, 'the only infinite-form loops are `until` and the body reader, both abort-bounded');

  // A REGRESSION TEST FOR A GATE PHASE THAT EXITED 0 HAVING DONE NOTHING.
  //
  // `AbortSignal.timeout()` is backed by an UNREF'D timer. With an idle socket, `await fetch(...)` then has
  // nothing holding the event loop open, Node exits normally with status 0, and buffered stdout is lost — so
  // a phase that never ran reads to its caller exactly like one that passed. Two runs of this gate failed
  // that way before it was understood. It must not come back.
  assert(!driver.includes('AbortSignal.timeout'),
    'the driver uses an explicit AbortController behind a ref\'d setTimeout, never AbortSignal.timeout');
  assert(!cli.includes('AbortSignal.timeout'), 'and neither does the CLI');
  assert(/const timer = setTimeout\(\(\) => \{ timedOut = true; controller\.abort\(\); \}, timeoutMs\)/.test(driver),
    'the request watchdog is an ordinary ref\'d timer that aborts the request');
  assert(driver.includes('release()') && driver.includes('clearTimeout(timer)'),
    'and it is cleared when the exchange is done, so a passing run does not linger on a timer');
});

test('a phase that ends without completing cannot look like a pass', () => {
  const cli = read('src/ops/projection-jellyfin-dataplane-cli.ts');
  assert(cli.includes("process.on('exit'"), 'the CLI watches its own exit');
  assert(/if \(!finished && code === 0\)/.test(cli),
    'an exit-before-completion with status 0 is turned into a failure');
  assert(cli.includes('setInterval'), 'and a keepalive holds the loop open while a phase is running');
});

// ---------------------------------------------------------------------------------------------------------
// Budgets — every multiplier names its denominator
// ---------------------------------------------------------------------------------------------------------

test('the amplification budgets are numbers with named denominators, and the zeroes are zero', () => {
  assertEq(MEDIA_SERVER_BUDGETS.MAX_HTTP_429, 0, 'a 429 means the admission limits did not hold');
  assertEq(MEDIA_SERVER_BUDGETS.MAX_FULL_BODY_SERVED, 0, 'a full body answering a ranged request is a defect');
  assertEq(MEDIA_SERVER_BUDGETS.MAX_RESCAN_CHURN, 0, 'a re-scan of an unchanged library moves nothing');
  assertEq(MEDIA_SERVER_BUDGETS.MAX_RECOVERY_CHURN, 0, 'and neither does a daemon crash and recovery');

  // THE ONE THAT CARRIES THE PRODUCT'S ARGUMENT. A scan that downloaded the object to identify it would sit
  // at or above 1.0 of the object's own length. A budget at or above 1.0 would therefore pass a design that
  // has no reason to exist.
  assert(MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION > 0, 'a scan is allowed to read something');
  assert(MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION < 1,
    'a scan may not be allowed to read the whole object, or the appliance proves nothing');

  // And a multiplier a real scanner could never meet is worse than none: the acceptance plan says so in §5,
  // having already shipped one.
  assert(MEDIA_SERVER_BUDGETS.MAX_SCAN_RANGE_MULTIPLIER >= 3,
    'the range multiplier leaves room for the contract\'s own three probe windows');
  assert(MEDIA_SERVER_BUDGETS.MAX_PEAK_CONNECTIONS >= 1, 'a connection cap permits at least one connection');
});

test('a budget check records the number even when it passes', () => {
  const ok = withinBudget('G', 3, 5);
  assertEq(ok.verdict, 'pass', 'three is within five');
  assertEq(ok.measured, 3, 'and the measurement is kept');
  assertEq(ok.budget, 5, 'against the budget it was measured on');
  assertEq(withinBudget('G', 6, 5).verdict, 'fail', 'six is not');
  assertEq(withinBudget('G', 5, 5).verdict, 'pass', 'the budget is inclusive');
  assertEq(exactly('G', 1, 1).verdict, 'pass', 'an exact match passes');
  assertEq(exactly('G', 0, 1).verdict, 'fail', 'under is not "within" when the gate says exactly');
  // A ceiling alone cannot tell a frugal read path from one that never ran.
  assertEq(atLeast('G', 0, 1).verdict, 'fail', 'zero requests is not a frugal scan, it is an absent one');
  assertEq(atLeast('G', 2, 1).verdict, 'pass', 'and two clears a floor of one');
});

test('THE SCAN BUDGET HAS A FLOOR AS WELL AS A CEILING, and the tail window is what makes it earn one', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(gate.includes('--min-range 1'), 'the scan budget asserts the provider was reached at all');
  // The remote entry's index is deliberately at the END of the object. With `+faststart` a scanner identifies
  // the file from its head alone, and the contract's TAIL probe window would go unexercised by any media
  // server — which is exactly the read pattern most likely to degrade into downloading the whole file.
  assert(gate.includes('moov-at-end'), 'the remote entry is written with its index at the end');
  assert(/encode "media\/\$LOCAL_FILE".*faststart/.test(gate),
    'while the local entry keeps faststart, so it stays the known-correct baseline');
  const remote = gate.split('\n').find((line) => line.includes('encode "remote/$REMOTE_FILE"')) ?? '';
  assert(remote.includes('moov-at-end') && !remote.includes(' faststart'),
    'and the two entries differ in shape, not only in bytes');
});

test('a raced scan records what it saw and asserts only what must hold', () => {
  const cli = read('src/ops/projection-jellyfin-dataplane-cli.ts');
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(cli.includes("args.flags.get('tolerant') === 'true'"), 'a scan can be marked as deliberately raced');
  assert(cli.includes('raced-item-coherent'),
    'a raced scan still refuses a half-formed item, which is the thing a mid-scan swap could produce');
  assert(gate.includes('--tolerant true'), 'the gate races one');
  assert(gate.includes('JD16-midscan-swap'), 'and the NEXT scan is what carries the convergence assertion');
  // The convergence comparison is what makes the race meaningful; without it the raced scan proves nothing.
  // Line continuations are joined first, because the invocation in the gate spans two lines and a
  // single-line regex would silently never match — a check that cannot fire is worse than no check.
  const joined = gate.replace(/\\\r?\n\s*/g, ' ');
  assert(/drive compare .*--gate JD16-midscan-swap --expect-added 1/.test(joined),
    'convergence is asserted as zero removals, zero churn and exactly the one addition');
});

test('a source outage is not a deletion, and cannot shrink a published generation', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  const outage = gate.slice(gate.indexOf('step "a source outage is not a deletion'));
  assert(outage.includes('docker stop -t 10 "$RANGE_CONTAINER"'), 'the provider is actually stopped');
  assert(outage.includes('BEFORE_STAT') && outage.includes('AFTER_STAT'),
    'and the entry\'s size, inode and mode are compared across the outage');
  assert(/= "unchanged"/.test(outage), 'a publish during the outage must be a no-op');
  assert(/deletions.*= "0"/.test(outage), 'and must delete nothing');
  assert(outage.includes('docker start "$RANGE_CONTAINER"'), 'the provider comes back');
  assert(outage.includes('drive resume'), 'and reads are proved correct again afterwards');
});

// ---------------------------------------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------------------------------------

test('the authorization header is one spelling, with and without a token', () => {
  const anonymous = mediaServerAuthHeader();
  assert(anonymous.startsWith('MediaBrowser '), 'the scheme is the media server\'s own');
  assert(anonymous.includes(`Client="${GATE_CLIENT.client}"`), 'it names the client');
  assert(!anonymous.includes('Token='), 'the first-run wizard has no token, and the header does not invent one');
  const authorized = mediaServerAuthHeader('abc123');
  assert(authorized.includes('Token="abc123"'), 'and an authenticated call carries one');
  assert(authorized.startsWith(anonymous.slice(0, 20)), 'both are built by the same function');
});

test('DIRECT PLAY ASKS FOR THE FILE\'S OWN BYTES, which is the only thing a digest comparison can mean', () => {
  const path = directPlayPath('item1', 'src1', 'tok');
  assert(path.includes('static=true'),
    'without static=true the server may remux, and a digest against the published file would fail for a '
    + 'reason that has nothing to do with projection');
  assert(path.includes('mediaSourceId=src1'), 'it names the media source');
  assert(path.startsWith('/Videos/item1/stream?'), 'and the item');
});

test('THE TRANSCODE REQUEST ASKS FOR A CODEC THE SOURCE IS NOT', () => {
  // Given a compatible source a media server will happily remux, report a session and emit segments that were
  // never re-encoded. Encoding in one codec and demanding another is what makes the gate's decode assertion
  // evidence rather than a restatement of the request.
  // Compared as plain strings: the two are literal types, and the compiler would otherwise reject the
  // comparison as unnecessary — which is exactly the property being asserted, and exactly the property that
  // would silently stop holding if somebody made them equal.
  assert(String(TRANSCODE_SOURCE_VIDEO_CODEC) !== String(TRANSCODE_TARGET_VIDEO_CODEC),
    'the source codec and the demanded codec differ, or the transcode gate proves nothing');
  const path = forcedTranscodePath('item1', 'src1', 'tok', 'sess1');
  assert(path.includes(`videoCodec=${TRANSCODE_TARGET_VIDEO_CODEC}`), 'it demands the target codec');
  assert(!path.includes('static=true'), 'and it is not a direct-play request wearing a different name');
  assert(path.includes('master.m3u8'), 'it is the transcoding manifest endpoint');
  assert(path.includes('maxWidth=160'), 'bounded, so a forced transcode cannot become a load test');

  // The gate's shell must be checking the DECODED output, not the server's own bookkeeping.
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(gate.includes('ffprobe'), 'the gate decodes what came out');
  assert(gate.includes('OUT_CODEC') && gate.includes('h264'), 'and asserts the output codec');
  assert(/the media server did not transcode/.test(gate),
    'and fails with a message that says what was concluded');
});

test('the library is added with metadata fetching off, and that is not a weakening of the read path', () => {
  const request = movieLibraryRequest('/media/projection/Movies') as {
    LibraryOptions: Record<string, unknown> & {
      PathInfos: Array<{ Path: string }>;
      TypeOptions: Array<Record<string, unknown[]>>;
    };
  };
  const options = request.LibraryOptions;
  assertEq(options.PathInfos[0]?.Path, '/media/projection/Movies', 'the library root is the projected mount');
  assertEq(options.EnableRealtimeMonitor, false,
    'an inotify watch on a namespace that changes with a generation would race the explicit-scan assertions');
  const movie = options.TypeOptions[0] as Record<string, unknown[]>;
  for (const fetcher of ['MetadataFetchers', 'ImageFetchers']) {
    assertEq((movie[fetcher] ?? []).length, 0, `${fetcher} is empty: this gate has no internet and needs none`);
  }
  // What must NOT be off: anything about opening and reading the file. The scanner still probes every entry.
  assert(!('EnableMediaProbe' in options), 'nothing here disables the media probe');
  assertEq(options.Enabled, true, 'the library is enabled');
});

test('a playlist reference resolves against the playlist, and a server-named host is not followed', () => {
  assertEq(absolutePath('/Videos/a/master.m3u8?x=1', 'main.m3u8?y=2'), '/Videos/a/main.m3u8?y=2',
    'a relative reference resolves against the playlist\'s own directory');
  assertEq(absolutePath('/Videos/a/main.m3u8?x=1', 'hls1/main/0.ts?y=2'), '/Videos/a/hls1/main/0.ts?y=2',
    'and so does a nested one');
  assertEq(absolutePath('/Videos/a/master.m3u8', '/abs/path.ts'), '/abs/path.ts', 'an absolute one is kept');
  // A media server that answered with an absolute URL to somewhere else must not send this gate there: the
  // base URL is the authority, and only the path and query are taken.
  assertEq(absolutePath('/Videos/a/master.m3u8', 'http://elsewhere.invalid/x/0.ts?k=1'), '/x/0.ts?k=1',
    'only the path and query of an absolute URL are used');
});

// ---------------------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------------------

test('THE REPORT RULE IS APPLIED, NOT PROMISED: counts, digests and gate ids only', () => {
  const clean = [{ gate: 'JD4-direct-play', verdict: 'pass', measured: 10, budget: 10 }];
  assertEq(findRedactionProblems(clean).length, 0, 'a well-formed report has no problems');

  const cases: Array<[unknown, string]> = [
    [{ note: 'http://fakerange:8099/direct/obj' }, 'a URL'],
    [{ note: '/Videos/x/stream?api_key=deadbeef' }, 'an api key'],
    [{ note: 'Authorization: Bearer abc' }, 'a bearer credential'],
    [{ note: 'MediaBrowser Client="x", Token="y"' }, 'an auth header'],
    [{ note: 'read /mnt/Movies/A/A.mp4' }, 'an absolute path'],
    [{ note: 'C:\\Users\\someone\\media' }, 'a Windows path'],
    [{ note: 'connected to 192.168.1.10' }, 'an IP address'],
    [{ expiresAt: 12345 }, 'an expiry, by its key alone'],
  ];
  for (const [value, why] of cases) {
    assert(findRedactionProblems(value).length > 0, `the checker catches ${why}`);
  }
  // Nested, because a report is a tree and a checker that only looked at the top level would be decorative.
  assert(findRedactionProblems({ a: [{ b: { c: 'http://x/' } }] }).length > 0, 'it walks nested structures');
  assertEq(findRedactionProblems({ a: [{ b: { c: 'http://x/' } }] })[0]?.at, '$.a[0].b.c',
    'and says exactly where');
});

test('an opaque reference compares across phases without printing what it stands for', () => {
  const a = opaqueRef('entry', 'Movies/A/A.mp4');
  const b = opaqueRef('entry', 'Movies/A/A.mp4');
  const c = opaqueRef('entry', 'Movies/B/B.mp4');
  assertEq(a, b, 'the same value is the same reference, which is what makes a cross-scan comparison possible');
  assert(a !== c, 'a different value is a different reference');
  assert(!a.includes('Movies'), 'and the reference does not contain what it stands for');
  // The kind is part of the digest, so an item id and a path that happened to be equal do not collide.
  assert(opaqueRef('library', 'x') !== opaqueRef('entry', 'x'), 'two kinds of thing cannot collide');
  assertEq(findRedactionProblems({ note: a }).length, 0, 'and a reference is itself redaction-safe');
});

// ---------------------------------------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------------------------------------

test('the gate exists, is pinned by digest, and isolates every port, name and directory it uses', () => {
  for (const artifact of [
    'deploy/projection-jellyfin-dataplane-gate.sh',
    'deploy/projection-jellyfin-dataplane-gate-three.sh',
    'docker-compose.projection-jellyfin.yml',
    'src/core/projection/media-server-dataplane.ts',
    'src/ops/projection-jellyfin-dataplane.ts',
    'src/ops/projection-jellyfin-dataplane-cli.ts',
    'docs/PROJECTION_PHASE_1_JELLYFIN_DATA_PLANE.md',
  ]) assert(exists(artifact), `data-plane artifact exists: ${artifact}`);

  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  // EVERY EXTERNAL IMAGE BY DIGEST. A tag would let the thing under test change between two runs of a gate
  // whose whole claim is that it passed three times in a row.
  for (const image of ['JELLYFIN_IMAGE=', 'GO_IMAGE=', 'VERIFY_IMAGE=']) {
    const line = gate.split('\n').find((l) => l.startsWith(image)) ?? '';
    assert(/@sha256:[0-9a-f]{64}/.test(line), `${image} is pinned by digest, not by tag`);
  }
  assert(/JELLYFIN_IMAGE="jellyfin\/jellyfin@sha256:/.test(gate), 'the media server is a real Jellyfin image');

  // Isolation: its own compose project, its own network, and ports an operator can move.
  const compose = read('docker-compose.projection-jellyfin.yml');
  assert(compose.includes('name: projection-jellyfin-gate'), 'its own compose project name');
  assert(compose.includes('tmpfs:'), 'and throwaway database storage, so three runs are three runs from nothing');
  for (const port of ['PROJECTION_JELLYFIN_GATE_PG_PORT', 'PROJECTION_JELLYFIN_GATE_HTTP_PORT',
    'PROJECTION_JELLYFIN_GATE_RANGE_PORT']) {
    assert(gate.includes(port), `${port} is overridable, so the gate runs beside an installation`);
  }
  assert(!gate.includes(':5432') && !gate.includes(':5470'),
    'it takes neither the development stack\'s port nor the publisher gate\'s');
  // Cleanup on both paths.
  assert(/trap cleanup EXIT/.test(gate), 'it cleans up on success and on failure');
  assert(gate.indexOf('docker rm -f "$JELLYFIN_CONTAINER"') < gate.indexOf('docker rm -f "$MOUNT_CONTAINER"'),
    'and it stops the media server BEFORE the daemon, because a live reader blocks an unmount');
});

test('THE MOUNT IS NOT BOUND READ-ONLY INTO THE MEDIA SERVER, so the daemon is what refuses a write', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  const jellyfinRun = gate.slice(gate.indexOf('start_jellyfin() {'), gate.indexOf('start_jellyfin\n'));
  assert(/-v "\$WORK\/mnt:\/media\/projection:rslave"/.test(jellyfinRun),
    'the mount is propagated in without :ro — otherwise the mutation assertion is about a Docker flag');
  assert(/--user 1000:1000/.test(jellyfinRun), 'and the media server runs non-root, as one actually does');
  assert(/--cap-drop ALL/.test(jellyfinRun), 'with no capabilities');
  // The daemon, meanwhile, gets exactly what a FUSE mount needs and nothing else.
  assert(gate.includes('--cap-drop ALL --cap-add SYS_ADMIN'), 'the daemon gets CAP_SYS_ADMIN only');
  assert(gate.includes('--device /dev/fuse:/dev/fuse'), 'and /dev/fuse');
  assert(gate.includes('--strict-direct-mount'), 'and mounts by syscall, refusing the fusermount helper');
});

test('the gate generates its media rather than downloading any, and records digests outside the mount', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(gate.includes('lavfi'), 'the media comes from ffmpeg\'s own synthetic sources');
  assert(gate.includes('testsrc'), 'a generated test pattern');
  assert(gate.includes('sine='), 'and a generated tone');
  assert(!/curl |wget .*http/.test(gate.replace(/wget -S --header "Range[^\n]*/g, '')),
    'nothing is downloaded from the internet');
  // Two entries generated identically would be byte-identical, and then reading the wrong one would pass.
  assert(gate.includes('test "$LOCAL_SHA" != "$REMOTE_SHA"'),
    'the two entries are asserted to differ, which is what makes every later digest comparison discriminating');
  assert(gate.includes('recorded OUTSIDE the mount') || gate.includes('RECORDED OUTSIDE THE MOUNT'),
    'and the expected digests are recorded outside the thing being verified');
  // Over the contract's own single-probe threshold, or the seek gate exercises nothing.
  assert(gate.includes('3145728'), 'the entries are asserted to be over 3 MiB, so the full probe plan applies');
});

test('THE GATE SAYS WHAT IT DOES NOT PROVE, in its own output rather than only in a document', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  for (const limit of ['Plex', 'Emby', 'Unraid']) {
    assert(gate.includes(limit), `the gate names ${limit} among what is still unproven`);
  }
  assert(/Docker Desktop pass is NOT Linux\/Unraid closure/i.test(gate),
    'and states plainly that a Docker Desktop pass is not Phase 1 closure');
  assert(gate.includes('three consecutive') || gate.includes('three consecutive times'),
    'and repeats what the acceptance plan means by passing');
  const three = read('deploy/projection-jellyfin-dataplane-gate-three.sh');
  assert(!/^[^#\n]*\|\|\s*true\b/m.test(three),
    'a failed run stops the sequence rather than being averaged away');
  assert(/not be reported as Phase 1 closure/i.test(three), 'and the repeat script says the same thing');
});

test('this gate is the REAL-media-server job, and the existing fake-Jellyfin job is untouched', () => {
  // The control-plane suites drive a FAKE server about collections and never open a byte of media. They are a
  // different job, and conflating the two is exactly how a repository ends up believing it has proved
  // something it has not.
  assert(exists('test/jellyfin-fake-server.ts'), 'the fake control-plane server still exists');
  const fake = read('test/jellyfin-fake-server.ts');
  assert(!fake.includes('projection'), 'and knows nothing about projection');
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(!gate.includes('jellyfin-fake-server'), 'the data-plane gate does not use the fake server');
  assert(/REAL JELLYFIN|real, digest-pinned Jellyfin/i.test(gate), 'it says which kind of server it starts');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as {
    suites: Array<{ file: string; group: string }>;
  };
  const control = inventory.suites.find((s) => s.file === 'jellyfin-control-plane.ts');
  assert(control !== undefined, 'the control-plane suite is still inventoried separately');
});

test('the daemon still names no media server, and the driver is control-plane code', () => {
  // The data plane stays provider- and media-server-agnostic. The half that knows what Jellyfin is lives
  // here, in the control plane, and is not compiled into, linked to or read by projectiond.
  const walk = (dir: string): string[] => readdirSync(`${root}/${dir}`, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`)
      : entry.name.endsWith('.go') ? [`${dir}/${entry.name}`] : []));
  for (const file of walk('projectiond')) {
    for (const forbidden of ['jellyfin', 'Jellyfin', 'plex', 'Plex', 'emby', 'Emby']) {
      assert(!read(file).includes(forbidden), `${file} names ${forbidden}`);
    }
  }
  assert(!read('src/core/projection/media-server-dataplane.ts').includes('Jellyfin'),
    'and the contract half is written against a media server, not against one product');
});

test('the file-backed provider object exists for the one reason that justifies it', () => {
  const provider = read('projectiond/internal/fakeprovider/fakeprovider.go');
  assert(provider.includes('func (s *Server) AddFileObject'), 'a file-backed object can be registered');
  assert(provider.includes('func (s *Server) BytesOf'), 'and one accessor decides where an object\'s bytes come from');
  assert(provider.includes('/counters'), 'the counters are readable across a process boundary');
  assert(exists('projectiond/internal/fakeprovider/fileobject_test.go'), 'with a Go suite behind both');
  const suite = read('projectiond/internal/fakeprovider/fileobject_test.go');
  assert(suite.includes('fell back to the deterministic content function'),
    'including the failure that would otherwise be silent: a file object serving synthetic bytes');
  assert(suite.includes('TestCountersEndpointIsNotItselfCounted'),
    'and that reading the counters does not move them');
  // The gate tool that uses it is still a gate tool: the production image does not build it.
  assert(!read('projectiond/Dockerfile').includes('fakerange'), 'the production image does not build fakerange');
});

test('the gate\'s own scratch directory is ignored, and it is not under /tmp', () => {
  const ignore = read('.gitignore');
  assert(ignore.includes('.projection-jellyfin-gate/'), 'the scratch directory is git-ignored');
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(gate.includes('GATE_ROOT="$PWD/.projection-jellyfin-gate"'),
    'it lives beside the repository, because bind propagation needs a host path on a shared mount');
  assert(gate.includes('REL='), 'and there is a relative spelling for the tools that cannot open an MSYS path');
  // A `docker cp` from an MSYS path is the mistake this replaced; it failed with a path Windows could not
  // find. Anchored to a statement, so the comment recording the mistake is not itself the violation.
  assert(!/^\s*docker cp /m.test(gate), 'nothing hands a host path to docker cp');
});

test('package, inventory and the aggregate run are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-jellyfin-dataplane'], 'tsx test/projection-jellyfin-dataplane.ts',
    'test script');
  assertEq(pkg.scripts['go:jellyfin-dataplane-gate'], 'bash deploy/projection-jellyfin-dataplane-gate.sh',
    'gate script');
  assertEq(pkg.scripts['go:jellyfin-dataplane-gate:three'],
    'bash deploy/projection-jellyfin-dataplane-gate-three.sh', 'three-run script');

  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-jellyfin-dataplane.ts'),
    'suite in npm test');
  // The aggregate must stay runnable on a machine with no Docker.
  assert(!(AGGREGATE_SUITE_COMMAND ?? '').includes('docker'), 'the aggregate suite needs no Docker');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as {
    suites: Array<{ file: string; group: string }>;
  };
  const entry = inventory.suites.find((s) => s.file === 'projection-jellyfin-dataplane.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry?.group, 'offline', 'and needs no database');
});

test('the documentation states the limits in the same breath as the capability', () => {
  const doc = read('docs/PROJECTION_PHASE_1_JELLYFIN_DATA_PLANE.md');
  for (const limit of ['Plex', 'Emby', 'Unraid', 'TorBox']) {
    assert(doc.includes(limit), `the doc names ${limit} among what is not yet proved`);
  }
  assert(/Docker Desktop/.test(doc), 'the doc names the environment it has actually been run in');
  assert(/not Phase 1 closure/i.test(doc) && /SHALL NOT be reported as one/.test(doc),
    'and says plainly that a run there is not closure');
  assert(/three consecutive/i.test(doc), 'and repeats what passing means');

  // The acceptance plan's own matrix has to record where these gates now stand.
  const plan = read('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');
  assert(plan.includes('projection-jellyfin-dataplane') || plan.includes('jellyfin-dataplane-gate'),
    'the acceptance plan names the gate that now runs');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
