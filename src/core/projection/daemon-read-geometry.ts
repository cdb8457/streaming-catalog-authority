import {
  MEDIA_SERVER_BUDGETS, atLeast, exactly, providerByteResults, withinBudget,
  type GateResult, type ProviderByteWindow,
} from './media-server-dataplane.js';
import { PLEX_LARGE_FIXTURE, plexObjectByteCeiling } from './plex-dataplane.js';

// Projection Phase 1 — the DAEMON's read geometry, as the one thing every per-server gate holds an object to.
//
// WHY THIS MODULE EXISTS, AND WHY IT DEFINES NOTHING.
//
// `plexObjectByteCeiling(size)` is `8 x min(4 MiB, size) + 3 x min(1 MiB, size)`, and NOT ONE OF THOSE
// NUMBERS IS PLEX'S. The 4 MiB is `readpath.DefaultConfig().ChunkBytes`, the daemon's demand block; the 1 MiB
// is `manifest.ProbeWindowBytes`, the daemon's scan window; the two caps are the maxima measured across every
// instrumented scan window this repository has. It lives in the Plex module because that is the gate that had
// to derive it, after two attempts at a fitted multiplier — one of which the next run exceeded.
//
// `three-server-concurrency.ts` already re-exported it as `daemonBlockByteCeiling` for exactly this reason,
// with a comment saying copying it would be the mistake. This module is that same re-export, moved somewhere
// a per-server gate can import it without depending on the three-server gate, so that Jellyfin, Emby, Plex
// and G18 all resolve to ONE function. It re-exports; it does not restate. Changing a cap still means
// changing it in the one place that owns the nineteen observations justifying it.
//
// WHAT THE ARITHMETIC DEFECT WAS, AND WHY THE ANSWER IS NOT A NEW NUMBER.
//
// The Jellyfin gate held its ~50-entry scan to `MAX_SCAN_BYTE_FRACTION` — 0.5 — of the remote bytes above the
// contract's single-probe threshold. On Unraid that ceiling came out at 4,297,137 over an 8,594,275-byte
// object, and the daemon's scan of that object costs one of exactly two legitimate values:
//
//   1 probe window (1,048,576) + one EOF-clipped demand block (2,724,273) = 3,772,849   — passes
//   2 probe windows (2,097,152) + the same clipped block                  = 4,821,425   — FAILS
//
// The two differ by ONE probe window, both are inside the contract's own probe plan, and the ceiling sat
// between them. So the gate passed or failed according to whether the scanner happened to touch a second
// window — a coin flip, not a measurement, and the "arithmetically unreachable budget" the acceptance plan
// §5 already warns about in its own words.
//
// THE FIX IS NOT A BIGGER FRACTION. `MAX_SCAN_BYTE_FRACTION` is unchanged at 0.5 and is still the product's
// whole argument. What changed is WHERE it is asserted. Below the large-fixture size the daemon serves a
// 4 MiB demand block for a one-byte read, so identifying a small object costs a whole block whatever the
// daemon does and a sub-1.0 fraction over it is unreachable BY CONSTRUCTION. Those objects are held to the
// BLOCK GEOMETRY instead. The fraction is asserted where it is genuinely testable — on an object big enough
// that the maximum legitimate geometry sits comfortably below it and a whole-object read clearly breaches it.

/**
 * What ONE object of a given length may cost at the provider during a scan, from the daemon's block geometry.
 *
 * Re-exported, never restated. See the header for why.
 */
export { plexObjectByteCeiling as daemonBlockByteCeiling } from './plex-dataplane.js';

/**
 * The smallest object on which `MAX_SCAN_BYTE_FRACTION` is a testable claim rather than an unreachable one.
 *
 * COMPUTED, NOT CHOSEN, and computed from the two quantities that decide it: the per-entry block envelope and
 * the fraction itself. `envelope / fraction` is where the two bounds coincide; the existing derivation puts
 * the minimum strictly above that, with margin, and rounds to a whole MiB so a shell fixture check can carry
 * an integer. Today that is 94 MiB.
 *
 * IT IS THE SAME NUMBER THE THREE-SERVER GATE ALREADY GENERATES A FIXTURE FOR, which is why the per-server
 * gates reuse that generator rather than sizing a second fixture to a second rule.
 */
export const LARGE_FIXTURE_MIN_BYTES: number = PLEX_LARGE_FIXTURE.MIN_BYTES;

/** Which of the two bounds an object is held to, so a breach can say what it breached. */
export type ScanBoundKind = 'block-geometry' | 'block-geometry+byte-fraction';

/**
 * Is this object big enough for the byte fraction to be a claim worth asserting?
 *
 * A PREDICATE RATHER THAN A LITERAL COMPARISON AT THE CALL SITES, so that "the fraction applies here" has one
 * definition and a test can move the boundary and watch every caller move with it.
 */
export function fractionIsTestableAt(size: number): boolean {
  return size >= LARGE_FIXTURE_MIN_BYTES;
}

/**
 * Both bounds for one object, and which of them bind.
 *
 * BOTH ARE ASSERTED WHERE BOTH APPLY, AND NEITHER REPLACES THE OTHER. On a 94 MiB object the block geometry
 * (36,700,160) is the TIGHTER of the two and the fraction (49,283,072) is the looser — so asserting only the
 * fraction there would be weaker than asserting only the geometry, and asserting only the geometry would drop
 * the claim the product actually makes. They measure different things: the geometry bounds the MECHANISM (how
 * many blocks and windows a scan may touch), and the fraction bounds the OUTCOME (a scan reads less than half
 * the file). A whole-object read of 98,566,144 bytes breaches the fraction by 2x and the geometry by 2.7x,
 * and it is the fraction that says what is wrong with it in the product's own terms.
 */
export interface ObjectScanBounds {
  readonly sizeBytes: number;
  readonly geometryCeiling: number;
  /** `undefined` where the object is too small for the fraction to be reachable. */
  readonly fractionCeiling: number | undefined;
  /** The tighter of whichever bounds apply — what a single number would have to be. */
  readonly bindingCeiling: number;
  readonly boundKind: ScanBoundKind;
}

export function objectScanBounds(size: number): ObjectScanBounds {
  const bounded = Math.max(0, size);
  const geometryCeiling = plexObjectByteCeiling(bounded);
  if (!fractionIsTestableAt(bounded)) {
    return {
      sizeBytes: bounded, geometryCeiling, fractionCeiling: undefined,
      bindingCeiling: geometryCeiling, boundKind: 'block-geometry',
    };
  }
  const fractionCeiling = Math.floor(bounded * MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION);
  return {
    sizeBytes: bounded, geometryCeiling, fractionCeiling,
    bindingCeiling: Math.min(geometryCeiling, fractionCeiling),
    boundKind: 'block-geometry+byte-fraction',
  };
}

// ---------------------------------------------------------------------------------------------------------
// Per-object attribution
// ---------------------------------------------------------------------------------------------------------

/**
 * The endpoint's per-object columns for one window. All four arrays are parallel and in REGISTRATION order.
 */
export interface ObjectAttribution {
  readonly objectSizes: readonly number[];
  readonly objectCommitted: readonly number[];
  readonly objectObserved: readonly number[];
}

/**
 * Read the three parallel per-object columns out of a counters snapshot.
 *
 * ONE READER FOR BOTH GATES, so a gate cannot accidentally pair the endpoint's committed column against some
 * other snapshot's size list. A missing array is an empty one rather than a throw: the caller's coherence
 * and floor assertions are what refuse a window that attributed nothing, and they say so in words.
 */
export function objectAttribution(snapshot: Record<string, unknown>): ObjectAttribution {
  const numbers = (key: string): readonly number[] => {
    const value = snapshot[key];
    return Array.isArray(value) ? value.map((entry) => (typeof entry === 'number' ? entry : 0)) : [];
  };
  return {
    objectSizes: numbers('objectSizes'),
    objectCommitted: numbers('objectBytes'),
    objectObserved: numbers('objectObserved'),
  };
}

export interface ObjectScanVerdict {
  readonly ordinal: number;
  readonly sizeBytes: number;
  readonly committedBytes: number;
  /** The APPLICATION-WRITE observation for this object and window. Never above `committedBytes`. */
  readonly observedBytes: number;
  readonly bounds: ObjectScanBounds;
  readonly geometryWithinBudget: boolean;
  readonly fractionWithinBudget: boolean;
  /** Committed and observed as multiples of the object's OWN length, for the record rather than a verdict. */
  readonly committedMultiplier: number;
  readonly observedMultiplier: number;
}

/**
 * Hold EVERY object's own bytes against a ceiling derived from ITS OWN length.
 *
 * WHY AN AGGREGATE IS NOT ENOUGH, AND THIS IS NOT BELT-AND-BRACES. An aggregate is exactly where one runaway
 * object hides: a corpus total that stays under a shared ceiling is perfectly consistent with one object
 * being downloaded in full while thirty-eight others are barely touched. The Plex line already learned this
 * the expensive way — a window exceeded its corpus ceiling by 0.098 % and the counters could not say whether
 * that was one object read four times over or thirty-eight objects each read a little extra, which are two
 * findings with opposite responses. So each object is judged against its own length and a breach names it.
 *
 * THE FRACTION IS ASSERTED ONLY WHERE IT IS TESTABLE, and that is a property of the OBJECT rather than of the
 * corpus. An object below the large-fixture size carries no fraction verdict at all — `fractionWithinBudget`
 * is `true` for it because there is nothing to breach, and the caller separately requires that at least one
 * object big enough to carry the claim was present. Without that requirement, shrinking the corpus would
 * silently retire the product's central budget while every assertion still passed.
 *
 * THE OBSERVED COLUMN IS AN APPLICATION-WRITE OBSERVATION. See `providerByteResults`.
 */
export function objectScanVerdicts(
  before: ObjectAttribution, after: ObjectAttribution,
): readonly ObjectScanVerdict[] {
  const verdicts: ObjectScanVerdict[] = [];
  const count = Math.min(after.objectSizes.length, after.objectCommitted.length,
    after.objectObserved.length);
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    // THE SIZE COMES FROM THE ENDPOINT, IN THE ENDPOINT'S OWN ORDER, never from a caller-supplied list paired
    // by position. Pairing a gate's size ordering against the endpoint's registration ordering judges each
    // object against some other object's length and reports confident per-object verdicts about the wrong
    // objects — a defect the Plex suite has a dedicated regression for.
    const sizeBytes = after.objectSizes[ordinal] ?? 0;
    const committedBytes = (after.objectCommitted[ordinal] ?? 0) - (before.objectCommitted[ordinal] ?? 0);
    const observedBytes = (after.objectObserved[ordinal] ?? 0) - (before.objectObserved[ordinal] ?? 0);
    const bounds = objectScanBounds(sizeBytes);
    verdicts.push({
      ordinal,
      sizeBytes,
      committedBytes,
      observedBytes,
      bounds,
      // BOTH COLUMNS, against the geometry. The committed one may exceed only where the window's own
      // abandonment accounts for it, which the aggregate assertion bounds; here the geometry is generous
      // enough that a legitimately abandoned block is inside it, so both are held to the same number.
      geometryWithinBudget: committedBytes <= bounds.geometryCeiling
        && observedBytes <= bounds.geometryCeiling,
      fractionWithinBudget: bounds.fractionCeiling === undefined
        || (committedBytes <= bounds.fractionCeiling && observedBytes <= bounds.fractionCeiling),
      committedMultiplier: sizeBytes > 0 ? Math.round((committedBytes / sizeBytes) * 1000) / 1000 : 0,
      observedMultiplier: sizeBytes > 0 ? Math.round((observedBytes / sizeBytes) * 1000) / 1000 : 0,
    });
  }
  return verdicts;
}

/** How many objects in the window were big enough for the byte fraction to have been asserted on them. */
export function fractionBearingObjects(verdicts: readonly ObjectScanVerdict[]): number {
  return verdicts.filter((verdict) => verdict.bounds.fractionCeiling !== undefined).length;
}

/** The aggregate ceiling: the sum of every registered object's own geometry term. */
export function aggregateGeometryCeiling(objectSizes: readonly number[]): number {
  return objectSizes.reduce((total, size) => total + objectScanBounds(size).geometryCeiling, 0);
}

/**
 * THE WHOLE SCAN BYTE VERDICT FOR ONE WINDOW — ONE RULE, SHARED BY EVERY PER-SERVER GATE.
 *
 * `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5's G15 is a budget over a corpus, and a corpus total is
 * where a runaway object hides. So the aggregate is kept — it is cheap and it catches what attribution
 * cannot, namely bytes served for a reference the gate never registered — and the BINDING verdicts are per
 * object.
 *
 * ONE EMITTER FOR BOTH GATES, so "Jellyfin and Emby are held to the same rule" is a property of the code
 * rather than a claim in a document that two files could drift away from.
 */
export function scanByteResults(
  gate: string,
  window: ProviderByteWindow,
  before: ObjectAttribution,
  after: ObjectAttribution,
  options: { readonly requireFractionBearingObject: boolean },
): readonly GateResult[] {
  const verdicts = objectScanVerdicts(before, after);
  const aggregate = aggregateGeometryCeiling(after.objectSizes);
  const results: GateResult[] = [
    ...providerByteResults(gate, window, aggregate,
      `denominator: the sum of every registered object's OWN block-geometry term over `
      + `${after.objectSizes.length} objects. It is an aggregate and it is deliberately not the binding `
      + 'verdict — the per-object assertions below are, because a total cannot name which object spent it'),
  ];

  // PER-OBJECT GEOMETRY. Each object against a ceiling derived from its own length, both columns.
  const geometryBreaches = verdicts.filter((verdict) => !verdict.geometryWithinBudget);
  results.push(exactly(`${gate}-provider-bytes-per-object`, geometryBreaches.length, 0,
    geometryBreaches.length === 0
      ? `${verdicts.length} registered objects, each inside a ceiling derived from ITS OWN length, on both `
        + 'the committed and the application-write columns; an aggregate cannot say this'
      : geometryBreaches.map((breach) => `object #${breach.ordinal} of ${breach.sizeBytes} bytes took `
        + `${breach.committedBytes} committed / ${breach.observedBytes} observed against a block-geometry `
        + `ceiling of ${breach.bounds.geometryCeiling}`).join('; ')));

  // THE BYTE FRACTION, ON THE OBJECTS BIG ENOUGH TO CARRY IT.
  const fractionBearing = verdicts.filter((verdict) => verdict.bounds.fractionCeiling !== undefined);
  const fractionBreaches = verdicts.filter((verdict) => !verdict.fractionWithinBudget);
  results.push(exactly(`${gate}-byte-fraction-per-object`, fractionBreaches.length, 0,
    fractionBreaches.length === 0
      ? `${fractionBearing.length} object(s) at or above ${LARGE_FIXTURE_MIN_BYTES} bytes held to `
        + `x${MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION} of their OWN length — the acceptance plan's own `
        + 'fraction, unchanged, asserted where it is reachable rather than where it is not'
      : fractionBreaches.map((breach) => `object #${breach.ordinal} of ${breach.sizeBytes} bytes took `
        + `${breach.committedBytes} committed / ${breach.observedBytes} observed against a fraction ceiling `
        + `of ${breach.bounds.fractionCeiling ?? 0}`).join('; ')));

  // ...AND THAT THERE WAS ONE AT ALL.
  //
  // WITHOUT THIS, SHRINKING THE CORPUS SILENTLY RETIRES THE PRODUCT'S CENTRAL BUDGET. Every assertion above
  // is satisfied by a corpus of tiny files — the fraction simply stops being asserted on anything, and no
  // verdict anywhere says so. Changing the corpus, its ordering or its sizes therefore cannot disable the
  // fraction without failing here.
  if (options.requireFractionBearingObject) {
    results.push(atLeast(`${gate}-fraction-bearing-objects`, fractionBearing.length, 1,
      `an object at or above ${LARGE_FIXTURE_MIN_BYTES} bytes must be in the corpus, because that is the `
      + 'smallest size at which the maximum legitimate block geometry sits comfortably below the fraction '
      + 'and a whole-object read clearly breaches it. Below it the fraction is unreachable by construction '
      + 'and asserting it would be asserting something no ceiling constrains'));
    for (const verdict of fractionBearing) {
      results.push(withinBudget(`${gate}-byte-fraction:${verdict.ordinal}`, verdict.observedBytes,
        verdict.bounds.fractionCeiling ?? 0,
        `${verdict.observedMultiplier}x of the object's own ${verdict.sizeBytes} bytes as an `
        + `application-write observation (${verdict.committedMultiplier}x committed). A whole-object read `
        + `would be ${verdict.sizeBytes} against ${verdict.bounds.fractionCeiling ?? 0} and would breach `
        + `this; the block geometry alone would permit ${verdict.bounds.geometryCeiling}`));
    }
  }
  return results;
}
