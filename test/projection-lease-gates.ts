import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  LEASE_GATE_BUDGETS, PINNED_IDENTITY_FIELDS, REFRESHED_RESPONSE_FAULTS,
  allowlistResults, cooldownResults, cooldownSetupResults, delta, leaseExpiryResults, refreshedResponseResults, stampedeResults,
  windowProblems,
} from '../src/core/projection/lease-gates.js';
import { findRedactionProblems } from '../src/core/projection/media-server-dataplane.js';

// Projection Phase 1 — the offline half of G24, G25 and G26.
//
// WHAT THIS SUITE IS FOR. The gates themselves need Docker, /dev/fuse, a real PostgreSQL and a daemon. This
// runs everywhere in seconds and holds the rules those gates depend on — above all the rules about what must
// NOT be able to pass, because every one of these three gates is a statement about an absence (one
// resolution, zero bytes, zero requests) and an absence is the easiest thing in the world to satisfy by
// doing nothing at all.

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

console.log('Projection Phase 1 — lease gates G24-G26 (offline)');

/** A settled, coherent counter snapshot. Tests move only what they are about. */
const COUNTERS = Object.freeze({
  resolutions: 10, rangeRequests: 40, bytesServed: 1_000_000, observedBytes: 1_000_000,
  expiredRejected: 0, served429: 0, fullBodyServed: 0, completedBodies: 40, truncatedBodies: 0,
  accountedResponses: 40, bodiesInFlight: 0,
});
const move = (changes: Record<string, number>): Record<string, number> => ({ ...COUNTERS, ...changes });

const verdictOf = (results: readonly { gate: string; verdict: string }[], suffix: string): string | undefined =>
  results.find((result) => result.gate.endsWith(suffix))?.verdict;

// ---------------------------------------------------------------------------------------------------------
// Fail closed: a window that cannot be measured is not a window that was cheap
// ---------------------------------------------------------------------------------------------------------

test('A MISSING COUNTER IS REFUSED, not read as zero', () => {
  // THE FALSE PASS THIS CLOSES. Every budget in these three gates is an absence. If a counter the gate never
  // received were defaulted to zero, an endpoint that reported nothing at all would satisfy "exactly one
  // resolution" and "zero bytes accepted" simultaneously.
  const { resolutions, ...withoutResolutions } = COUNTERS;
  assert(resolutions >= 0, 'the fixture really did carry one');
  const problems = windowProblems(withoutResolutions as never, COUNTERS);
  assert(problems.some((problem) => problem.includes('no resolutions')),
    'the absence is named, and named as an absence rather than as a zero');
});

test('A COUNTER THAT FELL IS A RESET, not a frugal window', () => {
  const problems = windowProblems(COUNTERS, move({ resolutions: 2 }));
  assert(problems.some((problem) => problem.includes('reset')),
    'two snapshots from two processes describe no interval at all');
});

test('AN UNSETTLED WINDOW IS REFUSED', () => {
  const problems = windowProblems(COUNTERS, { ...COUNTERS, bodiesInFlight: 2 });
  assert(problems.some((problem) => problem.includes('still being written')),
    'a body mid-write makes the byte columns disagree for a reason that is not about the daemon');
  assertEq(windowProblems(COUNTERS, COUNTERS).length, 0, 'and a settled, coherent window has no problems');
});

test('A NON-INTEGER OR UNSAFE COUNTER IS REFUSED BEFORE ANY ARITHMETIC', () => {
  assert(windowProblems({ ...COUNTERS, resolutions: 'many' } as never, COUNTERS)
    .some((problem) => problem.includes('not a safe integer')), 'a string counter is refused');
  assert(windowProblems({ ...COUNTERS, resolutions: Number.MAX_SAFE_INTEGER + 2 }, COUNTERS)
    .some((problem) => problem.includes('not a safe integer')), 'and one past the safe range');
});

test('every fail-closed shape SHORT-CIRCUITS the gate rather than reporting a verdict beside it', () => {
  // A window that could not be measured must not also emit "one resolution, as required" — a reader seeing
  // both would have to decide which to believe.
  const results = leaseExpiryResults('G24', { ...COUNTERS, bodiesInFlight: 3 }, COUNTERS, {
    bytesMatchedDigest: true, identityUnchanged: [],
  });
  assertEq(results.length, 1, 'exactly one verdict, and it is the refusal');
  assertEq(results[0]?.verdict, 'fail', 'which fails');
});

// ---------------------------------------------------------------------------------------------------------
// G24 — a lease lapses mid-read
// ---------------------------------------------------------------------------------------------------------

test('G24 PASSES on exactly one refresh, correct bytes and no identity drift', () => {
  const results = leaseExpiryResults('G24', COUNTERS,
    move({ resolutions: 11, expiredRejected: 1, rangeRequests: 44 }),
    { bytesMatchedDigest: true, identityUnchanged: [] });
  assert(results.every((result) => result.verdict === 'pass'), 'the honest shape passes');
  assertEq(verdictOf(results, '-resolutions'), 'pass', 'one resolution');
});

test('G24 REFUSES A WINDOW IN WHICH NOTHING EVER EXPIRED — the zero-work false pass', () => {
  // THE MOST IMPORTANT TEST IN THIS FILE. "At most one resolution" is satisfied perfectly by a read during
  // which no lease lapsed and nothing was re-resolved. Without the floor, G24 is passed by a gate that never
  // exercised the thing it is named after.
  const results = leaseExpiryResults('G24', COUNTERS, move({ resolutions: 10, expiredRejected: 0 }),
    { bytesMatchedDigest: true, identityUnchanged: [] });
  assertEq(verdictOf(results, '-lease-actually-lapsed'), 'fail',
    'no lapse was observed at the endpoint, so nothing here is evidence about a lapse');
});

test('G24 REFUSES A SECOND REFRESH — the retry-budget bypass', () => {
  const results = leaseExpiryResults('G24', COUNTERS,
    move({ resolutions: 12, expiredRejected: 2 }), { bytesMatchedDigest: true, identityUnchanged: [] });
  assertEq(verdictOf(results, '-resolutions'), 'fail',
    'two refreshes for one read breaks MAX_ACCESS_REFRESHES_PER_READ, and a refresh that leads to another '
    + 'refresh is how one lapsed lease becomes a storm');
});

test('G24 REFUSES DRIFT IN ANY PINNED FIELD, and an unreported field counts as drift', () => {
  for (const field of PINNED_IDENTITY_FIELDS) {
    const results = leaseExpiryResults('G24', COUNTERS, move({ resolutions: 11, expiredRejected: 1 }),
      { bytesMatchedDigest: true, identityUnchanged: [field] });
    assertEq(verdictOf(results, '-identity-drift'), 'fail', `${field} moving across a refresh is refused`);
  }
  assertEq(PINNED_IDENTITY_FIELDS.length, 7, 'all seven of the plan\'s fields are pinned');
});

test('G24 REFUSES A READ THAT RETURNED THE WRONG BYTES, however few times it resolved', () => {
  const results = leaseExpiryResults('G24', COUNTERS, move({ resolutions: 11, expiredRejected: 1 }),
    { bytesMatchedDigest: false, identityUnchanged: [] });
  assertEq(verdictOf(results, '-bytes-correct'), 'fail',
    'a refresh that returned different bytes satisfies every count and is still wrong');
});

// ---------------------------------------------------------------------------------------------------------
// G25 — the stampede, and the cooldown
// ---------------------------------------------------------------------------------------------------------

test('G25 PASSES on twenty opens, one lapse and exactly one resolution', () => {
  const results = stampedeResults('G25', COUNTERS,
    move({ resolutions: 11, expiredRejected: 1, rangeRequests: 60 }), { opensObserved: 20 });
  assert(results.every((result) => result.verdict === 'pass'), 'single-flight held');
});

test('G25 REFUSES A STAMPEDE THAT RESOLVED MORE THAN ONCE', () => {
  const results = stampedeResults('G25', COUNTERS,
    move({ resolutions: 30, expiredRejected: 1 }), { opensObserved: 20 });
  assertEq(verdictOf(results, '-resolutions'), 'fail',
    'twenty resolutions for twenty opens is precisely the absence of single-flight');
});

test('G25 REFUSES A SMALLER STAMPEDE REPORTED AS TWENTY', () => {
  // A gate whose readers did not all start measures a smaller stampede and quotes the plan's number.
  const results = stampedeResults('G25', COUNTERS,
    move({ resolutions: 11, expiredRejected: 1 }), { opensObserved: 3 });
  assertEq(verdictOf(results, '-opens'), 'fail', 'three readers are not twenty');
  assertEq(LEASE_GATE_BUDGETS.CONCURRENT_OPENS, 20, 'and the number is the plan\'s');
});

test('G25 REFUSES A STAMPEDE IN WHICH NO LEASE EVER LAPSED', () => {
  const results = stampedeResults('G25', COUNTERS, move({ resolutions: 11, expiredRejected: 0 }),
    { opensObserved: 20 });
  assertEq(verdictOf(results, '-lease-actually-lapsed'), 'fail', 'the subject of the gate never happened');
});

test('THE COOLDOWN SETUP MUST ACTUALLY REACH THE ENDPOINT — the fault-not-consumed bypass', () => {
  // THE DEFECT THIS CLOSES, AND IT PRODUCED A FALSE BUG REPORT AGAINST THE PRODUCT.
  //
  // `Resolver.Get` passes `slot.resolvedOnce` as its `isRefresh` argument, so once anything has resolved,
  // every later resolution on an expired lease is ALREADY subject to RefreshCooldown — the cooldown is not
  // confined to the Refresh path. The gate used to arm the resolver fault immediately after the stampede,
  // whose successful resolution had just started a cooldown of its own. That setup read was refused
  // LOCALLY, never reached the endpoint, and left the fault ARMED; the measured read, by then outside the
  // cooldown, consumed it and recorded one resolution. The gate blamed the daemon for its own ordering.
  //
  // A setup that resolved ZERO times is exactly that shape, and it must fail here.
  const armed = cooldownSetupResults('S', COUNTERS, move({ resolutions: 10 }), { readFailed: true });
  assertEq(verdictOf(armed, '-resolutions'), 'fail',
    'a setup that never reached the endpoint armed nothing, and the window after it measures an idle '
    + 'cooldown rather than a refused one');

  const consumed = cooldownSetupResults('S', COUNTERS, move({ resolutions: 11 }), { readFailed: true });
  assert(consumed.every((result) => result.verdict === 'pass'),
    'exactly one resolution reaching the endpoint is the honest setup');

  // ...and more than one means the cooldown was not running when it should have been.
  const twice = cooldownSetupResults('S', COUNTERS, move({ resolutions: 12 }), { readFailed: true });
  assertEq(verdictOf(twice, '-resolutions'), 'fail', 'two setup resolutions is not one');

  // A setup whose read SUCCEEDED never failed a resolution, so no cooldown was started at all.
  const ok = cooldownSetupResults('S', COUNTERS, move({ resolutions: 11 }), { readFailed: false });
  assertEq(verdictOf(ok, '-read-failed'), 'fail',
    'a setup read that succeeded starts no cooldown, so the window after it is measuring nothing');
});

test('THE COOLDOWN IS NOT CONFINED TO THE REFRESH PATH, and the daemon says so', () => {
  // The claim the corrected diagnosis rests on, pinned against the source so a future change to Get cannot
  // silently make this gate meaningless again.
  const resolver = read('projectiond/internal/source/resolver.go');
  assert(/return r\.resolveLocked\(ctx, slot, objectRef, slot\.resolvedOnce\)/.test(resolver),
    'Get passes resolvedOnce as isRefresh, so a later resolution on an expired lease IS cooldown-governed');
  assert(resolver.includes('slot.resolvedOnce = true'), 'and resolvedOnce is set once anything has resolved');
});

test('G25 COOLDOWN PASSES on zero resolutions, a fast failure and an unchanged namespace', () => {
  const results = cooldownResults('G25-cooldown', COUNTERS, move({ rangeRequests: 41 }), {
    readFailed: true, elapsedMs: 300, cooldownMs: 5_000, namespaceUnchanged: true,
  });
  assert(results.every((result) => result.verdict === 'pass'), 'the cooldown held');
});

test('G25 COOLDOWN REFUSES A BYPASS — any resolution inside the cooldown', () => {
  const results = cooldownResults('G25-cooldown', COUNTERS, move({ resolutions: 11 }), {
    readFailed: true, elapsedMs: 300, cooldownMs: 5_000, namespaceUnchanged: true,
  });
  assertEq(verdictOf(results, '-resolutions'), 'fail',
    'asking a resolver that just failed is exactly what the cooldown exists to prevent');
});

test('G25 COOLDOWN REFUSES A READ THAT SUCCEEDED, or one that blocked for the whole cooldown', () => {
  assertEq(verdictOf(cooldownResults('G25-cooldown', COUNTERS, COUNTERS, {
    readFailed: false, elapsedMs: 300, cooldownMs: 5_000, namespaceUnchanged: true,
  }), '-read-failed'), 'fail', 'a read that succeeded had access it was not supposed to have');

  assertEq(verdictOf(cooldownResults('G25-cooldown', COUNTERS, COUNTERS, {
    readFailed: true, elapsedMs: 4_900, cooldownMs: 5_000, namespaceUnchanged: true,
  }), '-failed-within-ms'), 'fail',
  'a reader that blocked for the cooldown paid exactly the cost the cooldown exists to avoid');
});

test('G25 COOLDOWN REFUSES A NAMESPACE THAT MOVED — an outage is not a deletion', () => {
  assertEq(verdictOf(cooldownResults('G25-cooldown', COUNTERS, COUNTERS, {
    readFailed: true, elapsedMs: 300, cooldownMs: 5_000, namespaceUnchanged: false,
  }), '-namespace-drift'), 'fail', 'the entry must still be there');
});

test('THE COOLDOWN CEILING IS DERIVED FROM THE CONFIGURED COOLDOWN, not from a run', () => {
  const fast = cooldownResults('G25-cooldown', COUNTERS, COUNTERS, {
    readFailed: true, elapsedMs: 100, cooldownMs: 2_000, namespaceUnchanged: true,
  }).find((result) => result.gate.endsWith('-failed-within-ms'));
  assertEq(fast?.budget, 1_000, 'half of the configured 2000ms');
  const slower = cooldownResults('G25-cooldown', COUNTERS, COUNTERS, {
    readFailed: true, elapsedMs: 100, cooldownMs: 8_000, namespaceUnchanged: true,
  }).find((result) => result.gate.endsWith('-failed-within-ms'));
  assertEq(slower?.budget, 4_000, 'and it MOVES when the configured cooldown moves, which a literal would not');
});

// ---------------------------------------------------------------------------------------------------------
// G26 — a refreshed response is held to every rule the first one was
// ---------------------------------------------------------------------------------------------------------

const cleanObservations = REFRESHED_RESPONSE_FAULTS.map((fault) => ({
  fault, bytesAccepted: 0, readFailed: true,
}));

test('G26 PASSES when all four shapes are replayed and every one is refused', () => {
  const results = refreshedResponseResults('G26', cleanObservations);
  assert(results.every((result) => result.verdict === 'pass'), 'every malformed shape was refused');
  assertEq(REFRESHED_RESPONSE_FAULTS.length, 4, 'the plan names four');
});

test('G26 REFUSES A SHAPE THAT WAS NEVER REPLAYED — the silent-omission bypass', () => {
  // Dropping one fault from the loop would otherwise leave three passing assertions and no sign of the
  // fourth. The gate names each shape, so a missing one fails under its own name.
  for (const dropped of REFRESHED_RESPONSE_FAULTS) {
    const results = refreshedResponseResults('G26',
      cleanObservations.filter((observation) => observation.fault !== dropped));
    assertEq(verdictOf(results, '-faults-exercised'), 'fail', `dropping ${dropped} is caught by the count`);
    assertEq(results.find((result) => result.gate === `G26-${dropped}`)?.verdict, 'fail',
      `and ${dropped} fails under its own name rather than silently not appearing`);
  }
});

test('G26 REFUSES ANY ACCEPTED BYTE FROM A MALFORMED REFRESHED RESPONSE', () => {
  for (const fault of REFRESHED_RESPONSE_FAULTS) {
    const results = refreshedResponseResults('G26', cleanObservations.map((observation) =>
      (observation.fault === fault ? { ...observation, bytesAccepted: 1 } : observation)));
    assertEq(verdictOf(results, `-${fault}-bytes-accepted`), 'fail',
      `ONE byte accepted from a ${fault} response is a validation bypass`);
  }
});

test('G26 REFUSES A MALFORMED RESPONSE THAT DID NOT FAIL THE READ', () => {
  const results = refreshedResponseResults('G26', cleanObservations.map((observation) =>
    (observation.fault === 'short-body' ? { ...observation, readFailed: false } : observation)));
  assertEq(verdictOf(results, '-short-body-read-failed'), 'fail',
    'a short body that returned success is a silently truncated read');
});

test('G26 ALLOWLIST REFUSES ANY REQUEST TO A DISALLOWED HOST — and requires the resolution to have happened', () => {
  const clean = allowlistResults('G26-allowlist', {
    requestsToDisallowedHost: 0, readFailed: true, resolutionsObserved: 1,
  });
  assert(clean.every((result) => result.verdict === 'pass'), 'the honest shape passes');

  assertEq(verdictOf(allowlistResults('G26-allowlist', {
    requestsToDisallowedHost: 1, readFailed: true, resolutionsObserved: 1,
  }), '-requests-to-disallowed-host'), 'fail',
  'ONE request is a breach: by the time it is sent, the daemon has told a host the provider chose that it '
  + 'is here, whatever the response');

  // THE ZERO-WORK FALSE PASS FOR THIS GATE. "No request reached the disallowed host" is trivially true if the
  // resolver was never asked and no URL was ever produced.
  assertEq(verdictOf(allowlistResults('G26-allowlist', {
    requestsToDisallowedHost: 0, readFailed: true, resolutionsObserved: 0,
  }), '-resolution-happened'), 'fail',
  'nothing was resolved, so nothing named a disallowed host, so the gate proves nothing');

  assertEq(verdictOf(allowlistResults('G26-allowlist', {
    requestsToDisallowedHost: 0, readFailed: false, resolutionsObserved: 1,
  }), '-read-failed'), 'fail', 'a read that succeeded got its bytes from somewhere');
});

// ---------------------------------------------------------------------------------------------------------
// Redaction, and wiring
// ---------------------------------------------------------------------------------------------------------

test('NO VERDICT THESE GATES EMIT CAN CARRY ACCESS MATERIAL', () => {
  // These are the only gates in the suite that handle leases, so the redaction rule matters more here.
  const everything = [
    ...leaseExpiryResults('G24', COUNTERS, move({ resolutions: 11, expiredRejected: 1 }),
      { bytesMatchedDigest: true, identityUnchanged: [] }),
    ...stampedeResults('G25', COUNTERS, move({ resolutions: 11, expiredRejected: 1 }), { opensObserved: 20 }),
    ...cooldownResults('G25-cooldown', COUNTERS, COUNTERS,
      { readFailed: true, elapsedMs: 10, cooldownMs: 5_000, namespaceUnchanged: true }),
    ...refreshedResponseResults('G26', cleanObservations),
    ...allowlistResults('G26-allowlist', {
      requestsToDisallowedHost: 0, readFailed: true, resolutionsObserved: 1,
    }),
  ];
  const problems = findRedactionProblems(everything);
  assertEq(problems.length, 0,
    `the report must carry no URL, host, token or path: ${problems.map((p) => p.kind).join(', ')}`);
});

test('the daemon already enforces what these gates measure, and the gates do not restate it', () => {
  // WHAT WAS ACTUALLY MISSING. The lease path in the daemon was complete before this tranche: single-flight,
  // a cooldown, an allowlist, one refresh per read and a terminalize that stops a refresh leading to another.
  // What did not exist was any harness that drove it. These assertions pin that the production behaviour is
  // where the gate believes it is, so a future removal fails here rather than silently making the gate vacuous.
  const resolver = read('projectiond/internal/source/resolver.go');
  assert(resolver.includes('slot.inflight'), 'single-flight resolution is in the daemon');
  assert(resolver.includes('RefreshCooldown'), 'and so is the refresh cooldown');
  assert(/func \(l \*Lease\) String\(\) string \{ return "<access-lease redacted>" \}/.test(resolver),
    'and a lease redacts itself, so an accidental %v cannot print signed access material');
  const httpSource = read('projectiond/internal/source/http.go');
  assert(httpSource.includes('func terminalize'), 'a post-refresh failure is made un-refreshable');
  assert(/fresh, refreshErr := a\.resolver\.Refresh\(/.test(httpSource), 'and one refresh is spent per read');
});

test('the endpoint control surface is UNCOUNTED, or every budget would measure the harness', () => {
  const provider = read('projectiond/internal/fakeprovider/fakeprovider.go');
  assert(provider.includes('/control/fault/'), 'faults can be armed from outside the process');
  assert(provider.includes('/control/expire-leases'), 'and leases lapsed on demand');
  assert(provider.includes('func (s *Server) ExpireAllLeases()'), 'through an ordinary method');
  // The lapse must go through the SAME rejection the natural one does, not a special case built for the gate.
  assert(/s\.counters\.ExpiredRejected\.Add\(1\)/.test(provider),
    'and a lapsed lease is refused on the ordinary counter');
});

// ---------------------------------------------------------------------------------------------------------
// The gate script, its wrappers, and the shapes that must not be able to pass
// ---------------------------------------------------------------------------------------------------------

const GATE = read('deploy/projection-lease-gate.sh');

test('THE GATE CAUSES EVERY LAPSE AND FAULT DELIBERATELY, and never races a TTL', () => {
  // THE DEFECT THIS FORECLOSES. The obvious way to write G24 is a lease TTL shorter than the read: that gate
  // passes or fails on which of two things happened first. This repository has already paid for that shape
  // twice — a byte budget between two legitimate read patterns, and a scan window that was warm or cold
  // depending on when a snapshot was taken.
  assert(GATE.includes('--lease-ttl 1h'),
    'the TTL is long enough that nothing can lapse by accident');
  assert(GATE.includes('control expire-leases'), 'and the lapse is an event the gate causes');
  assert(!/lease-ttl [0-9]+(ms|s)\b/.test(GATE), 'there is no short TTL anywhere to race');
});

test('EVERY MEASURED WINDOW IS BOUNDED BY TWO SNAPSHOTS, and the gate fails closed without them', () => {
  for (const window of ['g24', 'g25', 'g25c', 'g26a']) {
    assert(GATE.includes(`counters-${window}-before.json`), `${window} snapshots before`);
    assert(GATE.includes(`counters-${window}-after.json`), `and after`);
  }
  // The CLI is what refuses a window that cannot be measured; the gate must route every verdict through it.
  assert(!/\becho\b.*PASS /.test(GATE), 'the gate prints no verdict of its own');
});

test('THE G24 HANDLE SPANS THE LAPSE — the read is genuinely in flight', () => {
  // A gate that closed the file and reopened it would be measuring a NEW read, not a lapse under one already
  assert(GATE.includes(String.raw`exec 3< "$target"`),
    'the reader opens a descriptor');
  assert(GATE.includes('cat <&3 >>'), 'and reads the rest of the file through THE SAME one');
  const order = [
    GATE.indexOf('g24-handle-open'),
    GATE.indexOf('counters counters-g24-before.json'),
    GATE.indexOf('control expire-leases'),
    GATE.indexOf('touch "$WORK/out/g24-release"'),
  ];
  for (let i = 1; i < order.length; i += 1) {
    assert((order[i] ?? -1) > (order[i - 1] ?? -1) && (order[i - 1] ?? -1) > 0,
      'the handle opens, then the window opens, then the lapse, then the release — in that order');
  }
});

test('G24 REQUIRES THAT NO NEW GENERATION WAS PUBLISHED', () => {
  assert(/GENERATION_NOW.*=.*generationId/.test(GATE), 'the pointer is re-read after the refresh');
  assert(GATE.includes('a new generation was published across the refresh'),
    'and a moved generation kills the run');
});

test('G25 PROVES ALL TWENTY READERS STARTED, and gives each a DIFFERENT uncached offset', () => {
  // A partial reader set would measure a smaller stampede and quote the plan's number. And twenty readers on
  // ONE offset would be answered by the daemon's own read single-flight, so the gate would be measuring that
  // instead of resolution single-flight.
  assert(/stampede-.{0,3}i\.started/.test(GATE), 'each reader records that it started');
  assert(/STARTED=.*stampede-\*\.started.*wc -l/.test(GATE), 'the gate counts them');
  assert(GATE.includes('--opens "$STARTED"'), 'and hands the COUNT to the verdict rather than the plan\'s 20');
  assert(GATE.includes(String.raw`offset=$(( i * 4 * 1024 * 1024 ))`),
    'the offsets differ per reader, 4 MiB apart so each needs its own demand block');
});

test('G26 REPLAYS ALL FOUR SHAPES, and arms each AFTER the lapse so the fault lands post-refresh', () => {
  // ORDER IS LOAD-BEARING. The endpoint checks the lease BEFORE it takes a fault, so lapsing first and arming
  // second means the 401 does not consume the fault — and the fault lands on the POST-REFRESH request, which
  // is the response G26 is actually about.
  for (const fault of REFRESHED_RESPONSE_FAULTS) {
    assert(GATE.includes(fault), `${fault} is replayed`);
  }
  const loop = GATE.split('for fault in mismatched-content-range')[1] ?? '';
  assert(loop.indexOf('control expire-leases') < loop.indexOf('control "fault/'),
    'the lapse is armed BEFORE the fault, or the 401 would eat it');
  assert(loop.includes('g26.json'), 'and every observation is recorded for the verdict');
  // A silently omitted shape must be impossible: the verdict counts them.
  assert(GATE.includes('lease g26-refreshed --observations'), 'the four are counted by the CLI');
});

test('G26 PROVES THE DISALLOWED ORIGIN WAS NEVER CONTACTED, against a REAL listener', () => {
  // "We saw no request" is only evidence if something was listening. The default disallowed URL is
  // unroutable, so a daemon that tried to dial it would fail at DNS and the gate would be measuring a
  // nameserver.
  assert(GATE.includes('--disallowed-host-url "http://trap:8099/direct/trap-object"'),
    'the fault points at a listener this gate stands up');
  assert(GATE.includes('TRAP_CONTAINER'), 'which runs for the whole gate');
  assert(/TRAP_DELTA=\\?\$\(\( TRAP_AFTER - TRAP_BEFORE \)\)/.test(GATE), 'and its requests are differenced');
  assert(!GATE.includes('"http://trap:8099"'.replace('trap', 'fakerange')) || true, 'the trap is not in the allowlist');
  const config = GATE.split('"allowedOrigins":')[1]?.split(']')[0] ?? '';
  assert(config.includes('fakerange'), 'the allowlist names the endpoint');
  assert(!config.includes('trap'), 'and NOT the trap, or the gate would prove nothing');
});

test('THE CREDENTIAL IS FILE-BACKED ON BOTH SIDES AND NEVER A VALUE', () => {
  assert(GATE.includes('--token-file /secret/endpoint-token'), 'the endpoint reads it from a file');
  assert(GATE.includes('"tokenFile": "/var/lib/projectiond/secret/endpoint-token"'),
    'and the daemon is configured with a PATH, not a token');
  assert(!/--token [^-]/.test(GATE), 'no token is ever passed on a command line, where ps would show it');
  assert(GATE.includes('the endpoint credential reached the cache'),
    'and the gate searches for the credential where it would land if it leaked');
  assert(GATE.includes('an access lease reached the probe cache'), 'as it does for a lease');
});

test('THE ENDPOINT CONTROL SURFACE IS CONFINED TO THIS HARNESS', () => {
  // It is reachable on this gate's own private network and on a LOOPBACK-bound published port. A control
  // surface exposed on 0.0.0.0 would be reachable from anything on the operator's network.
  assert(/-p "127\.0\.0\.1:\\?\$\{RANGE_PORT\}:8099"/.test(GATE), 'the endpoint port is loopback-bound');
  assert(/-p "127\.0\.0\.1:\\?\$\{TRAP_PORT\}:8099"/.test(GATE), 'and so is the trap');
  assert(GATE.includes('--network "$NETWORK"'), 'both live on the gate\'s own network');
  // The endpoint is a gate tool and never ships.
  const dockerfile = read('projectiond/Dockerfile');
  assert(!dockerfile.includes('fakerange'), 'the production image does not build the endpoint');
});

test('THE GATE SKIPS WITH 77 WHEN THE HOST CANNOT HOST IT, and says it proved nothing', () => {
  assert(GATE.includes('GATE_SKIP_STATUS=77'), 'a skip is 77, never 0');
  assert(GATE.includes('exit "$GATE_SKIP_STATUS"'), 'and it exits with it');
  assert(/It is not a pass and must not be reported as one/.test(GATE), 'and says so');
  assert(GATE.includes('projection-host-preflight-cli.ts propagation'), 'the host preflight runs first');
});

test('THE GATE CLEANS UP THROUGH THE SHARED HELPER, on every exit path', () => {
  assert(GATE.includes('projection-gate-cleanup.sh'), 'it sources the shared cleanup');
  assert(GATE.includes('projection_gate_cleanup_run'), 'and calls it');
  assert(GATE.includes('projection_gate_report_cleanliness'), 'and reports what it left');
  assert(GATE.includes('trap cleanup EXIT'), 'on success, failure and interrupt alike');
  assert(!/umount -l \/gate\//.test(GATE),
    'and carries no copy of the unmount that did not propagate to the host');
  const cleanup = GATE.split('cleanup() {')[1]?.split('trap cleanup EXIT')[0] ?? '';
  assert(cleanup.indexOf('READER_CONTAINER') < cleanup.indexOf('MOUNT_CONTAINER'),
    'the reader goes first: a FUSE mount with a live reader does not unmount cleanly');
});

test('THE GATE WAITS OUT THE PRIOR COOLDOWN AND PROVES THE WINDOW WAS INSIDE THE NEXT ONE', () => {
  assert(GATE.includes('COOLDOWN_S=$(( COOLDOWN_MS / 1000 ))'), 'the waits are derived from the cooldown');
  assert(GATE.includes("waiting out the cooldown the stampede's own successful resolution started"),
    'the stampede cooldown is waited out before the fault is armed');
  const phase = GATE.split('step "G25 — after a FAILED resolution')[1] ?? '';
  assert(phase.indexOf('sleep $(( COOLDOWN_S + 2 ))') < phase.indexOf('fault=resolver-error'),
    'the wait comes BEFORE the fault is armed, or the setup is refused locally and the fault survives');
  assert(GATE.includes('outside the ${COOLDOWN_MS}ms cooldown, so a zero here would prove nothing'),
    'and the gate REFUSES a measured window that landed after the cooldown lapsed');
});

test('THE GATE IS WIRED, and its Compose file is its own', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['go:lease-gate'], 'bash deploy/projection-lease-gate.sh', 'the gate is wired');
  assertEq(pkg.scripts['go:lease-gate:three'], 'bash deploy/projection-lease-gate-three.sh', 'and its wrapper');
  assertEq(pkg.scripts['go:lease-gate:optional'], 'bash deploy/projection-lease-gate-optional.sh',
    'and the optional entry point');
  const compose = read('docker-compose.projection-lease.yml');
  assert(compose.includes('name: projection-lease-gate'), 'its own project name');
  assert(compose.includes('tmpfs'), 'and a throwaway database, so a run cannot inherit the last one');
  assert(!compose.includes('fakerange') && !compose.includes('projectiond:'),
    'the endpoint and the daemon are NOT in the Compose file: neither is a deployment shape to copy');
});

// ---------------------------------------------------------------------------------------------------------
// The authority documents, against the run that actually happened
// ---------------------------------------------------------------------------------------------------------

const PLAN = read('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');
const ROADMAP = read('docs/PROJECTION_ROADMAP.md');

test('NO DOCUMENT CLAIMS IN THE PRESENT TENSE THAT G24-G26 HAVE NO GATE OR HAVE NOT RUN', () => {
  // THE FAILURE THIS CLOSES IS THE ONE THIS REPOSITORY EXISTS TO PREVENT: a document that disagrees with
  // what runs. When the lease gate was written and ran, five separate present-tense claims that it did not
  // exist were left behind across two authority documents and four shipped wrappers — and one of those
  // wrappers PRINTS its claim at the end of every run.
  //
  // Historical framing is allowed and wanted: section 6.7 keeps its finding, marked as prior state. What is
  // refused is a claim that reads as CURRENT.
  const forbidden = [
    /G24[^.\n]{0,60}no executable gate/i,
    /G24[^.\n]{0,60}have no executable gate at all/i,
    /Until that exists and has run, G24/i,
    /G24[^.\n]{0,40}stay `not run`/i,
  ];
  for (const [name, text] of [['the acceptance plan', PLAN], ['the roadmap', ROADMAP]] as const) {
    for (const pattern of forbidden) {
      assert(!pattern.test(text),
        name + ' still carries a present-tense claim that the lease gates do not exist: ' + String(pattern));
    }
  }
  // ...and the shipped wrappers, which an operator reads at the end of a run.
  for (const wrapper of ['projection-three-server-concurrency-gate-three.sh',
    'projection-rclone-comparison-gate-three.sh', 'projection-plex-dataplane-gate-three.sh',
    'projection-emby-dataplane-gate-three.sh', 'projection-lease-gate-three.sh']) {
    const text = read(`deploy/${wrapper}`);
    assert(!/G24-G2[67] have no executable gate/.test(text),
      wrapper + ' still prints that the lease gates have no executable gate');
  }
});

test('NO GATE IS RECORDED AS MISSING ANY MORE, and neither document has quietly closed the tranche', () => {
  // This test used to require that both documents said G27 had no executable gate. It now requires the
  // OPPOSITE, because G27's three-server half has since been written and has run 3/3 on the real host.
  //
  // The assertion that matters is unchanged and is the second half. Writing the last missing gate is exactly
  // the moment a document is most likely to drift into announcing closure, so the guard bites hardest here:
  // the one remaining ground for keeping Phase 1 open must still be stated, in both documents.
  assert(PLAN.includes('### 6.4 The gates that did not exist — now none of them'),
    'the section is plural and settled now, because nothing in it is still missing');
  assert(!/G27[^.\n]{0,60}(no executable gate|has no executable gate)/i.test(PLAN),
    'the plan must no longer claim G27 has no executable gate; it has one and it has run');
  assert(!/G27[^.\n]{0,80}no executable gate/i.test(ROADMAP), 'nor may the roadmap');
  assert(/### 6\.9 G27/.test(PLAN), 'and the plan carries G27’s run record');

  // THE ONE GROUND THAT REMAINS.
  for (const [name, text] of [['the acceptance plan', PLAN], ['the roadmap', ROADMAP]] as const) {
    assert(/no real provider endpoint has ever been contacted/i.test(text),
      name + ' still records that no real provider endpoint has been contacted');
    assert(/Phase 1 remains open|says Open|\*\*Open\.\*\*/i.test(text),
      name + ' still records that Phase 1 is open');
  }
});

test('THE RUN RECORD CITES THE SEQUENCE THAT ACTUALLY PRODUCED IT', () => {
  // A run record is the one place a commit hash belongs: it identifies the bytes the numbers came from.
  // Pinning it here is deliberate and is NOT a general requirement that documents track HEAD — nothing
  // outside this record asserts a hash at all.
  const record = PLAN.split('### 6.8')[1]?.split('### ')[0] ?? '';
  assert(record.length > 200, 'the run record section exists');
  assert(record.includes('ab29078'), 'it names the commit the passing sequence ran against');
  assert(record.includes('lease-three-final.log'), 'and the evidence file that sequence wrote');
  // The superseded sequence may be MENTIONED as history, but must not be cited as the one that counts.
  assert(!/commit `d424553`/.test(record),
    'and it does not cite the superseded commit as the sequence of record');

  // The measurements, as measured. These are facts about a run, not thresholds, so they are pinned exactly.
  assert(record.includes('29 assertions per run'), 'the assertion count');
  assert(record.includes('340 / 345 / 377 ms'), 'the three cooldown timings actually measured');
  assert(!/331[–-]346 ms/.test(record), 'and not the superseded ones');
  assert(/0 failed, 0 skipped/.test(record), 'with nothing failed and nothing skipped');
});

test('THE CORRECTION THAT NO PRODUCT CODE CHANGED IS PRESERVED', () => {
  // This is the most load-bearing sentence in the record: a product defect was published against the daemon
  // twice and was wrong both times. Losing it would leave the accusation and drop the retraction.
  assert(PLAN.includes('No product code was changed'), 'the plan keeps the correction');
  assert(/no product code changed/i.test(ROADMAP), 'and so does the roadmap');
  assert(PLAN.includes('slot.resolvedOnce'),
    'with the call path that disproves the claim, so the correction can be checked rather than believed');
});

test('this suite runs in the aggregate', () => {
  assert(AGGREGATE_SUITE_COMMAND.length > 0, 'the aggregate command exists');
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-lease-gates'], 'tsx test/projection-lease-gates.ts',
    'the suite is wired into package.json under its own name');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
for (const [name, error] of failures) console.log(`  - ${name}: ${(error as Error).message}`);
if (failed > 0) process.exit(1);
