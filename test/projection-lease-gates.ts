import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  LEASE_GATE_BUDGETS, PINNED_IDENTITY_FIELDS, REFRESHED_RESPONSE_FAULTS,
  allowlistResults, cooldownResults, delta, leaseExpiryResults, refreshedResponseResults, stampedeResults,
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
