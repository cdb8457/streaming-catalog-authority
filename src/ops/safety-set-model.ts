import { MaintenanceRefused } from './maintenance-safety.js';
import { MS_PER_DAY, type InventoryEntry } from './retention-model.js';

// Phases 313-315 — what a restore-created safety set IS, and which of them a policy may remove.
//
// THIS MODULE DECIDES AND IT DOES NOT ACT. Nothing here opens a file, renames anything or removes anything.
// It takes a claim inventory somebody else read, the ordinary inventory of the same destination, and a policy
// somebody typed, and produces one decision per claim with a closed reason. `safety-set-lifecycle.ts` reads
// the disk and performs the effects.
//
// WHY IT IS A SEPARATE VOCABULARY FROM `retention-model.ts`. `ops:backup-retention` classifies every
// dot-prefixed name in a destination as `RESERVED` and never descends, which is correct and is NOT relaxed by
// this tranche: a restore's claim directory is another operation's namespace, and one command reaching into
// another's in-flight artifacts is exactly the coupling that rule prevents. What a claim is made of — an
// ownership marker written by `ops:complete-restore`, a nonce it drew from the system CSPRNG, and one safety
// set published inside — is a different kind of evidence from what a published backup set is made of, and it
// deserves its own closed table rather than a sixth meaning bolted onto `SetClass`.

// -----------------------------------------------------------------------------------------------------------
// What a top-level entry in a backup destination can be, as far as THIS command is concerned
// -----------------------------------------------------------------------------------------------------------

/**
 * Every kind of thing this command can find where a restore claim might be. Total, closed, and only three of
 * them can ever be removed — each of those only when the directory carries a marker proving `ops:complete-restore`
 * of THIS build created it.
 *
 * `OWNED_*` MEANS THE MARKER PROVED IT, AND NOTHING ELSE DOES. A name of the right shape proves nothing: the
 * name is derived from a nonce that is written down inside the claim and inside the restore journal, so it is
 * published rather than secret, and any process can create a directory called `.pre-restore-claim-<hex>`.
 */
export type ClaimClass =
  /** Marker proved, holding exactly one backup set that VERIFIES. The ordinary, complete safety set. */
  | 'OWNED_SET'
  /** Marker proved, holding exactly one set that does not verify or whose manifest cannot be read. */
  | 'OWNED_UNVERIFIED'
  /** Marker proved, holding nothing but the marker: a claim made and never published into, or one whose set
   * an operator removed by hand. It holds no backup data at all. */
  | 'OWNED_EMPTY'
  /** Marker proved, holding a dot-prefixed in-flight artifact: a safety set is being taken into it right now,
   * or a killed `ops:complete-backup` left its staging tree behind. */
  | 'OWNED_IN_FLIGHT'
  /** Marker proved, holding something this build does not publish into a claim. Never removed. */
  | 'OWNED_UNEXPECTED'
  /** A claim marker of this product at a persisted schema this build does not implement. Never removed. */
  | 'OTHER_BUILD'
  /** Claim-shaped, and not provably this product's: no marker, an unreadable one, a foreign one, or one whose
   * nonce disagrees with the directory it is sitting in. Never removed. */
  | 'MALFORMED'
  /** It could not be examined or listed at all. A question is not answered by deleting what asked it. */
  | 'UNREADABLE'
  /** A link, a reparse point, a file or a device at a claim-shaped name. Never followed, never removed. */
  | 'NOT_A_DIRECTORY';

export const CLAIM_CLASSES: readonly ClaimClass[] = Object.freeze([
  'OWNED_SET', 'OWNED_UNVERIFIED', 'OWNED_EMPTY', 'OWNED_IN_FLIGHT', 'OWNED_UNEXPECTED', 'OTHER_BUILD',
  'MALFORMED', 'UNREADABLE', 'NOT_A_DIRECTORY',
]);

/**
 * The classes a policy may even consider. Everything else is protected by WHAT IT IS.
 *
 * Two of the three are additionally gated behind an explicit flag — see `SafetySetPolicy`. Being on this list
 * means "a policy is allowed to have an opinion", not "a default removes it".
 */
export const REMOVABLE_CLAIM_CLASSES: readonly ClaimClass[] =
  Object.freeze(['OWNED_SET', 'OWNED_UNVERIFIED', 'OWNED_EMPTY']);

/**
 * Why an entry is the class it is. A CLOSED VOCABULARY, printed beside every decision.
 *
 * It exists because "MALFORMED" alone tells an operator nothing about whether they should be worried: a claim
 * with no marker at all is a directory somebody made, and a claim whose marker names a different nonce is a
 * claim that has been MOVED, which is a different conversation.
 */
export type ClaimEvidence =
  | 'MARKER_PROVED'
  | 'NO_MARKER'
  | 'MARKER_UNREADABLE'
  | 'MARKER_NOT_OURS'
  | 'MARKER_OTHER_SCHEMA'
  | 'MARKER_MALFORMED'
  | 'MARKER_NAME_DISAGREES'
  | 'NOT_A_DIRECTORY'
  | 'UNLISTABLE'
  | 'SET_UNREADABLE'
  | 'SET_DOES_NOT_VERIFY'
  | 'EMPTY'
  | 'IN_FLIGHT_ARTIFACT'
  | 'UNEXPECTED_MEMBERS';

export const CLAIM_EVIDENCE: readonly ClaimEvidence[] = Object.freeze([
  'MARKER_PROVED', 'NO_MARKER', 'MARKER_UNREADABLE', 'MARKER_NOT_OURS', 'MARKER_OTHER_SCHEMA',
  'MARKER_MALFORMED', 'MARKER_NAME_DISAGREES', 'NOT_A_DIRECTORY', 'UNLISTABLE', 'SET_UNREADABLE',
  'SET_DOES_NOT_VERIFY', 'EMPTY', 'IN_FLIGHT_ARTIFACT', 'UNEXPECTED_MEMBERS',
]);

/** What each evidence value means, in the operator's words. Rendered; never re-typed at a call site. */
export const CLAIM_EVIDENCE_TEXT: Readonly<Record<ClaimEvidence, string>> = Object.freeze({
  MARKER_PROVED: 'the ownership marker inside it proves a restore of this build created it',
  NO_MARKER: 'it carries no ownership marker, so nothing here can say a restore of ours made it',
  MARKER_UNREADABLE: 'its ownership marker could not be read',
  MARKER_NOT_OURS: 'its ownership marker is not one this product writes',
  MARKER_OTHER_SCHEMA: 'its ownership marker was written at a persisted schema this build does not implement',
  MARKER_MALFORMED: 'its ownership marker does not hold together — the fields inside it disagree',
  MARKER_NAME_DISAGREES: 'its ownership marker names a different directory, so this claim has been MOVED',
  NOT_A_DIRECTORY: 'it is a link, a reparse point or a file rather than a directory',
  UNLISTABLE: 'it could not be listed',
  SET_UNREADABLE: 'the safety set inside it could not be read',
  SET_DOES_NOT_VERIFY: 'the safety set inside it does not verify',
  EMPTY: 'it holds no safety set at all — only the marker',
  IN_FLIGHT_ARTIFACT: 'it holds an in-flight artifact, so a safety set is, or was, part way through being taken into it',
  UNEXPECTED_MEMBERS: 'it holds something this build does not publish into a claim',
});

/**
 * One top-level entry, as this command sees it.
 *
 * NO PATH EVER APPEARS HERE. `name` is the directory's own name inside the destination and `setName` is the
 * safety set's own name inside the claim; a report renders these and nothing else.
 */
export interface ClaimInventoryEntry {
  readonly name: string;
  readonly claimClass: ClaimClass;
  readonly evidence: ClaimEvidence;
  /** The nonce the PROVED marker carries. Null for everything that is not proved ours. */
  readonly nonce: string | null;
  /** The plan digest of the restore that made this claim, from the PROVED marker. Empty when not proved. */
  readonly claimDigest: string;
  /** The safety set's own directory name inside the claim, when there is exactly one. */
  readonly setName: string | null;
  /** Phase 278's verification digest over what the safety set's manifest declares. Empty when there is none. */
  readonly setDigest: string;
  readonly takenAt: string | null;
  readonly takenAtMs: number | null;
  readonly schemaVersion: number | null;
  /** `restorableUnderThisBuild` for the safety set. A verified ROLLBACK POINT is intact and is NOT this. */
  readonly restorable: boolean;
  readonly bytes: number;
  readonly entries: number;
  readonly findings: readonly string[];
  /**
   * The claim directory's own modification time, in epoch milliseconds.
   *
   * WEAKER EVIDENCE, AND IT IS ONLY EVER USED FOR ONE THING: the age of an EMPTY claim, which by definition
   * has no manifest and therefore no date of its own. It is filesystem metadata that a copy, a restore of the
   * backups folder itself or a `touch` can move, and the plan says so beside every decision that rests on it.
   * Nothing that holds a backup set is ever aged by this.
   */
  readonly observedAtMs: number | null;
}

// -----------------------------------------------------------------------------------------------------------
// Phase 314 — the policy
// -----------------------------------------------------------------------------------------------------------

export interface SafetySetPolicy {
  /** How many of the newest COMPLETE safety sets to keep. Counts `OWNED_SET` claims only. */
  readonly keepLast: number;
  /** Nothing taken within this many days is removable, whatever the window says. */
  readonly minAgeDays: number;
  /** Make claims whose safety set does not verify candidates too. Off by default. */
  readonly includeUnverified: boolean;
  /** Make claims that hold no safety set at all candidates. Off by default; aged by mtime, which is weaker. */
  readonly includeEmptyClaims: boolean;
  /**
   * The floor, and it is counted over the WHOLE DESTINATION.
   *
   * THIS IS THE PROTECTION THAT MAKES THIS COMMAND DIFFERENT FROM RETENTION. A safety set is the backup of an
   * installation taken immediately before a restore destroyed it, and on the day a restore went wrong it can
   * be the only thing in the destination this build could put back. So the floor is not "leave N safety
   * sets": it is "leave N sets this build could restore, counting the ordinary sets at the top level AND the
   * safety sets inside claims". A destination whose only restorable material is a safety set will not have it
   * removed by any value of `--keep-last`.
   */
  readonly keepMinimumRestorable: number;
}

export const DEFAULT_SAFETY_SET_POLICY: SafetySetPolicy = Object.freeze({
  keepLast: 3,
  minAgeDays: 14,
  includeUnverified: false,
  includeEmptyClaims: false,
  keepMinimumRestorable: 1,
});

export const MAX_SAFETY_KEEP_LAST = 1000;
export const MAX_SAFETY_MIN_AGE_DAYS = 3650;
export const MAX_SAFETY_KEEP_MINIMUM = 100;

/**
 * Refuse a policy that is not a policy.
 *
 * THE DEFAULTS ARE MORE CONSERVATIVE THAN RETENTION'S AND THAT IS DELIBERATE. A nightly backup is one of many
 * taken from a healthy installation; a safety set is the single snapshot of a moment nobody will ever be able
 * to reproduce — the state immediately before somebody destroyed it on purpose. Fourteen days rather than
 * seven, and three rather than seven, because the pile grows one per restore rather than one per night.
 */
export function assertUsableSafetyPolicy(policy: SafetySetPolicy): void {
  const whole = (value: number): boolean => Number.isInteger(value) && Number.isFinite(value);
  if (!whole(policy.keepLast) || policy.keepLast < 1 || policy.keepLast > MAX_SAFETY_KEEP_LAST) {
    throw new MaintenanceRefused(
      `--keep-last must be a whole number from 1 to ${MAX_SAFETY_KEEP_LAST}. There is no value that means `
      + '"keep none": this command has no mode that removes every safety set a destination holds.');
  }
  if (!whole(policy.minAgeDays) || policy.minAgeDays < 0 || policy.minAgeDays > MAX_SAFETY_MIN_AGE_DAYS) {
    throw new MaintenanceRefused(`--min-age-days must be a whole number from 0 to ${MAX_SAFETY_MIN_AGE_DAYS}`);
  }
  if (!whole(policy.keepMinimumRestorable) || policy.keepMinimumRestorable < 1
    || policy.keepMinimumRestorable > MAX_SAFETY_KEEP_MINIMUM) {
    throw new MaintenanceRefused(
      `--keep-minimum-restorable must be a whole number from 1 to ${MAX_SAFETY_KEEP_MINIMUM}. It cannot be `
      + 'zero: a run that is allowed to leave this installation with nothing it could restore from is not a '
      + 'lifecycle run.');
  }
}

// -----------------------------------------------------------------------------------------------------------
// Phase 315 — the decision
// -----------------------------------------------------------------------------------------------------------

export type SafetySetReason =
  // Protections. The first three are unconditional: no flag reaches past them.
  | 'PROTECTED_NOT_PROVED_OURS'
  | 'PROTECTED_NEWEST_RESTORABLE'
  | 'PROTECTED_NEWEST_ROLLBACK_POINT'
  | 'PROTECTED_IN_FLIGHT'
  | 'PROTECTED_UNEXPECTED_CONTENTS'
  | 'PROTECTED_NO_IDENTITY'
  | 'PROTECTED_UNVERIFIED'
  | 'PROTECTED_EMPTY_CLAIM'
  | 'PROTECTED_UNDATED'
  | 'PROTECTED_MIN_AGE'
  | 'PROTECTED_KEEP_WINDOW'
  // Removals.
  | 'BEYOND_KEEP_WINDOW'
  | 'UNVERIFIED_SAFETY_SET'
  | 'EMPTY_CLAIM';

/** Every reason, in the order they are evaluated. Exported so a suite can assert the vocabulary is closed. */
export const SAFETY_SET_REASONS: readonly SafetySetReason[] = Object.freeze([
  'PROTECTED_NOT_PROVED_OURS',
  'PROTECTED_NEWEST_RESTORABLE',
  'PROTECTED_NEWEST_ROLLBACK_POINT',
  'PROTECTED_IN_FLIGHT',
  'PROTECTED_UNEXPECTED_CONTENTS',
  'PROTECTED_NO_IDENTITY',
  'PROTECTED_UNVERIFIED',
  'PROTECTED_EMPTY_CLAIM',
  'PROTECTED_UNDATED',
  'PROTECTED_MIN_AGE',
  'PROTECTED_KEEP_WINDOW',
  'BEYOND_KEEP_WINDOW',
  'UNVERIFIED_SAFETY_SET',
  'EMPTY_CLAIM',
]);

export const SAFETY_SET_REASON_TEXT: Readonly<Record<SafetySetReason, string>> = Object.freeze({
  PROTECTED_NOT_PROVED_OURS:
    'nothing here proves a restore of this build created it, so it is not this command\'s to remove.',
  PROTECTED_NEWEST_RESTORABLE:
    'the newest safety set this build could actually restore. Nothing removes this one.',
  PROTECTED_NEWEST_ROLLBACK_POINT:
    'the newest safety set from before this build\'s schema — the only safety set that can roll this '
    + 'installation back, and by definition not restorable here. Nothing removes this one either.',
  PROTECTED_IN_FLIGHT:
    'a safety set is, or was, part way through being taken into it. A run that removed this would be '
    + 'removing the backup another operation is still writing.',
  PROTECTED_UNEXPECTED_CONTENTS:
    'it holds something this build does not publish into a claim, so what removing it would destroy is '
    + 'not a thing this command can describe.',
  PROTECTED_NO_IDENTITY:
    'the safety set inside it could not be examined at all, so this build recorded no identity for it — and '
    + 'there is nothing a removal could commit to. No flag reaches past this one either.',
  PROTECTED_UNVERIFIED: 'its safety set does not verify, and --include-unverified was not given.',
  PROTECTED_EMPTY_CLAIM: 'it holds no safety set, and --include-empty-claims was not given.',
  PROTECTED_UNDATED: 'there is no usable date for it at all, so it has no place in an ordering.',
  PROTECTED_MIN_AGE: 'it is younger than --min-age-days.',
  PROTECTED_KEEP_WINDOW: 'it is inside --keep-last.',
  BEYOND_KEEP_WINDOW: 'older than the newest --keep-last complete safety sets.',
  UNVERIFIED_SAFETY_SET: 'its safety set does not verify, and --include-unverified was given.',
  EMPTY_CLAIM:
    'it holds no safety set at all and --include-empty-claims was given. Its age is the directory\'s '
    + 'modification time, which is weaker evidence than a manifest.',
});

export interface SafetySetDecision {
  readonly name: string;
  readonly decision: 'keep' | 'remove';
  readonly reason: SafetySetReason;
}

export type SafetySetRefusal = 'NO_RESTORABLE_SET' | 'FLOOR_NOT_MET';

export interface SafetySetEvaluation {
  /** One decision per claim, in the inventory's canonical order. */
  readonly decisions: readonly SafetySetDecision[];
  /** The names to remove, OLDEST FIRST, so an interrupted run has taken the least valuable ones. */
  readonly removals: readonly string[];
  /** The claim protected as `PROTECTED_NEWEST_RESTORABLE`, or null when there is no restorable safety set. */
  readonly protectedNewestRestorable: string | null;
  /** The claim protected as `PROTECTED_NEWEST_ROLLBACK_POINT`, or null when there is none. */
  readonly protectedNewestRollbackPoint: string | null;
  /**
   * How many sets this build could restore would remain IN THE WHOLE DESTINATION — the ordinary top-level
   * sets plus the safety sets inside claims that survive. The floor is checked against THIS, recounted
   * independently rather than accumulated while deciding.
   */
  readonly restorableRemaining: number;
  /** How many of that count are ordinary top-level sets. Printed, so an operator can see where the floor is met. */
  readonly restorableTopLevel: number;
  readonly refusals: readonly SafetySetRefusal[];
}

/**
 * Decide, from a claim inventory, the destination's ordinary inventory and a policy, what a run would do.
 *
 * PROTECTION IS EVALUATED BEFORE THE WINDOW AND IT WINS. The order of the branches below is the whole safety
 * argument, and it is written once:
 *
 *   1. not proved ours              — nothing else is even asked
 *   2. the newest restorable        — unconditional
 *   3. the newest rollback point    — unconditional
 *   4. in flight                    — something else is writing into it
 *   5. unexpected contents          — this command cannot describe what it would destroy
 *   6. no recorded identity         — unconditional: there is nothing a removal could commit to
 *   7. unverified, not included
 *   8. empty, not included
 *   9. undated                      — unorderable, so no policy about an order applies to it
 *  10. too young
 *  11. inside the keep window
 *  12. otherwise: remove
 *
 * THE KEEP WINDOW RANKS COMPLETE SAFETY SETS ONLY. A claim whose set does not verify protects nobody, so
 * letting one occupy a slot in "keep the newest three" would silently make it two — and the third, which is
 * the one furthest back, is the one most likely to be the last good record of a moment nobody can reproduce.
 */
export function evaluateSafetySetLifecycle(
  claims: readonly ClaimInventoryEntry[],
  destination: readonly InventoryEntry[],
  policy: SafetySetPolicy,
  now: Date,
): SafetySetEvaluation {
  assertUsableSafetyPolicy(policy);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new MaintenanceRefused('the clock this run was given is not a usable time');

  // THE NEWEST OF EACH KIND, among claims whose set is COMPLETE. Ties broken by name so the answer is total.
  // A restorable safety set with no usable date cannot be "newest" — but it must still be protected as the
  // last good one, so it is chosen by name when nothing in its group is datable at all.
  const restorable = claims.filter((claim) => claim.claimClass === 'OWNED_SET' && claim.restorable);
  const rollbackPoints = claims.filter((claim) => claim.claimClass === 'OWNED_SET' && !claim.restorable);
  const newestRestorable = newestOf(restorable);
  const newestRollbackPoint = newestOf(rollbackPoints);

  // THE WINDOW. Complete, datable safety sets, newest first; the rank is the position in that list.
  const rank = new Map<string, number>();
  for (const [index, claim] of claims
    .filter((claim) => claim.claimClass === 'OWNED_SET' && claim.takenAtMs !== null)
    .slice()
    .sort(newestFirst)
    .entries()) {
    rank.set(claim.name, index);
  }

  const minAgeMs = policy.minAgeDays * MS_PER_DAY;
  const decisions: SafetySetDecision[] = claims.map((claim) => ({ name: claim.name, ...decide(claim) }));

  function decide(claim: ClaimInventoryEntry): { decision: 'keep' | 'remove'; reason: SafetySetReason } {
    if (!REMOVABLE_CLAIM_CLASSES.includes(claim.claimClass)) {
      if (claim.claimClass === 'OWNED_IN_FLIGHT') return keep('PROTECTED_IN_FLIGHT');
      if (claim.claimClass === 'OWNED_UNEXPECTED') return keep('PROTECTED_UNEXPECTED_CONTENTS');
      return keep('PROTECTED_NOT_PROVED_OURS');
    }
    if (newestRestorable !== null && claim.name === newestRestorable.name) {
      return keep('PROTECTED_NEWEST_RESTORABLE');
    }
    if (newestRollbackPoint !== null && claim.name === newestRollbackPoint.name) {
      return keep('PROTECTED_NEWEST_ROLLBACK_POINT');
    }
    // NOTHING WITHOUT AN IDENTITY IS EVER A CANDIDATE, AND THAT IS UNCONDITIONAL.
    //
    // THE DEFECT THIS CLOSES. A claim whose safety set could not be examined at all — an unreadable manifest,
    // a verification that threw — carries no `setDigest`, and `proveBackupSetIdentity` refuses to act on a
    // commitment with no identity in it. So `--include-unverified` could produce a plan naming that claim, an
    // operator could confirm it, and the run would then STOP on it at the first proof — leaving every later
    // candidate untouched and the operation permanently unable to finish. A candidate a run can never
    // perform is not a candidate; it is a plan that lies. An EMPTY claim legitimately has no set digest and
    // is judged by its own rule below.
    if (claim.claimClass !== 'OWNED_EMPTY' && claim.setDigest === '') return keep('PROTECTED_NO_IDENTITY');
    if (claim.claimClass === 'OWNED_UNVERIFIED' && !policy.includeUnverified) return keep('PROTECTED_UNVERIFIED');
    if (claim.claimClass === 'OWNED_EMPTY' && !policy.includeEmptyClaims) return keep('PROTECTED_EMPTY_CLAIM');
    const ageBasis = ageBasisMs(claim);
    if (ageBasis === null) return keep('PROTECTED_UNDATED');
    // A CLAIM WHOSE RECORDED INSTANT IS IN THE FUTURE is younger than any bound, so it is protected by this
    // same branch rather than by a separate rule. With `--min-age-days 0` it is still protected, because a
    // safety set that claims to have been taken after now is one whose date this command will not act on.
    if (nowMs - ageBasis < Math.max(minAgeMs, 1)) return keep('PROTECTED_MIN_AGE');
    const position = rank.get(claim.name);
    if (position !== undefined && position < policy.keepLast) return keep('PROTECTED_KEEP_WINDOW');
    if (claim.claimClass === 'OWNED_EMPTY') return { decision: 'remove', reason: 'EMPTY_CLAIM' };
    return {
      decision: 'remove',
      reason: claim.claimClass === 'OWNED_SET' ? 'BEYOND_KEEP_WINDOW' : 'UNVERIFIED_SAFETY_SET',
    };
  }

  const removing = new Set(decisions.filter((decision) => decision.decision === 'remove').map((d) => d.name));
  // OLDEST FIRST. An interrupted run has then destroyed the least valuable claims it was going to, and the
  // order is deterministic so a resume continues the same list rather than re-deciding it.
  const removals = claims
    .filter((claim) => removing.has(claim.name))
    .slice()
    .sort(oldestFirst)
    .map((claim) => claim.name);

  // THE FLOOR IS AN INDEPENDENT RECOUNT OVER THE WHOLE DESTINATION. It is deliberately NOT accumulated inside
  // `decide`: a check that agrees with the thing it is checking cannot catch it being wrong. And it counts
  // the ordinary sets too, because "is there still something this build could restore from" is a question
  // about the destination and not about this command's own candidates.
  const restorableTopLevel = destination
    .filter((entry) => entry.setClass === 'VERIFIED' && entry.restorable).length;
  const restorableSafetyRemaining = restorable.filter((claim) => !removing.has(claim.name)).length;
  const restorableRemaining = restorableTopLevel + restorableSafetyRemaining;

  const refusals: SafetySetRefusal[] = [];
  if (restorableTopLevel + restorable.length === 0) refusals.push('NO_RESTORABLE_SET');
  else if (restorableRemaining < policy.keepMinimumRestorable) refusals.push('FLOOR_NOT_MET');

  return {
    decisions,
    removals,
    protectedNewestRestorable: newestRestorable === null ? null : newestRestorable.name,
    protectedNewestRollbackPoint: newestRollbackPoint === null ? null : newestRollbackPoint.name,
    restorableRemaining,
    restorableTopLevel,
    refusals,
  };
}

/**
 * The instant a claim's age is measured from, or null when there is none.
 *
 * A MANIFEST'S DATE WHEREVER THERE IS ONE. The directory's modification time is used ONLY for a claim that
 * holds no set — there is nothing else to use, and it is stated as the weaker evidence it is rather than
 * quietly mixed in with dates that came out of a manifest.
 */
export function ageBasisMs(claim: ClaimInventoryEntry): number | null {
  if (claim.takenAtMs !== null) return claim.takenAtMs;
  if (claim.claimClass === 'OWNED_EMPTY') return claim.observedAtMs;
  return null;
}

function keep(reason: SafetySetReason): { decision: 'keep'; reason: SafetySetReason } {
  return { decision: 'keep', reason };
}

/** Newest first: later instant wins; an undated claim sorts last; ties by name descending. */
function newestFirst(a: ClaimInventoryEntry, b: ClaimInventoryEntry): number {
  const left = a.takenAtMs ?? Number.NEGATIVE_INFINITY;
  const right = b.takenAtMs ?? Number.NEGATIVE_INFINITY;
  if (left !== right) return right - left;
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
}

/** Oldest first, over whatever age basis each claim actually has; undated sorts last; ties by name ascending. */
function oldestFirst(a: ClaimInventoryEntry, b: ClaimInventoryEntry): number {
  const left = ageBasisMs(a) ?? Number.POSITIVE_INFINITY;
  const right = ageBasisMs(b) ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The newest of a group, or — when none of them is datable — the first by name, so a group is never empty-handed. */
function newestOf(group: readonly ClaimInventoryEntry[]): ClaimInventoryEntry | null {
  if (group.length === 0) return null;
  const dated = group.filter((claim) => claim.takenAtMs !== null);
  if (dated.length > 0) return dated.slice().sort(newestFirst)[0]!;
  return group.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0]!;
}
