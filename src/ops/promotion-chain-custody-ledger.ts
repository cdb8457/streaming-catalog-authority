import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
// The one exact UTC timestamp rule for this chain -- shared, not restated, so it cannot drift per phase.
import { isExactUtcTimestamp } from './promotion-utc-timestamp.js';
// Phase 238's canonicalization, imported rather than reimplemented: one serialization rule for the stack, a
// different scope per phase. There is no second copy here to drift from it.
import { canonicalJson } from './promotion-supplied-source-record-verification.js';

// Phase 239: local, non-live APPEND-ONLY PROMOTION-CHAIN CUSTODY LEDGER validator, layered on the Phase 238
// source-record verification.
//
// WHY IT EXISTS. Phase 238 proves the supplied records match what was committed. It says nothing about who has
// held those records since, or in what order custody moved. This phase validates a separately supplied
// sequence of human custody events as a hash-linked, append-only ledger: monotonic sequence, each event naming
// the digest of the one before it, a fixed transition enum, a custodian digest, a strict UTC time, and the
// chain bindings that tie every event to this one operation.
//
// IT NEVER INFERS CUSTODY. This module creates no event, completes no event, and upgrades no ledger. The
// genesis skeleton it can emit is blank -- custodian and time PENDING -- and a blank genesis is exactly the
// un-started state, CUSTODY_LEDGER_PENDING. Nothing here ever manufactures a custody claim.
//
// WHAT THIS DOES AND DOES NOT PROVE -- the honest limit, and it must not be softened. Event digests are NOT
// signatures. The hash chain makes an edit to any event that HAS SUCCESSORS detectable, because every
// following link breaks. It does NOT protect the tail: resealing the last event, appending to it, or
// rebuilding the entire ledger from genesis is undetectable to this validator, because anyone can recompute
// every digest. Truncating the TAIL is likewise undetectable -- only a GAP or a missing genesis is. So this
// ledger is append-only-EVIDENT to a party who retained an earlier copy to compare against, not
// append-only-ENFORCED. It records a custody narrative; it does not establish custody, authorship, or that any
// event described here ever occurred.
//
// NOT_ELIGIBLE takes PRECEDENCE over everything: without a sound Phase 238 SOURCE_RECORDS_VERIFIED there is
// nothing for custody to be OF, and no ledger can override that. That is what locks the actual prepared
// P227-A chain, whose Phase 238 result is itself NOT_ELIGIBLE because its replay never closed.
//
// ELIGIBILITY IS CHECKED ON THE WHOLE BODY, NOT THE HEADLINE -- standing practice in this stack since the
// Phase 234/235 hardening. A self-digest is not a signature, so a forged verification can carry a green
// `overall` over a body that failed Phase 238's own checks and still recompute cleanly.
//
// It holds no custody and creates no events: `custodyHeldByThisTool`, `eventsCreatedByThisTool` and
// `selfAuthorized` are the constants false. It never runs the promotion launcher, reads or writes the real
// Movies library, contacts Jellyfin, or reads the secret approval file.
//
// The emitted report is redaction-safe: per-event sequence numbers, fixed transition enums, link booleans,
// counts, fixed value-free codes and the already-public chain digests only -- never a custodian identity, a
// timestamp, a raw path or a live identifier.

const VERIFICATION_REPORT_ID = 'phase-238-promotion-supplied-source-record-verification';
const OPERATION = 'promote-observe-withdraw';
const VERIFIED = 'SOURCE_RECORDS_VERIFIED';

export const CUSTODY_EVENT_INPUT_ID = 'phase-239-promotion-chain-custody-event';

// The sentinel a genesis event carries in place of a previous-event digest. Fixed and value-free.
export const CUSTODY_GENESIS_SENTINEL = 'GENESIS';
const PLACEHOLDER = 'PENDING';
const EVENT_DIGEST_SCOPE = 'phase-239-custody-event';

export type CustodyTransition =
  | 'GENESIS'
  | 'CUSTODY_ACCEPTED'
  | 'CUSTODY_RETAINED'
  | 'CUSTODY_TRANSFERRED'
  | 'CUSTODY_RELEASED';

const TRANSITIONS: readonly string[] = ['GENESIS', 'CUSTODY_ACCEPTED', 'CUSTODY_RETAINED', 'CUSTODY_TRANSFERRED', 'CUSTODY_RELEASED'];

// The transition matrix. GENESIS opens the ledger and may only be followed by an acceptance; a transfer is
// only ever followed by the receiving custodian accepting; a release is TERMINAL and admits no successor.
const ALLOWED_NEXT: Readonly<Record<string, readonly string[]>> = {
  GENESIS: ['CUSTODY_ACCEPTED'],
  CUSTODY_ACCEPTED: ['CUSTODY_RETAINED', 'CUSTODY_TRANSFERRED', 'CUSTODY_RELEASED'],
  CUSTODY_RETAINED: ['CUSTODY_RETAINED', 'CUSTODY_TRANSFERRED', 'CUSTODY_RELEASED'],
  CUSTODY_TRANSFERRED: ['CUSTODY_ACCEPTED'],
  CUSTODY_RELEASED: [],
};

// The five operation digests, as Phase 238 republishes them in its own bindings.
const OPERATION_DIGEST_FIELDS: readonly string[] = ['approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest'];

// Strict top-level allowlist: anything else is smuggled content and fails closed.
const EVENT_KEYS: readonly string[] = [
  'record', 'version', 'operation', 'sourceVerificationReport', 'verificationDigest',
  ...OPERATION_DIGEST_FIELDS, 'sequence', 'previousEventDigest', 'transition', 'custodianDigest',
  'occurredAtUtc', 'eventDigest',
];

export interface CustodyLedgerInput {
  readonly verification?: unknown;  // phase-238-promotion-supplied-source-record-verification report
  readonly events?: unknown;        // the separately supplied array of human custody events
}

// One custody event, as a human writes it. Digest-only: no path, no id, no identity in the clear.
export interface CustodyEvent {
  readonly record: typeof CUSTODY_EVENT_INPUT_ID;
  readonly version: 1;
  readonly operation: typeof OPERATION;
  readonly sourceVerificationReport: typeof VERIFICATION_REPORT_ID;
  readonly verificationDigest: string;
  readonly approvalIdDigest: string;
  readonly itemDigest: string;
  readonly sourceDigest: string;
  readonly destinationDigest: string;
  readonly planDigest: string;
  readonly sequence: number;
  readonly previousEventDigest: string;
  readonly transition: CustodyTransition;
  readonly custodianDigest: string;
  readonly occurredAtUtc: string;
  readonly eventDigest: string;
}

export const CUSTODY_LEDGER_REMAINING_HUMAN_STEPS: readonly string[] = [
  'Retention of an earlier copy of this ledger by an independent party: without one, a wholesale rebuild from genesis is undetectable here.',
  'Human judgement about whether the custody narrative these events describe actually happened -- a question no digest can answer.',
  'Any identity verification of a custodian: this validator records a digest, never a person.',
  'Appending any further event, which is a human act performed out-of-band; this validator creates nothing.',
];

export const CUSTODY_LEDGER_BOUNDARY =
  'No promotion launcher run, no withdrawal run, no remediation, no archival, no observed-state capture, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, no record retrieval, no identity verification, no event creation, and no self-authorization: this validator only checks a separately supplied ledger of custody events.';

export const CUSTODY_LEDGER_DISCLAIMERS: readonly string[] = [
  'Event digests are NOT signatures. This ledger records a custody narrative; it does not establish custody, authorship, or that any event described here occurred.',
  'The hash chain makes an edit to any event WITH SUCCESSORS detectable, because every following link breaks.',
  'It does NOT protect the tail: resealing the last event, appending to it, or rebuilding the whole ledger from genesis is undetectable here, because anyone can recompute every digest.',
  'Truncating the TAIL is likewise undetectable -- only a GAP in the sequence or a missing genesis is.',
  'So this ledger is append-only-EVIDENT to a party who retained an earlier copy to compare against, not append-only-ENFORCED.',
  'CUSTODY_LEDGER_PENDING is the un-started state: a blank genesis claims nothing, and this validator never infers, completes or upgrades custody.',
  'NOT_ELIGIBLE means there is no verified source-record set for custody to be OF -- it is not a defect in the supplied events, and no ledger can override it.',
];

export interface CustodyEventState {
  readonly sequence: number;
  readonly transition: CustodyTransition | 'INVALID';
  readonly digestRecomputed: boolean;         // the stated eventDigest recomputes from the body: not resealed
  readonly linkedToPrevious: boolean | null;  // null for genesis: it has no predecessor to link to
  readonly boundToOperation: boolean;         // verification digest + all five operation digests match
  readonly custodied: boolean;                // a real custodian digest and a real timestamp
}

export interface CustodyLedgerReport {
  readonly report: 'phase-239-promotion-chain-custody-ledger';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly custodyHeldByThisTool: false;
  readonly eventsCreatedByThisTool: false;
  readonly selfAuthorized: false;
  readonly overall:
    | 'CUSTODY_LEDGER_INTACT'
    | 'CUSTODY_LEDGER_PENDING'
    | 'CUSTODY_LEDGER_INVALID'
    | 'NOT_ELIGIBLE';
  readonly ledgerIntact: boolean;
  readonly verificationEligible: boolean;
  readonly eventsWellFormed: boolean;
  readonly eventsRedactionSafe: boolean;
  readonly chainLinked: boolean;
  readonly transitionsValid: boolean;
  readonly eventCount: number;
  readonly events: readonly CustodyEventState[];
  readonly terminalTransition: CustodyTransition | 'NONE';
  readonly headEventDigest: string | null;
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly remainingHumanSteps: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly ledgerDigest: string;
}

// THE EVENT DIGEST RULE, exported so a custodian appending an event and this validator compute the same value.
// Canonical (recursively key-sorted) JSON of every key EXCEPT `eventDigest`, under a fixed scope. Reuses
// Phase 238's exported canonicalization, so key order in a hand-written event never changes the digest.
export function computeCustodyEventDigest(event: unknown): string {
  const obj = asObject(event);
  const body: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (k !== 'eventDigest') body[k] = obj[k];
  return digest(EVENT_DIGEST_SCOPE, canonicalJson(body));
}

export function buildCustodyLedger(input: CustodyLedgerInput): CustodyLedgerReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // (1) The Phase 238 verification. Anything wrong here means there is nothing for custody to be OF:
  //     NOT_ELIGIBLE, never INVALID.
  const verification = validateVerificationReport(input.verification, blockers);
  const verificationEligible = verification.ok;
  if (verificationEligible) {
    boundDigests['verification-report'] = verification.verificationDigest!;
    for (const f of OPERATION_DIGEST_FIELDS) boundDigests[f] = verification.operationDigests[f]!;
  }

  // (2) The supplied events. Never inferred: an absent ledger is an absent ledger, not an empty one.
  const rawEvents = input.events;
  let suppliedEvents: unknown[] | null = null;
  if (rawEvents === undefined) blockers.push('LEDGER_EVENTS_MISSING');
  else if (!Array.isArray(rawEvents)) blockers.push('LEDGER_EVENTS_INVALID');
  else if (rawEvents.length === 0) blockers.push('LEDGER_EMPTY');
  else suppliedEvents = rawEvents;

  // (3) Redaction. These events are HAND-WRITTEN by custodians, so they get the strict live-surface predicate,
  //     not the raw-path-marker scanner reserved for generated reports.
  const eventsRedactionSafe = rawEvents === undefined ? false : !deepLiveSurface(rawEvents);
  if (rawEvents !== undefined && !eventsRedactionSafe) blockers.push('LEDGER_EVENTS_LIVE_SURFACE');

  // (4) Per-event shape and bindings, before any structural reasoning about the chain.
  const parsed: ParsedEvent[] = [];
  let eventsWellFormed = suppliedEvents !== null;
  if (suppliedEvents !== null) {
    for (const value of suppliedEvents) {
      const p = parseEvent(value, verification, blockers);
      if (!p.ok) eventsWellFormed = false;
      parsed.push(p);
    }
  }

  // (5) REORDER is judged on the SUPPLIED order alone, then every structural check below runs over a
  //     sequence-sorted copy. That isolation matters: a ledger that is merely out of order reports exactly
  //     that, instead of an avalanche of link failures that hide the real finding.
  const usable = parsed.filter((p) => p.sequence !== undefined);
  let ascending = true;
  for (let i = 1; i < usable.length; i++) if (usable[i]!.sequence! <= usable[i - 1]!.sequence!) ascending = false;
  if (!ascending) blockers.push('LEDGER_REORDER_DETECTED');
  const ordered = [...usable].sort((a, b) => a.sequence! - b.sequence!);

  // (6) DUPLICATE -- a repeated sequence, or a repeated event digest.
  const seenSequences = new Set<number>();
  let duplicateSequence = false;
  for (const p of ordered) { if (seenSequences.has(p.sequence!)) duplicateSequence = true; seenSequences.add(p.sequence!); }
  if (duplicateSequence) blockers.push('LEDGER_DUPLICATE_SEQUENCE');
  const seenDigests = new Set<string>();
  let duplicateDigest = false;
  for (const p of ordered) {
    const d = p.statedDigest;
    if (d === undefined) continue;
    if (seenDigests.has(d)) duplicateDigest = true;
    seenDigests.add(d);
  }
  if (duplicateDigest) blockers.push('LEDGER_DUPLICATE_EVENT_DIGEST');

  // (7) TRUNCATION -- the sequence set must be exactly 0..n-1. NOTE the honest limit: dropping the TAIL leaves
  //     a contiguous set and is undetectable here; only a GAP or a missing genesis is caught.
  if (ordered.length > 0) {
    const contiguous = ordered.every((p, i) => p.sequence === i);
    if (!contiguous) blockers.push('LEDGER_TRUNCATION_DETECTED');
    if (ordered[0]!.sequence !== 0) blockers.push('LEDGER_GENESIS_MISSING');
  }

  // (8) RESEAL -- the stated digest must recompute from the event's own body.
  for (const p of ordered) {
    if (p.statedDigest === undefined || p.recomputedDigest === undefined) continue;
    if (p.statedDigest !== p.recomputedDigest) { blockers.push('LEDGER_RESEAL_DETECTED'); p.resealed = true; }
  }

  // (9) FORK -- two or more events naming the SAME parent. Checked independently of the link walk, so a
  //     genuine fork is reported as a fork and not merely as a broken link.
  const parentCounts = new Map<string, number>();
  for (const p of ordered) {
    // The genesis sentinel counts as a parent too: two events both claiming to open the ledger is a fork.
    const parent = p.previousIsGenesis ? CUSTODY_GENESIS_SENTINEL : p.previousDigest;
    if (parent === undefined) continue;
    parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
  }
  if ([...parentCounts.values()].some((n) => n > 1)) blockers.push('LEDGER_FORK_DETECTED');

  // (10) SPLICE -- each non-genesis event must name the RECOMPUTED digest of the event before it. Comparing
  //      against the recomputed value, not the stated one, is what makes a mid-ledger edit surface here: the
  //      editor may reseal the event they touched, but every later link still points at the old digest.
  let chainLinked = ordered.length > 0;
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i]!;
    if (i === 0) {
      p.linked = null;
      if (p.previousDigest !== undefined) { chainLinked = false; blockers.push('LEDGER_GENESIS_HAS_PREDECESSOR'); }
      continue;
    }
    const prev = ordered[i - 1]!;
    const expected = prev.recomputedDigest;
    const link = p.previousDigest !== undefined && expected !== undefined && p.previousDigest === expected;
    p.linked = link;
    if (!link) { chainLinked = false; blockers.push('LEDGER_SPLICE_DETECTED'); }
  }

  // (11) The transition matrix, the genesis position, and the RELEASED terminal.
  let transitionsValid = ordered.length > 0;
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i]!;
    if (p.transition === undefined) { transitionsValid = false; continue; }
    if (i === 0 && p.transition !== 'GENESIS') { blockers.push('LEDGER_GENESIS_MISPLACED'); transitionsValid = false; }
    if (i > 0 && p.transition === 'GENESIS') { blockers.push('LEDGER_GENESIS_MISPLACED'); transitionsValid = false; }
    if (i === 0) continue;
    const prev = ordered[i - 1]!;
    if (prev.transition === undefined) { transitionsValid = false; continue; }
    if (prev.transition === 'CUSTODY_RELEASED') {
      blockers.push('LEDGER_TERMINAL_CONTINUED'); transitionsValid = false; continue;
    }
    if (!(ALLOWED_NEXT[prev.transition] ?? []).includes(p.transition)) {
      blockers.push('LEDGER_INVALID_TRANSITION'); transitionsValid = false; continue;
    }
    // A transfer that does not move custody is not a transfer. TRANSFERRED -> ACCEPTED is the only
    // continuation of a transfer, so allowing the same custodian on both sides would let a ledger grow
    // arbitrarily long while recording no change of hands at all.
    if (prev.transition === 'CUSTODY_TRANSFERRED' && p.transition === 'CUSTODY_ACCEPTED'
      && p.custodian !== undefined && prev.custodian !== undefined && p.custodian === prev.custodian) {
      blockers.push('LEDGER_TRANSFER_TO_SAME_CUSTODIAN'); transitionsValid = false;
    }
  }

  // (12) Time must not run backwards along the sequence.
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1]!.occurredAt;
    const b = ordered[i]!.occurredAt;
    if (a === undefined || b === undefined) continue;
    if (b < a) { blockers.push('LEDGER_TIME_NOT_MONOTONIC'); break; }
  }

  // (13) The blank genesis -- EXACTLY the un-started state, and the only place a PENDING custodian or time is
  //      allowed. Any other event without a real custodian and time is an uncustodied claim.
  const blankGenesis = ordered.length === 1 && ordered[0]!.sequence === 0
    && ordered[0]!.transition === 'GENESIS' && ordered[0]!.custodianPending && ordered[0]!.occurredAtPending;
  if (!blankGenesis) {
    for (const p of ordered) {
      if (p.custodianPending || p.occurredAtPending) { blockers.push('LEDGER_EVENT_NOT_CUSTODIED'); break; }
    }
  }

  const events: CustodyEventState[] = ordered.map((p) => ({
    sequence: p.sequence ?? -1,
    transition: (p.transition ?? 'INVALID') as CustodyTransition | 'INVALID',
    digestRecomputed: p.statedDigest !== undefined && p.statedDigest === p.recomputedDigest,
    linkedToPrevious: p.linked,
    boundToOperation: p.bound,
    custodied: !p.custodianPending && !p.occurredAtPending && p.custodian !== undefined && p.occurredAt !== undefined,
  }));

  const uniqueBlockers = [...new Set(blockers)];
  const ledgerSound = uniqueBlockers.length === 0
    && eventsWellFormed && eventsRedactionSafe && chainLinked && transitionsValid && ordered.length > 0;

  // NOT_ELIGIBLE takes precedence over everything: an unverified source-record set cannot have custody.
  const overall: CustodyLedgerReport['overall'] =
    !verificationEligible ? 'NOT_ELIGIBLE'
      : !ledgerSound ? 'CUSTODY_LEDGER_INVALID'
        : blankGenesis ? 'CUSTODY_LEDGER_PENDING'
          : 'CUSTODY_LEDGER_INTACT';

  const intact = overall === 'CUSTODY_LEDGER_INTACT';
  const settled = intact || overall === 'CUSTODY_LEDGER_PENDING';
  const head = ordered.length > 0 ? ordered[ordered.length - 1]! : undefined;
  if (intact && head?.recomputedDigest !== undefined) boundDigests['head-event'] = head.recomputedDigest;

  const withoutDigest: Omit<CustodyLedgerReport, 'ledgerDigest'> = {
    report: 'phase-239-promotion-chain-custody-ledger',
    version: 1,
    redactionSafe: true,
    custodyHeldByThisTool: false,
    eventsCreatedByThisTool: false,
    selfAuthorized: false,
    overall,
    ledgerIntact: intact,
    verificationEligible,
    eventsWellFormed,
    eventsRedactionSafe,
    chainLinked,
    transitionsValid,
    eventCount: events.length,
    events,
    terminalTransition: settled && head?.transition !== undefined ? head.transition as CustodyTransition : 'NONE',
    headEventDigest: intact && head?.recomputedDigest !== undefined ? head.recomputedDigest : null,
    boundDigests,
    remainingHumanSteps: CUSTODY_LEDGER_REMAINING_HUMAN_STEPS,
    boundary: CUSTODY_LEDGER_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: CUSTODY_LEDGER_DISCLAIMERS,
  };
  return { ...withoutDigest, ledgerDigest: digest('phase-239-custody-ledger', JSON.stringify(withoutDigest)) };
}

// Emit the blank genesis a custodian completes to OPEN a ledger. Custodian and time are PENDING, so it claims
// nothing and validates as CUSTODY_LEDGER_PENDING. Its `eventDigest` is genuinely computed over that blank
// body, so the skeleton is self-consistent as supplied -- completing it CHANGES the body, and the custodian
// must therefore recompute `eventDigest` with `computeCustodyEventDigest` before appending anything to it.
// Returns null when the Phase 238 verification is not eligible (fail closed). It NEVER produces a custody claim.
export function buildCustodyLedgerGenesisSkeleton(verificationValue: unknown): CustodyEvent | null {
  const verification = validateVerificationReport(verificationValue, []);
  if (!verification.ok) return null;
  const body: Omit<CustodyEvent, 'eventDigest'> = {
    record: CUSTODY_EVENT_INPUT_ID,
    version: 1 as const,
    operation: OPERATION,
    sourceVerificationReport: VERIFICATION_REPORT_ID,
    verificationDigest: verification.verificationDigest!,
    approvalIdDigest: verification.operationDigests.approvalIdDigest!,
    itemDigest: verification.operationDigests.itemDigest!,
    sourceDigest: verification.operationDigests.sourceDigest!,
    destinationDigest: verification.operationDigests.destinationDigest!,
    planDigest: verification.operationDigests.planDigest!,
    sequence: 0,
    previousEventDigest: CUSTODY_GENESIS_SENTINEL,
    transition: 'GENESIS' as const,
    custodianDigest: PLACEHOLDER,
    occurredAtUtc: PLACEHOLDER,
  };
  return { ...body, eventDigest: computeCustodyEventDigest(body) };
}

interface ValidatedVerification {
  readonly ok: boolean;
  readonly verificationDigest: string | undefined;
  readonly operationDigests: Readonly<Record<string, string | undefined>>;
}

// The Phase 238 report must be genuine, VERIFIED, and sound on its OWN body -- not merely green in the
// headline. A self-digest is not a signature, so a forger reaches these checks with a cleanly recomputing
// report; they are the only thing standing between a fabricated verification and a custody ledger over it.
function validateVerificationReport(value: unknown, blockers: string[]): ValidatedVerification {
  const none: ValidatedVerification = { ok: false, verificationDigest: undefined, operationDigests: {} };
  if (value === undefined) { blockers.push('VERIFICATION_RECORD_MISSING'); return none; }
  const obj = asObject(value);
  if (obj.report !== VERIFICATION_REPORT_ID) { blockers.push('VERIFICATION_RECORD_INVALID'); return none; }

  const stated = asSha256(obj.verificationDigest);
  if (stated === undefined || verifySelfDigests([obj]).results[0]?.verified !== true) {
    blockers.push('VERIFICATION_RECORD_DIGEST_MISMATCH'); return none;
  }
  let ok = true;
  if (obj.overall !== VERIFIED) { blockers.push('VERIFICATION_RECORD_NOT_VERIFIED'); ok = false; }
  if (obj.recordedVerification !== 'VERIFIED') { blockers.push('VERIFICATION_RECORD_DECISION_NOT_VERIFIED'); ok = false; }
  if (obj.sourceRecordsVerified !== true) { blockers.push('VERIFICATION_RECORD_NOT_MARKED_VERIFIED'); ok = false; }
  if (obj.redactionSafe !== true) { blockers.push('VERIFICATION_RECORD_NOT_REDACTION_SAFE'); ok = false; }
  if (obj.commitmentEligible !== true) { blockers.push('VERIFICATION_RECORD_COMMITMENT_NOT_ELIGIBLE'); ok = false; }
  if (obj.manifestBoundToCommitment !== true) { blockers.push('VERIFICATION_RECORD_MANIFEST_NOT_BOUND'); ok = false; }
  if (obj.verificationWellFormed !== true) { blockers.push('VERIFICATION_RECORD_NOT_WELL_FORMED'); ok = false; }
  if (obj.verificationRedactionSafe !== true) { blockers.push('VERIFICATION_RECORD_INPUT_NOT_REDACTION_SAFE'); ok = false; }
  if (obj.verificationBound !== true) { blockers.push('VERIFICATION_RECORD_NOT_BOUND'); ok = false; }
  if (obj.verificationCoherent !== true) { blockers.push('VERIFICATION_RECORD_NOT_COHERENT'); ok = false; }
  if (obj.sourcesRedactionSafe !== true) { blockers.push('VERIFICATION_RECORD_SOURCES_NOT_REDACTION_SAFE'); ok = false; }
  if (obj.allContentDigestsMatched !== true) { blockers.push('VERIFICATION_RECORD_CONTENT_DIGESTS_NOT_MATCHED'); ok = false; }
  if (obj.allReportsRederived !== true) { blockers.push('VERIFICATION_RECORD_REPORTS_NOT_REDERIVED'); ok = false; }
  // The verification must itself still be a verification only -- it may never claim to have acted.
  if (obj.retrievedByThisTool !== false) { blockers.push('VERIFICATION_RECORD_RETRIEVED_CLAIMED'); ok = false; }
  if (obj.identityVerifiedByThisTool !== false) { blockers.push('VERIFICATION_RECORD_IDENTITY_VERIFIED_CLAIMED'); ok = false; }
  if (obj.selfAuthorized !== false) { blockers.push('VERIFICATION_RECORD_SELF_AUTHORIZED'); ok = false; }
  if (!Array.isArray(obj.blockers) || obj.blockers.length !== 0) { blockers.push('VERIFICATION_RECORD_BLOCKERS_PRESENT'); ok = false; }
  // A verification with outstanding findings is not a verified one, however green its headline.
  if (!Array.isArray(obj.mismatches) || obj.mismatches.length !== 0) { blockers.push('VERIFICATION_RECORD_MISMATCHES_PRESENT'); ok = false; }
  if (obj.sourceRecordCount !== 4) { blockers.push('VERIFICATION_RECORD_SOURCE_RECORD_COUNT_INVALID'); ok = false; }
  if (deepRawPath(obj)) { blockers.push('VERIFICATION_RECORD_RAW_PATH_PRESENT'); ok = false; }

  const bound = asObject(obj.boundDigests);
  const operationDigests: Record<string, string | undefined> = {};
  for (const f of OPERATION_DIGEST_FIELDS) {
    operationDigests[f] = asSha256(bound[f]);
    if (operationDigests[f] === undefined) { blockers.push('VERIFICATION_RECORD_OPERATION_DIGESTS_INCOMPLETE'); ok = false; }
  }

  return ok ? { ok: true, verificationDigest: stated, operationDigests } : none;
}

interface ParsedEvent {
  ok: boolean;
  sequence: number | undefined;
  transition: string | undefined;
  previousDigest: string | undefined;   // undefined for a genesis sentinel or a malformed value
  previousIsGenesis: boolean;           // the sentinel specifically, as opposed to a malformed value
  statedDigest: string | undefined;
  recomputedDigest: string | undefined;
  custodian: string | undefined;
  custodianPending: boolean;
  occurredAt: string | undefined;
  occurredAtPending: boolean;
  bound: boolean;
  linked: boolean | null;
  resealed: boolean;
}

// Strict per-event shape: one object, only allowlisted keys, fixed literals correct, closed enums, digests
// well-formed, and every chain binding equal to the eligible verification's.
function parseEvent(value: unknown, verification: ValidatedVerification, blockers: string[]): ParsedEvent {
  const p: ParsedEvent = {
    ok: false, sequence: undefined, transition: undefined, previousDigest: undefined, previousIsGenesis: false, statedDigest: undefined,
    recomputedDigest: undefined, custodian: undefined, custodianPending: false, occurredAt: undefined,
    occurredAtPending: false, bound: false, linked: null, resealed: false,
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) { blockers.push('EVENT_INVALID'); return p; }
  const obj = value as Record<string, unknown>;

  let ok = true;
  for (const k of Object.keys(obj)) {
    if (!EVENT_KEYS.includes(k)) { blockers.push('EVENT_UNKNOWN_FIELD'); ok = false; break; }
  }
  if (obj.record !== CUSTODY_EVENT_INPUT_ID) { blockers.push('EVENT_INVALID'); return p; }
  if (obj.version !== 1) { blockers.push('EVENT_VERSION_UNSUPPORTED'); ok = false; }
  if (obj.operation !== OPERATION) { blockers.push('EVENT_OPERATION_MISMATCH'); ok = false; }
  if (obj.sourceVerificationReport !== VERIFICATION_REPORT_ID) { blockers.push('EVENT_SOURCE_REPORT_MISMATCH'); ok = false; }

  if (typeof obj.sequence === 'number' && Number.isInteger(obj.sequence) && obj.sequence >= 0) p.sequence = obj.sequence;
  else { blockers.push('EVENT_SEQUENCE_INVALID'); ok = false; }

  if (typeof obj.transition === 'string' && TRANSITIONS.includes(obj.transition)) p.transition = obj.transition;
  else { blockers.push('EVENT_TRANSITION_INVALID'); ok = false; }

  // A genesis sentinel means "no predecessor"; anything else must be a well-formed digest.
  if (obj.previousEventDigest === CUSTODY_GENESIS_SENTINEL) { p.previousDigest = undefined; p.previousIsGenesis = true; }
  else if (asSha256(obj.previousEventDigest) !== undefined) p.previousDigest = obj.previousEventDigest as string;
  else { blockers.push('EVENT_PREVIOUS_DIGEST_INVALID'); ok = false; }

  p.statedDigest = asSha256(obj.eventDigest);
  if (p.statedDigest === undefined) { blockers.push('EVENT_DIGEST_INVALID'); ok = false; }
  else p.recomputedDigest = computeCustodyEventDigest(obj);

  if (obj.custodianDigest === PLACEHOLDER) p.custodianPending = true;
  else if (asSha256(obj.custodianDigest) !== undefined) p.custodian = obj.custodianDigest as string;
  else { blockers.push('EVENT_CUSTODIAN_DIGEST_INVALID'); ok = false; }

  if (obj.occurredAtUtc === PLACEHOLDER) p.occurredAtPending = true;
  else if (isExactUtcTimestamp(obj.occurredAtUtc)) p.occurredAt = obj.occurredAtUtc as string;
  else { blockers.push('EVENT_OCCURRED_AT_INVALID'); ok = false; }

  // Bindings: every event must name THIS verification and THIS one operation.
  let bound = true;
  if (verification.ok && obj.verificationDigest !== verification.verificationDigest) {
    blockers.push('EVENT_NOT_BOUND_TO_VERIFICATION'); bound = false; ok = false;
  }
  for (const f of OPERATION_DIGEST_FIELDS) {
    if (asSha256(obj[f]) === undefined) { blockers.push('EVENT_OPERATION_DIGEST_INVALID'); bound = false; ok = false; continue; }
    if (verification.ok && obj[f] !== verification.operationDigests[f]) {
      blockers.push(`EVENT_${screamingSnake(f)}_MISMATCH`); bound = false; ok = false;
    }
  }
  p.bound = bound;
  p.ok = ok;
  return p;
}

function screamingSnake(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function isLiveSurface(value: string): boolean {
  return /jellyfin|https?:\/\/|wss?:\/\/|x-emby|library\/refresh|\/mnt\//i.test(value);
}
function pathBearing(value: string): boolean {
  return /^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value);
}
// The STRICT predicate, for hand-written custody events: any string naming a live/network/media surface or a
// raw path fails closed. Traverses ITERATIVELY with a visited set, so it terminates on any input -- a
// pathologically deep or cyclic ledger can neither overflow the stack nor loop forever.
function deepLiveSurface(root: unknown): boolean {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') { if (value.length > 0 && (isLiveSurface(value) || pathBearing(value))) return true; continue; }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { for (const v of value) stack.push(v); continue; }
    for (const v of Object.values(value as Record<string, unknown>)) stack.push(v);
  }
  return false;
}
const RAW_PATH_MARKERS: readonly string[] = ['/mnt/', '\\mnt\\', '/media/Movies', 'user/media', 'catalog-authority-test-library'];
function hasRawPathMarker(value: string): boolean {
  return RAW_PATH_MARKERS.some((m) => value.includes(m));
}
// The MARKER scanner, for the supplied GENERATED report: a genuine phase report's own boundary prose names the
// live surfaces it avoids ("no live Jellyfin call"), so the strict predicate would reject every real one.
// Phase 236 set this precedent and Phases 237-238 follow it.
function deepRawPath(root: unknown): boolean {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') { if (hasRawPathMarker(value)) return true; continue; }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { for (const v of value) stack.push(v); continue; }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (hasRawPathMarker(k)) return true;
      stack.push(v);
    }
  }
  return false;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
