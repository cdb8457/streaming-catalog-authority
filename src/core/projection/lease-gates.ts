import {
  atLeast, exactly, withinBudget, type GateResult,
} from './media-server-dataplane.js';

// Projection Phase 1 — G24, G25 and G26, as rules rather than as prose.
//
// WHAT THESE THREE GATES ARE ABOUT, AND WHY NO MEDIA SERVER APPEARS IN THEM. G7–G13 ask whether a real media
// server can read the projection. These ask something narrower and further down: whether the daemon's
// TRANSPORT RESOLUTION behaves when the short-lived access material it was handed lapses underneath a read
// that is already in flight. A media server would add a scanner's timing to a question that is not about
// scanners, so the reader here is synthetic and the acceptance plan says so.
//
// WHAT WAS ALREADY BUILT, AND WHAT WAS NOT. The daemon's lease path is COMPLETE and was complete before this
// tranche: `internal/source/resolver.go` carries single-flight resolution, a refresh cooldown, an egress
// allowlist and a lease type that redacts itself, and `internal/source/http.go` spends exactly one refresh per
// read and then `terminalize`s so a refresh can never lead to another refresh. NOTHING IN THE PRODUCT WAS
// MISSING. What was missing was the evidence: no committed harness drove any of it, so §6.1 recorded G24–G26
// as "not run" and could not say more.
//
// SO THIS FILE ADDS NO POLICY. Every number below is read off the contract the daemon already enforces, and
// where a gate asserts a count it is the count the contract names, not a count somebody measured once.

/**
 * The budgets G24–G26 hold, each traced to the clause that fixes it.
 *
 * NOT ONE OF THESE IS FITTED TO AN OBSERVATION. Where the acceptance plan states a number — "exactly one",
 * "zero", "at most once" — that number appears here unchanged. Where it states a behaviour rather than a
 * number, the number is derived from the daemon's own configuration and named as such.
 */
export const LEASE_GATE_BUDGETS = Object.freeze({
  /**
   * G24: "the daemon re-resolves the stable reference ONCE". `MAX_ACCESS_REFRESHES_PER_READ` is 1 in the
   * runtime contract and `terminalize` is what makes it unrepeatable.
   */
  MAX_REFRESHES_PER_READ: 1,
  /** G25: "Resolution requests observed at the fake endpoint: EXACTLY ONE" against 20 concurrent opens. */
  CONCURRENT_OPENS: 20,
  RESOLUTIONS_FOR_ONE_STAMPEDE: 1,
  /** G25: "a twenty-first open inside the cooldown ... produces ZERO further resolution requests". */
  RESOLUTIONS_INSIDE_COOLDOWN: 0,
  /** G26: "bytes accepted from any of them: 0", over each of the four malformed refreshed responses. */
  BYTES_ACCEPTED_FROM_A_MALFORMED_RESPONSE: 0,
  /** G26: "A resolved URL whose host is outside the endpoint allowlist is NOT CONTACTED AT ALL." */
  REQUESTS_TO_A_DISALLOWED_HOST: 0,
  /**
   * G25: the 21st open must fail FAST rather than hang — the cooldown exists so a failing resolver is not
   * asked again, and a reader that blocked for the cooldown would be paying the cost the cooldown avoids.
   * Derived from the daemon's own `refreshCooldown`, which the gate configures and passes in.
   */
  EIO_WITHIN_COOLDOWN_FRACTION: 0.5,
} as const);

/**
 * The four malformed shapes G26 replays AFTER a refresh, in the plan's own order.
 *
 * THE POINT IS THAT A REFRESHED RESPONSE IS NOT A TRUSTED ONE. The first response from an endpoint is held to
 * range discipline by G21; a reader that relaxed any of it once the URL was freshly minted would have a hole
 * exactly the size of one refresh, and nothing else in the suite would notice.
 */
export const REFRESHED_RESPONSE_FAULTS: readonly string[] = Object.freeze([
  'mismatched-content-range',
  'short-body',
  'wrong-total-size',
  'full-body-on-range',
]);

/**
 * The identity fields G24 requires to be byte-identical either side of a lease refresh.
 *
 * THE LIST IS THE PLAN'S, VERBATIM. A refresh changes access material and nothing else; if any of these moved
 * the media server would have been told something, which is the one thing G24 says must not happen.
 */
export const PINNED_IDENTITY_FIELDS: readonly string[] = Object.freeze([
  'projectedEntryId', 'generationId', 'sourceId', 'sourceGeneration', 'inode', 'sizeBytes', 'mtime',
]);

/** The endpoint counters these gates read, and which of them are gauges rather than totals. */
export const LEASE_COUNTER_KEYS: readonly string[] = Object.freeze([
  'resolutions', 'rangeRequests', 'bytesServed', 'observedBytes', 'expiredRejected',
  'served429', 'fullBodyServed', 'completedBodies', 'truncatedBodies', 'accountedResponses',
]);

/** Gauges legitimately fall and must never be read as a counter reset. */
export const LEASE_GAUGE_KEYS: readonly string[] = Object.freeze([
  'bodiesInFlight', 'currentHeldWaiters', 'currentConns',
]);

export interface CounterSnapshot { readonly [key: string]: unknown }

/**
 * Everything that makes a window unusable, as problems rather than as a thrown error.
 *
 * FAIL CLOSED, AND SAY WHICH WAY IT FAILED. A gate that cannot tell "the daemon did nothing" from "the
 * instrument was not running" reports the second as the first and passes. Each of these is a distinct way for
 * a window to describe no interval at all, and each names itself.
 */
export function windowProblems(
  before: CounterSnapshot, after: CounterSnapshot,
): readonly string[] {
  const problems: string[] = [];

  for (const key of LEASE_COUNTER_KEYS) {
    for (const [label, snapshot] of [['before', before], ['after', after]] as const) {
      const value = snapshot[key];
      if (value === undefined) {
        problems.push(`the ${label} snapshot carries no ${key}; a counter that was never reported cannot be `
          + 'differenced, and treating its absence as zero would report a missing instrument as a quiet window');
        continue;
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        problems.push(`the ${label} snapshot's ${key} is ${String(value)}, which is not a safe integer`);
      }
    }
  }
  if (problems.length > 0) return problems;

  for (const key of LEASE_COUNTER_KEYS) {
    const delta = (after[key] as number) - (before[key] as number);
    if (delta < 0) {
      problems.push(`${key} fell by ${-delta} across the window; the endpoint's counters reset underneath it, `
        + 'so the two snapshots describe two processes rather than one interval');
    }
  }
  if (problems.length > 0) return problems;

  // AN UNSETTLED WINDOW IS REFUSED RATHER THAN MEASURED, AT BOTH ENDS.
  //
  // A body still being written has its committed length counted and its observed length not, so the two
  // columns disagree for a reason that says nothing about the daemon. That is obvious for the CLOSING
  // snapshot and just as true for the OPENING one: a window that opened mid-write starts with a committed
  // length whose observed counterpart lands INSIDE the window, so the interval is credited with bytes that
  // were undertaken before it began. An earlier draft checked only the close, and an offline test written to
  // pin the short-circuit is what found it.
  for (const [label, snapshot] of [['opening', before], ['closing', after]] as const) {
    const inFlight = snapshot.bodiesInFlight;
    if (typeof inFlight !== 'number' || !Number.isSafeInteger(inFlight)) {
      problems.push(`the ${label} snapshot carries no usable bodiesInFlight, so it cannot be shown to have `
        + 'settled, and a window bounded by a snapshot that might not have is not an interval');
    } else if (inFlight !== 0) {
      problems.push(`${inFlight} body/bodies were still being written when the window ${label === 'opening'
        ? 'opened' : 'closed'}`);
    }
  }
  return problems;
}

export function delta(before: CounterSnapshot, after: CounterSnapshot, key: string): number {
  return (after[key] as number) - (before[key] as number);
}

/**
 * G24 — a lease lapses mid-read and the read completes, having re-resolved exactly once.
 *
 * THE FLOOR IS AS LOAD-BEARING AS THE CEILING HERE. "At most one resolution" is satisfied perfectly by a
 * window in which the lease never lapsed and nothing was re-resolved — which would mean the gate had not
 * exercised the thing it is named after. So the expiry is required to have been OBSERVED at the endpoint
 * (`expiredRejected` moved) and the resolution count is asserted EXACTLY, not as a ceiling.
 */
export function leaseExpiryResults(
  gate: string, before: CounterSnapshot, after: CounterSnapshot,
  options: { readonly bytesMatchedDigest: boolean; readonly identityUnchanged: readonly string[] },
): readonly GateResult[] {
  const results: GateResult[] = [];
  const problems = windowProblems(before, after);
  if (problems.length > 0) {
    return [{ gate: `${gate}-window-coherent`, verdict: 'fail', measured: problems.length, budget: 0,
      note: problems.join('; ') }];
  }
  results.push({ gate: `${gate}-window-coherent`, verdict: 'pass', measured: 0, budget: 0,
    note: 'every counter present, none fell, and every body had settled when the window closed' });

  results.push(atLeast(`${gate}-lease-actually-lapsed`, delta(before, after, 'expiredRejected'), 1,
    'the endpoint REFUSED a lapsed lease at least once. Without this the gate is satisfied by a window in '
    + 'which nothing expired and nothing was re-resolved, which is the shape of a false pass'));

  results.push(exactly(`${gate}-resolutions`, delta(before, after, 'resolutions'),
    LEASE_GATE_BUDGETS.MAX_REFRESHES_PER_READ,
    'the stable reference was re-resolved EXACTLY once — the acceptance plan\'s own number, and the '
    + 'contract\'s MAX_ACCESS_REFRESHES_PER_READ. Asserted exactly rather than as a ceiling, because a '
    + 'ceiling is cleared by a read that never refreshed at all'));

  results.push(exactly(`${gate}-bytes-correct`, options.bytesMatchedDigest ? 1 : 0, 1,
    'the read completed with the bytes recorded OUTSIDE the mount before anything was published; a refresh '
    + 'that returned different bytes would satisfy every count above'));

  results.push(exactly(`${gate}-identity-drift`, options.identityUnchanged.length, 0,
    options.identityUnchanged.length === 0
      ? `${PINNED_IDENTITY_FIELDS.length} pinned fields byte-identical either side of the refresh: `
        + PINNED_IDENTITY_FIELDS.join(', ')
      : `these moved across a refresh, and none of them may: ${options.identityUnchanged.join(', ')}`));

  return results;
}

/**
 * G25 — twenty concurrent opens meet one expired lease, and the resolver is asked ONCE.
 *
 * WHAT A STAMPEDE COSTS IF SINGLE-FLIGHT IS ABSENT is twenty resolutions, and the failure is not merely
 * expensive: a provider that rate-limits resolution would answer most of them with a refusal, and the daemon
 * would have turned one lapsed lease into a partial outage.
 */
/**
 * G25 SETUP — the failed resolution that STARTS the cooldown must actually reach the endpoint.
 *
 * THE DEFECT THIS CLOSES, AND IT COST A WHOLE SEQUENCE AND A FALSE BUG REPORT. The gate used to arm the
 * resolver fault immediately after the stampede refresh and take the failure for granted. But
 * `Resolver.Get` passes `slot.resolvedOnce` as its `isRefresh` argument, so once anything has resolved,
 * EVERY later resolution on an expired lease is already subject to `RefreshCooldown` — including the one
 * the gate meant to fail at the endpoint. That setup read was refused LOCALLY, never reached the endpoint,
 * and left the fault ARMED; the measured read, by then outside the cooldown, consumed it and recorded one
 * resolution. The gate then reported a product defect that does not exist.
 *
 * So the setup is MEASURED rather than assumed: the fault must have been consumed, which means exactly one
 * resolution reached the endpoint. A setup that resolved ZERO times armed nothing, and the window after it
 * is measuring an idle cooldown rather than a refused one.
 */
export function cooldownSetupResults(
  gate: string, before: CounterSnapshot, after: CounterSnapshot,
  options: { readonly readFailed: boolean },
): readonly GateResult[] {
  const problems = windowProblems(before, after);
  if (problems.length > 0) {
    return [{
      gate: `${gate}-window-coherent`, verdict: 'fail', measured: problems.length, budget: 0,
      note: problems.join('; '),
    }];
  }
  return [
    { gate: `${gate}-window-coherent`, verdict: 'pass', measured: 0, budget: 0 },
    exactly(`${gate}-resolutions`, delta(before, after, 'resolutions'), 1,
      'the setup resolution REACHED THE ENDPOINT exactly once and was failed there. A setup refused '
      + 'locally by a cooldown left over from an earlier phase reaches ZERO, arms nothing, and leaves the '
      + 'fault waiting for whatever reads next'),
    exactly(`${gate}-read-failed`, options.readFailed ? 1 : 0, 1,
      'and the read failed, which is what starts the cooldown the next window measures'),
  ];
}

export function stampedeResults(
  gate: string, before: CounterSnapshot, after: CounterSnapshot,
  options: { readonly opensObserved: number },
): readonly GateResult[] {
  const results: GateResult[] = [];
  const problems = windowProblems(before, after);
  if (problems.length > 0) {
    return [{ gate: `${gate}-window-coherent`, verdict: 'fail', measured: problems.length, budget: 0,
      note: problems.join('; ') }];
  }
  results.push({ gate: `${gate}-window-coherent`, verdict: 'pass', measured: 0, budget: 0 });

  results.push(exactly(`${gate}-opens`, options.opensObserved, LEASE_GATE_BUDGETS.CONCURRENT_OPENS,
    'twenty readers really opened the entry. A stampede gate whose readers did not all run is measuring a '
    + 'smaller stampede and reporting the plan\'s number'));

  results.push(atLeast(`${gate}-lease-actually-lapsed`, delta(before, after, 'expiredRejected'), 1,
    'and they really met a lapsed lease'));

  results.push(exactly(`${gate}-resolutions`, delta(before, after, 'resolutions'),
    LEASE_GATE_BUDGETS.RESOLUTIONS_FOR_ONE_STAMPEDE,
    'EXACTLY ONE resolution served all twenty. Without single-flight this is twenty'));

  return results;
}

/**
 * G25's second half — after a FAILED resolution, the cooldown holds and the reader fails fast.
 *
 * THE FAILURE IS THE SUBJECT. A resolver that succeeded would legitimately be asked again later; what the
 * cooldown exists for is a resolver that is DOWN, where asking again immediately turns one outage into a
 * storm. So the gate fails the resolution deliberately and then measures what the next open costs.
 */
export function cooldownResults(
  gate: string, before: CounterSnapshot, after: CounterSnapshot,
  options: {
    readonly readFailed: boolean; readonly elapsedMs: number; readonly cooldownMs: number;
    readonly namespaceUnchanged: boolean;
  },
): readonly GateResult[] {
  const results: GateResult[] = [];
  const problems = windowProblems(before, after);
  if (problems.length > 0) {
    return [{ gate: `${gate}-window-coherent`, verdict: 'fail', measured: problems.length, budget: 0,
      note: problems.join('; ') }];
  }
  results.push({ gate: `${gate}-window-coherent`, verdict: 'pass', measured: 0, budget: 0 });

  results.push(exactly(`${gate}-resolutions`, delta(before, after, 'resolutions'),
    LEASE_GATE_BUDGETS.RESOLUTIONS_INSIDE_COOLDOWN,
    'an open INSIDE the cooldown, after a failed resolution, asks the resolver NOTHING'));

  results.push(exactly(`${gate}-read-failed`, options.readFailed ? 1 : 0, 1,
    'and the read fails rather than hanging or returning bytes it never fetched'));

  const ceiling = Math.floor(options.cooldownMs * LEASE_GATE_BUDGETS.EIO_WITHIN_COOLDOWN_FRACTION);
  results.push(withinBudget(`${gate}-failed-within-ms`, Math.round(options.elapsedMs), ceiling,
    `it failed FAST — inside ${LEASE_GATE_BUDGETS.EIO_WITHIN_COOLDOWN_FRACTION} of the configured `
    + `${options.cooldownMs}ms cooldown. A reader that blocked for the whole cooldown would be paying exactly `
    + 'the cost the cooldown exists to avoid, and the ceiling is derived from that configured value rather '
    + 'than from any run'));

  results.push(exactly(`${gate}-namespace-drift`, options.namespaceUnchanged ? 0 : 1, 0,
    'and the namespace is unchanged: a resolver outage is not a deletion'));

  return results;
}

/**
 * G26 — a refreshed response is held to every rule the first one was.
 *
 * ONE ENTRY PER FAULT, NAMED, so a breach says which shape got through rather than that one of four did.
 */
export interface RefreshedResponseObservation {
  readonly fault: string;
  readonly bytesAccepted: number;
  readonly readFailed: boolean;
}

export function refreshedResponseResults(
  gate: string, observations: readonly RefreshedResponseObservation[],
): readonly GateResult[] {
  const results: GateResult[] = [];

  results.push(exactly(`${gate}-faults-exercised`, observations.length, REFRESHED_RESPONSE_FAULTS.length,
    `all four of the plan's malformed shapes were replayed after a refresh: `
    + REFRESHED_RESPONSE_FAULTS.join(', ')));

  for (const fault of REFRESHED_RESPONSE_FAULTS) {
    const seen = observations.find((observation) => observation.fault === fault);
    if (seen === undefined) {
      results.push({ gate: `${gate}-${fault}`, verdict: 'fail', measured: 0, budget: 1,
        note: 'this shape was never replayed, so nothing here says the daemon refuses it' });
      continue;
    }
    results.push(exactly(`${gate}-${fault}-bytes-accepted`, seen.bytesAccepted,
      LEASE_GATE_BUDGETS.BYTES_ACCEPTED_FROM_A_MALFORMED_RESPONSE,
      'ZERO bytes accepted from a malformed refreshed response — the same rule the FIRST response is held to '
      + 'by G21. A reader that relaxed range discipline once a URL was freshly minted would have a hole '
      + 'exactly the size of one refresh'));
    results.push(exactly(`${gate}-${fault}-read-failed`, seen.readFailed ? 1 : 0, 1,
      'and the read fails rather than silently returning short'));
  }
  return results;
}

/**
 * G26's last clause — a resolved URL outside the allowlist is NOT CONTACTED.
 *
 * NOT "is contacted and then rejected". The allowlist is an EGRESS control: by the time a request has been
 * sent, whatever the response, the daemon has already told a host the provider chose that it is here.
 */
export function allowlistResults(
  gate: string, options: {
    readonly requestsToDisallowedHost: number; readonly readFailed: boolean;
    readonly resolutionsObserved: number;
  },
): readonly GateResult[] {
  return [
    exactly(`${gate}-requests-to-disallowed-host`, options.requestsToDisallowedHost,
      LEASE_GATE_BUDGETS.REQUESTS_TO_A_DISALLOWED_HOST,
      'the daemon did not dial the host the provider named. Observed at a listener the gate stands up ITSELF '
      + 'on the disallowed origin, because "we saw no request" is only evidence if something was listening'),
    exactly(`${gate}-read-failed`, options.readFailed ? 1 : 0, 1,
      'and the read failed rather than succeeding by some other route'),
    atLeast(`${gate}-resolution-happened`, options.resolutionsObserved, 1,
      'while the resolution ITSELF did happen — otherwise the gate proves only that a request nobody made '
      + 'reached nobody'),
  ];
}
