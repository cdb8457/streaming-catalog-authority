import { MaintenanceRefused } from './maintenance-safety.js';

// Phases 305-307 — what is in a backup destination, and which of it a policy may remove.
//
// THIS MODULE DECIDES AND IT DOES NOT ACT. Nothing here opens a file, renames anything or removes anything:
// it takes an inventory somebody else read and a policy somebody typed, and produces one decision per entry
// with a closed reason. `backup-retention.ts` reads the disk and performs the effects; keeping the judgement
// in a pure function is what lets the suite drive every protection with a fabricated inventory and a fixed
// clock, rather than by waiting for Tuesday or by owning ten gigabytes of fixtures.
//
// THE TABLE OF CLASSES IS CLOSED AND SO IS THE TABLE OF REASONS. A destination entry this build cannot name is
// a compile error, not a default; and every decision an operator reads is one of a fixed vocabulary rather
// than a sentence somebody wrote at the call site.

// -----------------------------------------------------------------------------------------------------------
// What an entry in a backup destination IS
// -----------------------------------------------------------------------------------------------------------

/**
 * Every kind of thing a backup destination can hold. Total, closed, and only two of them can ever be removed.
 *
 * `RESERVED` is every dot-prefixed name, and that is deliberately broader than "this product's in-flight
 * artifacts". A published set is created under `assertUsableName`, which cannot produce a leading dot, so no
 * set is ever reachable through this class — while a backup staging tree (`.<set>.staging-<hex>`), a restore
 * safety-set claim (`.pre-restore-claim-<nonce>`), a lock directory and this command's own quarantine all are.
 * One rule covers all of them and cannot fall behind a namespace somebody adds later.
 */
export type SetClass =
  | 'VERIFIED'
  | 'UNVERIFIED'
  | 'UNREADABLE'
  | 'FOREIGN'
  | 'RESERVED'
  | 'NOT_A_DIRECTORY';

/** Every class this build writes. Exported so a durable document can be validated against it before use. */
export const SET_CLASSES: readonly SetClass[] =
  Object.freeze(['VERIFIED', 'UNVERIFIED', 'UNREADABLE', 'FOREIGN', 'RESERVED', 'NOT_A_DIRECTORY']);

/** The two classes a policy may even consider. Everything else is protected by what it is. */
export const REMOVABLE_CLASSES: readonly SetClass[] = Object.freeze(['VERIFIED', 'UNVERIFIED']);

export interface InventoryEntry {
  /** The entry's own name in the destination. Never a path. */
  readonly name: string;
  readonly setClass: SetClass;
  /** The manifest's `takenAt`, when it is a usable ISO instant. Null makes the entry unorderable. */
  readonly takenAt: string | null;
  /** The same instant in epoch milliseconds, so ordering never re-parses. Null exactly when `takenAt` is. */
  readonly takenAtMs: number | null;
  readonly schemaVersion: number | null;
  /** Phase 278's verification digest over what the manifest declares. Empty when there is none. */
  readonly setDigest: string;
  /** `restorableUnderThisBuild`. A verified ROLLBACK POINT is intact and is NOT this. */
  readonly restorable: boolean;
  readonly bytes: number;
  readonly entries: number;
  /** The verification's own closed finding words, for an entry that did not verify. Never a detail sentence. */
  readonly findings: readonly string[];
}

// -----------------------------------------------------------------------------------------------------------
// The policy
// -----------------------------------------------------------------------------------------------------------

export interface RetentionPolicy {
  /** How many of the newest VERIFIED sets to keep. Counts verified sets only — see `evaluateRetention`. */
  readonly keepLast: number;
  /** Nothing taken within this many days is removable, whatever the window says. */
  readonly minAgeDays: number;
  /** Make sets that do not verify candidates too. Off by default. */
  readonly includeUnverified: boolean;
  /** The floor: refuse the whole operation if it would leave fewer restorable sets than this. */
  readonly keepMinimumRestorable: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  keepLast: 7,
  minAgeDays: 7,
  includeUnverified: false,
  keepMinimumRestorable: 1,
});

export const MAX_KEEP_LAST = 1000;
export const MAX_MIN_AGE_DAYS = 3650;
export const MAX_KEEP_MINIMUM = 100;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Refuse a policy that is not a policy.
 *
 * `keepLast` of zero is refused rather than treated as "remove everything": this command has no mode that
 * empties a backup destination, and a zero typed where a seven was meant must not be the way to reach one.
 */
export function assertUsablePolicy(policy: RetentionPolicy): void {
  const whole = (value: number): boolean => Number.isInteger(value) && Number.isFinite(value);
  if (!whole(policy.keepLast) || policy.keepLast < 1 || policy.keepLast > MAX_KEEP_LAST) {
    throw new MaintenanceRefused(
      `--keep-last must be a whole number from 1 to ${MAX_KEEP_LAST}. There is no value that means "keep none": `
      + 'this command has no mode that empties a backup destination.');
  }
  if (!whole(policy.minAgeDays) || policy.minAgeDays < 0 || policy.minAgeDays > MAX_MIN_AGE_DAYS) {
    throw new MaintenanceRefused(`--min-age-days must be a whole number from 0 to ${MAX_MIN_AGE_DAYS}`);
  }
  if (!whole(policy.keepMinimumRestorable) || policy.keepMinimumRestorable < 1
    || policy.keepMinimumRestorable > MAX_KEEP_MINIMUM) {
    throw new MaintenanceRefused(
      `--keep-minimum-restorable must be a whole number from 1 to ${MAX_KEEP_MINIMUM}. It cannot be zero: a `
      + 'retention run that is allowed to leave this installation with nothing it could restore from is not a '
      + 'retention run.');
  }
}

// -----------------------------------------------------------------------------------------------------------
// The decision
// -----------------------------------------------------------------------------------------------------------

export type RetentionReason =
  // Protections. The first two are unconditional: no flag reaches past them.
  | 'PROTECTED_NEWEST_RESTORABLE'
  | 'PROTECTED_NEWEST_ROLLBACK_POINT'
  | 'PROTECTED_NOT_OURS'
  | 'PROTECTED_UNVERIFIED'
  | 'PROTECTED_UNDATED'
  | 'PROTECTED_MIN_AGE'
  | 'PROTECTED_KEEP_WINDOW'
  // Removals.
  | 'BEYOND_KEEP_WINDOW'
  | 'UNVERIFIED_SET';

/** Every reason, in the order they are evaluated. Exported so a suite can assert the vocabulary is closed. */
export const RETENTION_REASONS: readonly RetentionReason[] = Object.freeze([
  'PROTECTED_NEWEST_RESTORABLE',
  'PROTECTED_NEWEST_ROLLBACK_POINT',
  'PROTECTED_NOT_OURS',
  'PROTECTED_UNVERIFIED',
  'PROTECTED_UNDATED',
  'PROTECTED_MIN_AGE',
  'PROTECTED_KEEP_WINDOW',
  'BEYOND_KEEP_WINDOW',
  'UNVERIFIED_SET',
]);

/** What each reason means, in the operator's words. Rendered; never re-typed at a call site. */
export const RETENTION_REASON_TEXT: Readonly<Record<RetentionReason, string>> = Object.freeze({
  PROTECTED_NEWEST_RESTORABLE:
    'the newest set this build could actually restore. Nothing removes this one.',
  PROTECTED_NEWEST_ROLLBACK_POINT:
    'the newest set from before this build\'s schema — the only thing that can roll this installation back, '
    + 'and by definition not restorable here. Nothing removes this one either.',
  PROTECTED_NOT_OURS: 'not a backup set this command took, so it is not this command\'s to remove.',
  PROTECTED_UNVERIFIED: 'it does not verify, and --include-unverified was not given.',
  PROTECTED_UNDATED: 'its manifest records no usable date, so it has no place in an ordering.',
  PROTECTED_MIN_AGE: 'it is younger than --min-age-days.',
  PROTECTED_KEEP_WINDOW: 'it is inside --keep-last.',
  BEYOND_KEEP_WINDOW: 'older than the newest --keep-last verified sets.',
  UNVERIFIED_SET: 'it does not verify, and --include-unverified was given.',
});

export interface RetentionDecision {
  readonly name: string;
  readonly decision: 'keep' | 'remove';
  readonly reason: RetentionReason;
}

export type RetentionRefusal = 'NO_RESTORABLE_SET' | 'FLOOR_NOT_MET';

export interface RetentionEvaluation {
  /** One decision per inventory entry, in the inventory's canonical order. */
  readonly decisions: readonly RetentionDecision[];
  /** The names to remove, OLDEST FIRST, so an interrupted run has taken the least valuable ones. */
  readonly removals: readonly string[];
  /**
   * The set that will be re-verified after the removals.
   *
   * It is the one protected as `PROTECTED_NEWEST_RESTORABLE`, and it is null only when the evaluation is
   * refused for having none.
   */
  readonly protectedRestorable: string | null;
  /** How many verified, restorable sets would remain. The floor is checked against THIS, not against a count
   * accumulated while deciding — an independent recount is what catches a defect in the deciding. */
  readonly restorableRemaining: number;
  readonly refusals: readonly RetentionRefusal[];
}

/**
 * Decide, from an inventory and a policy, what a retention run would do.
 *
 * PROTECTION IS EVALUATED BEFORE THE WINDOW AND IT WINS. The order of the branches below is the whole
 * safety argument, and it is written once:
 *
 *   1. not one of ours          — nothing else is even asked
 *   2. the newest restorable    — unconditional
 *   3. the newest rollback point— unconditional
 *   4. unverified, not included
 *   5. undated                  — unorderable, so no policy about an order applies to it
 *   6. too young
 *   7. inside the keep window
 *   8. otherwise: remove
 *
 * THE KEEP WINDOW RANKS VERIFIED SETS ONLY. A corrupt set protects nobody, so letting one occupy a slot in
 * "keep the newest seven" would silently make it six — and the seventh, which is the one furthest back and
 * therefore most likely to be the last good one, would go.
 */
export function evaluateRetention(
  entries: readonly InventoryEntry[],
  policy: RetentionPolicy,
  now: Date,
): RetentionEvaluation {
  assertUsablePolicy(policy);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new MaintenanceRefused('the clock this run was given is not a usable time');

  // THE NEWEST OF EACH KIND. "Newest" is by the manifest's own instant, ties broken by name so the answer is
  // total. A restorable set with no usable date cannot be "newest" — but it must still be protected as the
  // last good one, so it is chosen by name when nothing is datable at all. Otherwise a destination whose
  // manifests all lost their dates would have no protected set and would refuse (which is safe) while
  // reporting nothing about which set it would have protected (which is unhelpful).
  const restorable = entries.filter((entry) => entry.setClass === 'VERIFIED' && entry.restorable);
  const rollbackPoints = entries.filter((entry) => entry.setClass === 'VERIFIED' && !entry.restorable);
  const newestRestorable = newestOf(restorable);
  const newestRollbackPoint = newestOf(rollbackPoints);

  // THE WINDOW. Verified, datable sets, newest first; the rank is the position in that list.
  const rank = new Map<string, number>();
  for (const [index, entry] of entries
    .filter((entry) => entry.setClass === 'VERIFIED' && entry.takenAtMs !== null)
    .slice()
    .sort(newestFirst)
    .entries()) {
    rank.set(entry.name, index);
  }

  const minAgeMs = policy.minAgeDays * MS_PER_DAY;
  const decisions: RetentionDecision[] = [];
  for (const entry of entries) {
    decisions.push({ name: entry.name, ...decide(entry) });
  }

  function decide(entry: InventoryEntry): { decision: 'keep' | 'remove'; reason: RetentionReason } {
    if (!REMOVABLE_CLASSES.includes(entry.setClass)) return keep('PROTECTED_NOT_OURS');
    if (newestRestorable !== null && entry.name === newestRestorable.name) return keep('PROTECTED_NEWEST_RESTORABLE');
    if (newestRollbackPoint !== null && entry.name === newestRollbackPoint.name) {
      return keep('PROTECTED_NEWEST_ROLLBACK_POINT');
    }
    if (entry.setClass === 'UNVERIFIED' && !policy.includeUnverified) return keep('PROTECTED_UNVERIFIED');
    if (entry.takenAtMs === null) return keep('PROTECTED_UNDATED');
    // A set whose recorded instant is in the FUTURE is younger than any bound, so it is protected by the same
    // branch rather than by a separate rule: `nowMs - takenAtMs` is negative and negative is less than any
    // non-negative minimum. With `--min-age-days 0` it is still protected, because a set that claims to have
    // been taken after now is a set whose date this command will not act on.
    if (nowMs - entry.takenAtMs < Math.max(minAgeMs, 1)) return keep('PROTECTED_MIN_AGE');
    const position = rank.get(entry.name);
    if (position !== undefined && position < policy.keepLast) return keep('PROTECTED_KEEP_WINDOW');
    return { decision: 'remove', reason: entry.setClass === 'VERIFIED' ? 'BEYOND_KEEP_WINDOW' : 'UNVERIFIED_SET' };
  }

  const removing = new Set(decisions.filter((d) => d.decision === 'remove').map((d) => d.name));
  // OLDEST FIRST. An interrupted run has then destroyed the least valuable sets it was going to, and the
  // order is deterministic so a resume continues the same list rather than re-deciding it.
  const removals = entries
    .filter((entry) => removing.has(entry.name))
    .slice()
    .sort(oldestFirst)
    .map((entry) => entry.name);

  // THE FLOOR IS AN INDEPENDENT RECOUNT. It is deliberately NOT accumulated inside `decide`: a check that
  // agrees with the thing it is checking cannot catch it being wrong.
  const restorableRemaining = restorable.filter((entry) => !removing.has(entry.name)).length;
  const refusals: RetentionRefusal[] = [];
  if (restorable.length === 0) refusals.push('NO_RESTORABLE_SET');
  else if (restorableRemaining < policy.keepMinimumRestorable) refusals.push('FLOOR_NOT_MET');

  return {
    decisions,
    removals,
    protectedRestorable: newestRestorable === null ? null : newestRestorable.name,
    restorableRemaining,
    refusals,
  };
}

function keep(reason: RetentionReason): { decision: 'keep'; reason: RetentionReason } {
  return { decision: 'keep', reason };
}

/** Newest first: later instant wins; an undated entry sorts last; ties by name descending. */
function newestFirst(a: InventoryEntry, b: InventoryEntry): number {
  const left = a.takenAtMs ?? Number.NEGATIVE_INFINITY;
  const right = b.takenAtMs ?? Number.NEGATIVE_INFINITY;
  if (left !== right) return right - left;
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
}

/** Oldest first: earlier instant wins; an undated entry sorts last; ties by name ascending. */
function oldestFirst(a: InventoryEntry, b: InventoryEntry): number {
  const left = a.takenAtMs ?? Number.POSITIVE_INFINITY;
  const right = b.takenAtMs ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The newest of a group, or — when none of them is datable — the first by name, so a group is never empty-handed. */
function newestOf(group: readonly InventoryEntry[]): InventoryEntry | null {
  if (group.length === 0) return null;
  const dated = group.filter((entry) => entry.takenAtMs !== null);
  if (dated.length > 0) return dated.slice().sort(newestFirst)[0]!;
  return group.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0]!;
}

/**
 * Read a manifest's `takenAt` as an instant, or refuse to.
 *
 * ISO 8601 ONLY, AND ONLY WHAT `Date` CAN PARSE BACK EXACTLY. `new Date('nonsense')` is `Invalid Date` and
 * `new Date('2026')` is a year, both of which would place a set in an ordering that decides what gets
 * destroyed. A value that does not round-trip to the instant it claims is treated as no date at all, which
 * makes the set `PROTECTED_UNDATED` rather than sorted somewhere arbitrary.
 */
export function instantOf(takenAt: unknown): { readonly takenAt: string; readonly takenAtMs: number } | null {
  if (typeof takenAt !== 'string' || takenAt.length < 20 || takenAt.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(takenAt)) return null;
  const ms = Date.parse(takenAt);
  if (!Number.isFinite(ms)) return null;
  return { takenAt, takenAtMs: ms };
}

// -----------------------------------------------------------------------------------------------------------
// How much a removal is allowed to walk
// -----------------------------------------------------------------------------------------------------------

/** The margin added to a set's declared entry count before a removal will walk it. */
export const REMOVAL_ENTRY_MARGIN = 64;

/**
 * The bound a recursive removal of THIS set is allowed to walk, derived from what the set declares itself
 * to be.
 *
 * WHY IT IS NOT A CONSTANT. `MAX_REMOVAL_ENTRIES` is a blanket 5000, which is simultaneously too small for a
 * set holding a large promotion-record archive and far larger than any evidence about the particular tree
 * being removed. A set's manifest records each component's entry count, so the tree being deleted has a
 * declared size — and a tree that turns out to hold substantially more than it declared is not the tree this
 * command verified. Doubling and adding a margin covers the directories the counts do not include (they
 * count files) without turning the bound back into a formality.
 */
export function removalEntryBound(declaredEntries: number): number {
  if (!Number.isInteger(declaredEntries) || declaredEntries < 0) {
    throw new MaintenanceRefused('this set does not declare how many entries it holds, so it will not be removed');
  }
  return declaredEntries * 2 + REMOVAL_ENTRY_MARGIN;
}
