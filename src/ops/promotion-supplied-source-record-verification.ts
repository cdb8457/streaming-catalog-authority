import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
// Phase 237's own commitment-digest rule, imported rather than reimplemented: one rule, no second copy to
// drift from it.
import {
  computeSourceCommitmentDigest,
  type ProvenanceSourceRecordEntry,
} from './promotion-source-record-provenance.js';
// The phases' OWN validators, re-run for semantic re-derivation exactly as Phase 236 does.
import { buildExecutionAuthorizationRecord } from './promotion-execution-authorization-record.js';
import { buildPostRunObservationRecord } from './promotion-post-run-observation-record.js';
import { buildPostRunDispositionRecord } from './promotion-post-run-disposition-record.js';
import { buildOperationClosureRecord } from './promotion-operation-closure-record.js';

// Phase 238: local, non-live SUPPLIED-SOURCE-RECORD VERIFICATION, layered on the Phase 237 commitment.
//
// WHY IT EXISTS. Phase 237 records a human COMMITMENT to four content digests but never recomputes them
// against anything -- it is handed digests, not records, and says so. This phase is where the bytes are
// actually checked: given the four supplied human source records and the Phase 232-235 reports they produced,
// it canonically digests each record, compares it to the digest committed for that phase, and re-runs each
// phase's OWN validator to prove the report is the honest output of that record.
//
// WHAT THIS DOES AND DOES NOT PROVE. Verification proves ONLY that the supplied bytes match the committed
// digests and re-derive the reports. It does NOT establish authorship: nothing here is a signature. It does
// NOT establish that these records are the ones HISTORICALLY used at the time -- a party who controls both the
// records and the commitment can satisfy every check in this file by committing to the digests of whatever
// records they later intend to present. What it converts is narrower and worth stating exactly: the Phase 237
// commitment stops being an unverifiable claim and becomes one that is checkable against bytes. Nothing more.
//
// NOT_ELIGIBLE takes PRECEDENCE over everything: if the Phase 237 commitment is absent, not genuine, or
// anything other than a sound PROVENANCE_COMMITTED, there is nothing to verify against and no submission can
// override that. That is what locks the actual prepared P227-A chain, whose Phase 237 result is NOT_ELIGIBLE
// because its replay never closed.
//
// ELIGIBILITY IS CHECKED ON THE WHOLE BODY, NOT THE HEADLINE -- the standing rule in this stack since the
// Phase 234/235 hardening. A self-digest is not a signature, so a forged commitment can carry a green
// `overall` over a body that failed Phase 237's own checks and recompute cleanly.
//
// A MISMATCH IS A FINDING, NOT AN INPUT ERROR. This is a verification layer, so a content digest that does not
// match, a report that does not re-derive, or a report that is not the one committed are reported as
// `mismatches` -- they make SOURCE_RECORDS_VERIFIED impossible but do not by themselves make the submission
// INVALID, because the honest response to a failed verification is for a human to DECLINE it. Only a
// malformed, unbound or incoherent submission is INVALID -- as is a human affirming verification while
// mismatches stand.
//
// It retrieves nothing and verifies no identity: `retrievedByThisTool`, `identityVerifiedByThisTool` and
// `selfAuthorized` are the constants false. `verifiedByThisTool` is true because it genuinely does compute the
// comparison. It never runs the promotion launcher, reads or writes the real Movies library, contacts
// Jellyfin, or reads the secret approval file.
//
// The emitted report is redaction-safe: per-phase presence/match booleans, fixed value-free codes, closed enum
// states, counts and the already-public chain digests only -- never a supplied record, a content digest value,
// an identity, a timestamp, a raw path or a live identifier.

const COMMITMENT_REPORT_ID = 'phase-237-promotion-source-record-provenance-commitment';
const OPERATION = 'promote-observe-withdraw';
const COMMITTED = 'PROVENANCE_COMMITTED';

export const SUPPLIED_SOURCE_VERIFICATION_INPUT_ID = 'phase-238-promotion-supplied-source-record-verification-input';

export type VerificationFieldState = 'PENDING' | 'AFFIRMED' | 'REFUSED';
export type RecordedVerification = 'VERIFIED' | 'DECLINED' | 'PENDING';

const FIELD_STATES: readonly string[] = ['PENDING', 'AFFIRMED', 'REFUSED'];
const PLACEHOLDER = 'PENDING';

// `verificationAffirmed` carries the decision itself -- one source of truth, as in Phases 234-237.
const DECISION_FIELD = 'verificationAffirmed';
const AFFIRMATION_FIELDS: readonly string[] = ['sourceRecordsIndependentlyRetrieved', 'sourceRecordsByteCompared'];
const VERIFICATION_FIELDS: readonly string[] = [DECISION_FIELD, ...AFFIRMATION_FIELDS];

const VERIFICATION_KEYS: readonly string[] = [
  'record', 'version', 'operation', 'sourceCommitmentReport', 'provenanceDigest', 'sourceCommitmentDigest',
  'fields', 'verifierDigest', 'verifiedAtUtc',
];

// The four phases whose human source records are verified here. Phase 231 is excluded for the same reason
// Phase 237 excludes it: its input is the prepared evidence bundle, not a record a human wrote.
const VERIFIED_PHASES: readonly number[] = [232, 233, 234, 235];
// input key -> phase, for the supplied human source records.
const SOURCE_KEYS: Readonly<Record<number, string>> = {
  232: 'authorizationDecision', 233: 'observation', 234: 'disposition', 235: 'closure',
};
// input key + report id + self-digest field, for the supplied reports.
const REPORT_SPECS: Readonly<Record<number, { key: string; reportId: string; digestField: string }>> = {
  232: { key: 'authorization', reportId: 'phase-232-promotion-execution-authorization-record', digestField: 'recordDigest' },
  233: { key: 'observation', reportId: 'phase-233-promotion-post-run-observation-record', digestField: 'observationDigest' },
  234: { key: 'disposition', reportId: 'phase-234-promotion-post-run-disposition-record', digestField: 'dispositionDigest' },
  235: { key: 'closure', reportId: 'phase-235-promotion-operation-closure-record', digestField: 'closureDigest' },
};
const GATE_REPORT_ID = 'phase-231-promotion-execution-authorization';

export interface SuppliedReports {
  readonly gate?: unknown;
  readonly authorization?: unknown;
  readonly observation?: unknown;
  readonly disposition?: unknown;
  readonly closure?: unknown;
}

export interface SuppliedSources {
  readonly authorizationDecision?: unknown;
  readonly observation?: unknown;
  readonly disposition?: unknown;
  readonly closure?: unknown;
}

export interface SuppliedSourceVerificationInput {
  readonly commitment?: unknown;    // phase-237-promotion-source-record-provenance-commitment report
  readonly manifest?: unknown;      // the Phase 237 provenance manifest the commitment was made over
  readonly reports?: SuppliedReports;
  readonly sources?: SuppliedSources;
  readonly verification?: unknown;  // the separately supplied human verification decision record
}

// The record a human completes to record the verification. Digest-only: no path, no id, no identity.
export interface SuppliedSourceVerificationSkeleton {
  readonly record: typeof SUPPLIED_SOURCE_VERIFICATION_INPUT_ID;
  readonly version: 1;
  readonly operation: typeof OPERATION;
  readonly sourceCommitmentReport: typeof COMMITMENT_REPORT_ID;
  readonly provenanceDigest: string;
  readonly sourceCommitmentDigest: string;
  readonly fields: Readonly<Record<string, VerificationFieldState>>;
  readonly verifierDigest: string;
  readonly verifiedAtUtc: string;
}

export const SUPPLIED_SOURCE_VERIFICATION_REMAINING_HUMAN_STEPS: readonly string[] = [
  'Independent retrieval of the four source records from wherever they were retained; this validator retrieves nothing and is handed whatever it is given.',
  'Human judgement about whether the supplied records are the ones actually used at the time -- a question no digest can answer.',
  'Any identity verification of the verifier: this validator records a digest, never a person.',
  'Investigation and remediation of any reported mismatch, which this validator reports but never resolves.',
];

export const SUPPLIED_SOURCE_VERIFICATION_BOUNDARY =
  'No promotion launcher run, no withdrawal run, no remediation, no archival, no observed-state capture, no real Movies library read or write, no live Jellyfin call, no secret approval-file read, no record retrieval, no identity verification, and no self-authorization: this validator only digests supplied records and compares them to a Phase 237 commitment.';

export const SUPPLIED_SOURCE_VERIFICATION_DISCLAIMERS: readonly string[] = [
  'Verification proves ONLY that the supplied bytes match the committed digests and re-derive their reports. It is not a signature and establishes no authorship.',
  'It does NOT establish that these records are the ones historically used: a party controlling both the records and the commitment can satisfy every check here.',
  'What it converts is narrower -- the Phase 237 commitment stops being an unverifiable claim and becomes one checkable against bytes. Nothing more.',
  'A content mismatch is a FINDING, not an input error: the honest response to a failed verification is a human DECLINE, so mismatches never masquerade as a malformed submission.',
  'NOT_ELIGIBLE means there is no sound commitment to verify against -- it is not a defect in the supplied records, and no submission can override it.',
  'This validator retrieves no record and verifies no identity; it never runs the promotion launcher, reads or writes the real Movies library, contacts Jellyfin, or reads the secret approval file.',
];

export interface SuppliedSourceRecordState {
  readonly phase: number;
  readonly reportPresent: boolean;
  readonly reportVerified: boolean;
  readonly reportDigestCommitted: boolean;  // the supplied report IS the one this phase committed to
  readonly sourcePresent: boolean;
  readonly contentDigestMatched: boolean;   // canonical digest of the supplied record == committed digest
  readonly rederivedFromSource: boolean;    // the report is the honest output of its phase over that record
}

export interface SuppliedSourceVerificationReport {
  readonly report: 'phase-238-promotion-supplied-source-record-verification';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly verifiedByThisTool: true;
  readonly retrievedByThisTool: false;
  readonly identityVerifiedByThisTool: false;
  readonly selfAuthorized: false;
  readonly overall:
    | 'SOURCE_RECORDS_VERIFIED'
    | 'SOURCE_RECORDS_PENDING'
    | 'SOURCE_RECORDS_DECLINED'
    | 'SOURCE_RECORDS_INVALID'
    | 'NOT_ELIGIBLE';
  readonly recordedVerification: RecordedVerification | 'NONE';
  readonly sourceRecordsVerified: boolean;
  readonly commitmentEligible: boolean;
  readonly manifestBoundToCommitment: boolean;
  readonly verificationWellFormed: boolean;
  readonly verificationRedactionSafe: boolean;
  readonly verificationBound: boolean;
  readonly verificationCoherent: boolean;
  readonly sourcesRedactionSafe: boolean;
  readonly allContentDigestsMatched: boolean;
  readonly allReportsRederived: boolean;
  readonly sourceRecordCount: number;
  readonly sourceRecords: readonly SuppliedSourceRecordState[];
  // Verification FINDINGS -- a failed comparison, not a malformed submission. Separate from `blockers` on
  // purpose: these make VERIFIED impossible but leave DECLINE open.
  readonly mismatches: readonly string[];
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly fieldStates: Readonly<Record<string, VerificationFieldState>>;
  readonly remainingHumanSteps: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly verificationDigest: string;
}

// THE CANONICAL CONTENT DIGEST RULE, defined here and exported so a committer and a verifier compute the same
// value. Recursively key-SORTED JSON (arrays keep their order), digested under a fixed scope, so a record that
// is semantically identical but serialized with a different key order digests IDENTICALLY.
//
// A Phase 237 commitment MUST have used this rule. Phase 237 deliberately accepted whatever digest the human
// supplied -- it holds no records and cannot check -- so a commitment computed under any other convention will
// simply not match here, and that is reported as a mismatch rather than silently tolerated.
export function canonicalSourceRecordDigest(record: unknown): string {
  return digest('phase-238-source-record-content', JSON.stringify(canonicalize(record, new WeakSet())));
}

// Key-sorted deep copy. Cycle-safe: a revisited object becomes a fixed marker rather than recursing forever,
// so this terminates on any input and stays deterministic.
function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[cycle]';
    seen.add(value);
    return value.map((v) => canonicalize(v, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[cycle]';
    seen.add(value);
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(source).sort()) out[k] = canonicalize(source[k], seen);
    return out;
  }
  return value;
}

export function buildSuppliedSourceVerification(input: SuppliedSourceVerificationInput): SuppliedSourceVerificationReport {
  const blockers: string[] = [];
  const mismatches: string[] = [];
  const boundDigests: Record<string, string> = {};

  // (1) The Phase 237 commitment: genuine, PROVENANCE_COMMITTED, and sound on its whole body. Anything wrong
  //     here means there is nothing to verify against: NOT_ELIGIBLE, never INVALID.
  const commitment = validateCommitmentReport(input.commitment, blockers);
  const commitmentEligible = commitment.ok;
  if (commitmentEligible) {
    boundDigests['commitment-report'] = commitment.provenanceDigest!;
    boundDigests['source-commitment'] = commitment.sourceCommitmentDigest!;
  }

  // (2) The manifest the commitment was made over. The Phase 237 report never echoes a committed content
  //     digest -- it publishes only the digest OVER the ordered triples -- so the manifest must be supplied and
  //     must recompute, under Phase 237's own exported rule, to exactly that value. A substituted manifest
  //     cannot survive this.
  const entries = parseManifestEntries(input.manifest, blockers);
  let manifestBoundToCommitment = false;
  if (commitmentEligible && entries !== null) {
    manifestBoundToCommitment = computeSourceCommitmentDigest(entries) === commitment.sourceCommitmentDigest;
    if (!manifestBoundToCommitment) blockers.push('MANIFEST_NOT_BOUND_TO_COMMITMENT');
  }
  const committedByPhase = new Map<number, ProvenanceSourceRecordEntry>();
  for (const e of entries ?? []) committedByPhase.set(e.phase, e);

  // (3) The supplied Phase 231 gate. It is not itself committed to, but Phase 232's re-derivation consumes it.
  const reports = input.reports ?? {};
  const gate = validateSuppliedGate(reports.gate, blockers);

  // (4) Per phase, in ORDER: the supplied report is genuine and IS the one committed; the supplied source
  //     record canonically digests to exactly the committed content digest; and the report is the honest
  //     output of that phase's own validator over that record.
  const sourcesInput = input.sources ?? {};
  const sourceRecords: SuppliedSourceRecordState[] = [];
  const suppliedReportByPhase = new Map<number, Record<string, unknown>>();
  let sourceCount = 0;

  for (const phase of VERIFIED_PHASES) {
    const spec = REPORT_SPECS[phase]!;
    const reportValue = (reports as Record<string, unknown>)[spec.key];
    const sourceValue = (sourcesInput as Record<string, unknown>)[SOURCE_KEYS[phase]!];
    const committed = committedByPhase.get(phase);

    // The supplied report: present, right id, self-digest recomputes.
    let reportVerified = false;
    let ownDigest: string | undefined;
    if (reportValue === undefined) {
      blockers.push(`REPORT_PHASE_${phase}_MISSING`);
    } else {
      const obj = asObject(reportValue);
      if (obj.report !== spec.reportId) {
        blockers.push(`REPORT_PHASE_${phase}_INVALID`);
      } else {
        const stated = asSha256(obj[spec.digestField]);
        if (stated === undefined || verifySelfDigests([obj]).results[0]?.verified !== true) {
          blockers.push(`REPORT_PHASE_${phase}_DIGEST_MISMATCH`);
        } else {
          reportVerified = true;
          ownDigest = stated;
          suppliedReportByPhase.set(phase, obj);
        }
      }
    }

    // Is this the report that phase committed to? A finding, not a shape error.
    let reportDigestCommitted = false;
    if (reportVerified && committed !== undefined && commitmentEligible) {
      reportDigestCommitted = ownDigest === committed.reportDigest;
      if (!reportDigestCommitted) mismatches.push(`REPORT_PHASE_${phase}_NOT_COMMITTED`);
    }

    // The supplied source record and its canonical content digest.
    let contentDigestMatched = false;
    if (sourceValue === undefined) {
      blockers.push(`SOURCE_PHASE_${phase}_MISSING`);
    } else {
      sourceCount++;
      if (committed !== undefined && commitmentEligible) {
        contentDigestMatched = canonicalSourceRecordDigest(sourceValue) === committed.contentDigest;
        if (!contentDigestMatched) mismatches.push(`SOURCE_PHASE_${phase}_CONTENT_DIGEST_MISMATCH`);
      }
    }

    sourceRecords.push({
      phase,
      reportPresent: reportValue !== undefined,
      reportVerified,
      reportDigestCommitted,
      sourcePresent: sourceValue !== undefined,
      contentDigestMatched,
      rederivedFromSource: false, // filled below, once every parent is known
    });
    if (reportVerified && ownDigest !== undefined) boundDigests[`phase-${phase}`] = ownDigest;
  }

  // (5) Semantic re-derivation, each phase re-run against the SUPPLIED parent report. Feeding the supplied
  //     parent is what stops a doctored parent being laundered by a clean child: the doctored parent fails at
  //     its own level and cannot be rescued from below.
  const rederived = new Map<number, boolean>();
  for (const phase of VERIFIED_PHASES) {
    const state = sourceRecords.find((s) => s.phase === phase)!;
    const sourceValue = (sourcesInput as Record<string, unknown>)[SOURCE_KEYS[phase]!];
    const suppliedReport = suppliedReportByPhase.get(phase);
    const parent = phase === 232 ? gate.obj : suppliedReportByPhase.get(phase - 1);
    // A phase that CANNOT be re-derived -- because its record, its report or its parent is missing or itself
    // unusable -- reports the same finding as one that re-derives WRONG. `allReportsRederived` must never be
    // false with nothing in `mismatches` to explain it; the separate blocker says why.
    let ok = false;
    if (sourceValue !== undefined && suppliedReport !== undefined && parent !== undefined) {
      let produced: string | undefined;
      try { produced = rederiveReportDigest(phase, parent, sourceValue); } catch { produced = undefined; }
      const own = asSha256(suppliedReport[REPORT_SPECS[phase]!.digestField]);
      ok = produced !== undefined && own !== undefined && produced === own;
    }
    if (!ok) mismatches.push(`REPORT_PHASE_${phase}_NOT_REDERIVED_FROM_SOURCE`);
    rederived.set(phase, ok);
    (state as { rederivedFromSource: boolean }).rederivedFromSource = ok;
  }

  // (6) Redaction. The supplied SOURCE records are hand-written like the Phase 232-235 records, so they get the
  //     STRICT predicate. The supplied REPORTS are generated and their own boundary prose legitimately names
  //     the live surfaces they avoid, so they get raw-path markers only -- the two-scanner precedent set in
  //     Phase 236 and followed in Phase 237.
  const suppliedSourceValues = VERIFIED_PHASES
    .map((p) => (sourcesInput as Record<string, unknown>)[SOURCE_KEYS[p]!])
    .filter((v) => v !== undefined);
  const sourcesRedactionSafe = suppliedSourceValues.length === 0 ? false : !deepLiveSurface(suppliedSourceValues);
  if (suppliedSourceValues.length > 0 && !sourcesRedactionSafe) blockers.push('SOURCE_RECORDS_LIVE_SURFACE');
  const suppliedReportValues = Object.values(reports).filter((v) => v !== undefined);
  if (suppliedReportValues.length > 0 && deepRawPath(suppliedReportValues)) blockers.push('SUPPLIED_REPORT_RAW_PATH_PRESENT');

  // (7) The human verification record.
  const ver = validateVerificationShape(input.verification, blockers);
  const verificationWellFormed = ver.ok;
  const verificationRedactionSafe = input.verification === undefined ? false : !deepLiveSurface(input.verification);
  if (input.verification !== undefined && !verificationRedactionSafe) blockers.push('VERIFICATION_LIVE_SURFACE');

  let verificationBound = false;
  if (commitmentEligible && verificationWellFormed) {
    const bindsReport = ver.obj.provenanceDigest === commitment.provenanceDigest;
    if (!bindsReport) blockers.push('VERIFICATION_NOT_BOUND_TO_COMMITMENT');
    const bindsCommitment = ver.obj.sourceCommitmentDigest === commitment.sourceCommitmentDigest;
    if (!bindsCommitment) blockers.push('VERIFICATION_SOURCE_COMMITMENT_MISMATCH');
    verificationBound = bindsReport && bindsCommitment;
  }

  const allContentDigestsMatched = sourceRecords.every((s) => s.contentDigestMatched);
  const allReportsRederived = VERIFIED_PHASES.every((p) => rederived.get(p) === true);
  const allReportsCommitted = sourceRecords.every((s) => s.reportDigestCommitted);
  const comparisonClean = mismatches.length === 0
    && allContentDigestsMatched && allReportsRederived && allReportsCommitted;

  // (8) Coherence between the decision and the affirmations -- and, the point of this phase, between the
  //     decision and what the comparison actually found.
  let verificationCoherent = false;
  let decision: RecordedVerification | 'NONE' = 'NONE';
  const fieldStates: Record<string, VerificationFieldState> = {};
  if (verificationWellFormed) {
    const fields = asObject(ver.obj.fields);
    for (const f of VERIFICATION_FIELDS) fieldStates[f] = fields[f] as VerificationFieldState;

    const affirmed = fieldStates[DECISION_FIELD];
    decision = affirmed === 'AFFIRMED' ? 'VERIFIED' : affirmed === 'REFUSED' ? 'DECLINED' : 'PENDING';

    // Affirming verification means the human actually did the work. DECLINED stays ungated, as refusal is in
    // every phase of this stack.
    let decisionBacked = true;
    if (decision === 'VERIFIED' && !AFFIRMATION_FIELDS.every((f) => fieldStates[f] === 'AFFIRMED')) {
      blockers.push('VERIFICATION_AFFIRMED_WITHOUT_FULL_AFFIRMATION'); decisionBacked = false;
    }
    // A human may not affirm verification while the comparison says the records do not match. This is the one
    // place a mismatch becomes a hard error: not because the records are wrong, but because the CLAIM is.
    if (decision === 'VERIFIED' && !comparisonClean) {
      blockers.push('VERIFICATION_AFFIRMED_WITH_MISMATCHED_RECORDS'); decisionBacked = false;
    }

    const decided = decision !== 'PENDING';
    const verifierOk = decided ? asSha256(ver.obj.verifierDigest) !== undefined : ver.obj.verifierDigest === PLACEHOLDER;
    if (!verifierOk) blockers.push(decided ? 'VERIFICATION_VERIFIER_DIGEST_REQUIRED' : 'VERIFICATION_VERIFIER_DIGEST_NOT_PENDING');
    const verifiedAtOk = decided ? isUtcTimestamp(ver.obj.verifiedAtUtc) : ver.obj.verifiedAtUtc === PLACEHOLDER;
    if (!verifiedAtOk) blockers.push(decided ? 'VERIFICATION_VERIFIED_AT_REQUIRED' : 'VERIFICATION_VERIFIED_AT_NOT_PENDING');

    verificationCoherent = decisionBacked && verifierOk && verifiedAtOk;
  }

  const uniqueBlockers = [...new Set(blockers)];
  const uniqueMismatches = [...new Set(mismatches)];
  const submissionSound = uniqueBlockers.length === 0
    && manifestBoundToCommitment && verificationWellFormed && verificationRedactionSafe
    && verificationBound && verificationCoherent && sourcesRedactionSafe;

  // NOT_ELIGIBLE takes precedence over everything: nothing to verify against cannot be verified.
  const overall: SuppliedSourceVerificationReport['overall'] =
    !commitmentEligible ? 'NOT_ELIGIBLE'
      : !submissionSound ? 'SOURCE_RECORDS_INVALID'
        : decision === 'VERIFIED' ? 'SOURCE_RECORDS_VERIFIED'
          : decision === 'DECLINED' ? 'SOURCE_RECORDS_DECLINED'
            : 'SOURCE_RECORDS_PENDING';
  const settled = overall === 'SOURCE_RECORDS_VERIFIED' || overall === 'SOURCE_RECORDS_DECLINED'
    || overall === 'SOURCE_RECORDS_PENDING';

  const withoutDigest: Omit<SuppliedSourceVerificationReport, 'verificationDigest'> = {
    report: 'phase-238-promotion-supplied-source-record-verification',
    version: 1,
    redactionSafe: true,
    verifiedByThisTool: true,
    retrievedByThisTool: false,
    identityVerifiedByThisTool: false,
    selfAuthorized: false,
    overall,
    recordedVerification: settled ? decision : 'NONE',
    sourceRecordsVerified: overall === 'SOURCE_RECORDS_VERIFIED',
    commitmentEligible,
    manifestBoundToCommitment,
    verificationWellFormed,
    verificationRedactionSafe,
    verificationBound,
    verificationCoherent,
    sourcesRedactionSafe,
    allContentDigestsMatched,
    allReportsRederived,
    sourceRecordCount: sourceCount,
    sourceRecords,
    mismatches: uniqueMismatches,
    boundDigests,
    fieldStates,
    remainingHumanSteps: SUPPLIED_SOURCE_VERIFICATION_REMAINING_HUMAN_STEPS,
    boundary: SUPPLIED_SOURCE_VERIFICATION_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: SUPPLIED_SOURCE_VERIFICATION_DISCLAIMERS,
  };
  return { ...withoutDigest, verificationDigest: digest('phase-238-supplied-source-record-verification', JSON.stringify(withoutDigest)) };
}

// Emit the blank verification record a human completes. EVERY field is PENDING: this never creates or infers a
// VERIFIED record. Only derived bindings are pre-filled. Returns null when the commitment is not eligible.
export function buildSuppliedSourceVerificationSkeleton(commitmentValue: unknown): SuppliedSourceVerificationSkeleton | null {
  const commitment = validateCommitmentReport(commitmentValue, []);
  if (!commitment.ok) return null;
  const fields: Record<string, VerificationFieldState> = {};
  for (const f of VERIFICATION_FIELDS) fields[f] = 'PENDING';
  return {
    record: SUPPLIED_SOURCE_VERIFICATION_INPUT_ID,
    version: 1,
    operation: OPERATION,
    sourceCommitmentReport: COMMITMENT_REPORT_ID,
    provenanceDigest: commitment.provenanceDigest!,
    sourceCommitmentDigest: commitment.sourceCommitmentDigest!,
    fields,
    verifierDigest: PLACEHOLDER,
    verifiedAtUtc: PLACEHOLDER,
  };
}

function rederiveReportDigest(phase: number, parent: unknown, source: unknown): string | undefined {
  switch (phase) {
    case 232: return buildExecutionAuthorizationRecord({ gate: parent, record: source }).recordDigest;
    case 233: return buildPostRunObservationRecord({ authorizationRecord: parent, observation: source }).observationDigest;
    case 234: return buildPostRunDispositionRecord({ observationRecord: parent, disposition: source }).dispositionDigest;
    case 235: return buildOperationClosureRecord({ dispositionRecord: parent, closure: source }).closureDigest;
    default: return undefined;
  }
}

interface ValidatedCommitment {
  readonly ok: boolean;
  readonly provenanceDigest: string | undefined;
  readonly sourceCommitmentDigest: string | undefined;
}

// The commitment must be the genuine Phase 237 report AND sound on its whole body -- the standing rule since
// the Phase 234/235 hardening. Every failure here is an INELIGIBLE COMMITMENT, not an invalid submission.
function validateCommitmentReport(value: unknown, blockers: string[]): ValidatedCommitment {
  const none: ValidatedCommitment = { ok: false, provenanceDigest: undefined, sourceCommitmentDigest: undefined };
  if (value === undefined) { blockers.push('COMMITMENT_RECORD_MISSING'); return none; }
  const obj = asObject(value);
  if (obj.report !== COMMITMENT_REPORT_ID) { blockers.push('COMMITMENT_RECORD_INVALID'); return none; }

  const stated = asSha256(obj.provenanceDigest);
  if (stated === undefined || verifySelfDigests([obj]).results[0]?.verified !== true) {
    blockers.push('COMMITMENT_RECORD_DIGEST_MISMATCH'); return none;
  }
  let ok = true;
  if (obj.overall !== COMMITTED) { blockers.push('COMMITMENT_RECORD_NOT_COMMITTED'); ok = false; }
  if (obj.recordedCommitment !== 'COMMITTED') { blockers.push('COMMITMENT_RECORD_DECISION_NOT_COMMITTED'); ok = false; }
  if (obj.provenanceCommitted !== true) { blockers.push('COMMITMENT_RECORD_NOT_MARKED_COMMITTED'); ok = false; }
  if (obj.redactionSafe !== true) { blockers.push('COMMITMENT_RECORD_NOT_REDACTION_SAFE'); ok = false; }
  if (obj.replayEligible !== true) { blockers.push('COMMITMENT_RECORD_REPLAY_NOT_ELIGIBLE'); ok = false; }
  if (obj.manifestWellFormed !== true) { blockers.push('COMMITMENT_RECORD_MANIFEST_NOT_WELL_FORMED'); ok = false; }
  if (obj.manifestRedactionSafe !== true) { blockers.push('COMMITMENT_RECORD_MANIFEST_NOT_REDACTION_SAFE'); ok = false; }
  if (obj.manifestBound !== true) { blockers.push('COMMITMENT_RECORD_MANIFEST_NOT_BOUND'); ok = false; }
  if (obj.manifestCoherent !== true) { blockers.push('COMMITMENT_RECORD_MANIFEST_NOT_COHERENT'); ok = false; }
  // The commitment must itself still be a commitment only -- it may never claim to have acted.
  if (obj.committedByThisTool !== false) { blockers.push('COMMITMENT_RECORD_COMMITTED_CLAIMED'); ok = false; }
  if (obj.verifiedIdentityByThisTool !== false) { blockers.push('COMMITMENT_RECORD_IDENTITY_VERIFIED_CLAIMED'); ok = false; }
  if (obj.selfAuthorized !== false) { blockers.push('COMMITMENT_RECORD_SELF_AUTHORIZED'); ok = false; }
  if (!Array.isArray(obj.blockers) || obj.blockers.length !== 0) { blockers.push('COMMITMENT_RECORD_BLOCKERS_PRESENT'); ok = false; }
  if (obj.sourceRecordCount !== VERIFIED_PHASES.length) { blockers.push('COMMITMENT_RECORD_SOURCE_RECORD_COUNT_INVALID'); ok = false; }
  if (deepRawPath(obj)) { blockers.push('COMMITMENT_RECORD_RAW_PATH_PRESENT'); ok = false; }

  const commitmentDigest = asSha256(obj.sourceCommitmentDigest);
  if (commitmentDigest === undefined) { blockers.push('COMMITMENT_RECORD_COMMITMENT_DIGEST_MISSING'); ok = false; }

  return ok ? { ok: true, provenanceDigest: stated, sourceCommitmentDigest: commitmentDigest } : none;
}

// The manifest's source-record entries, parsed strictly: exactly four, ascending, no duplicates, exactly the
// four committed phases, every digest well-formed. Returns null when the list cannot be trusted at all.
function parseManifestEntries(value: unknown, blockers: string[]): ProvenanceSourceRecordEntry[] | null {
  if (value === undefined) { blockers.push('MANIFEST_MISSING'); return null; }
  const obj = asObject(value);
  const raw = obj.sourceRecords;
  if (!Array.isArray(raw)) { blockers.push('MANIFEST_ENTRIES_INVALID'); return null; }
  if (raw.length !== VERIFIED_PHASES.length) { blockers.push('MANIFEST_ENTRY_COUNT_INVALID'); return null; }

  const entries: ProvenanceSourceRecordEntry[] = [];
  for (const item of raw) {
    const e = asObject(item);
    const phase = typeof e.phase === 'number' && Number.isInteger(e.phase) ? e.phase : undefined;
    const reportDigest = asSha256(e.reportDigest);
    const contentDigest = asSha256(e.contentDigest);
    if (phase === undefined || reportDigest === undefined || contentDigest === undefined) {
      blockers.push('MANIFEST_ENTRIES_INVALID'); return null;
    }
    entries.push({ phase, reportDigest, contentDigest });
  }

  const seen = new Set<number>();
  let duplicated = false;
  for (const e of entries) { if (seen.has(e.phase)) duplicated = true; seen.add(e.phase); }
  if (duplicated) { blockers.push('MANIFEST_ENTRY_DUPLICATED'); return null; }
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.phase <= entries[i - 1]!.phase) { blockers.push('MANIFEST_ENTRY_OUT_OF_ORDER'); return null; }
  }
  if (!VERIFIED_PHASES.every((p) => seen.has(p))) { blockers.push('MANIFEST_ENTRY_PHASE_INVALID'); return null; }

  return entries;
}

interface ValidatedGate { readonly obj: Record<string, unknown> | undefined; }

function validateSuppliedGate(value: unknown, blockers: string[]): ValidatedGate {
  if (value === undefined) { blockers.push('GATE_REPORT_MISSING'); return { obj: undefined }; }
  const obj = asObject(value);
  if (obj.report !== GATE_REPORT_ID) { blockers.push('GATE_REPORT_INVALID'); return { obj: undefined }; }
  if (asSha256(obj.authorizationDigest) === undefined || verifySelfDigests([obj]).results[0]?.verified !== true) {
    blockers.push('GATE_REPORT_DIGEST_MISMATCH'); return { obj: undefined };
  }
  return { obj };
}

interface ValidatedVerification { readonly ok: boolean; readonly obj: Record<string, unknown>; }

function validateVerificationShape(value: unknown, blockers: string[]): ValidatedVerification {
  const none: ValidatedVerification = { ok: false, obj: {} };
  if (value === undefined) { blockers.push('VERIFICATION_MISSING'); return none; }
  if (Array.isArray(value)) { blockers.push('VERIFICATION_NOT_SINGLE'); return none; }
  if (!value || typeof value !== 'object') { blockers.push('VERIFICATION_INVALID'); return none; }
  const obj = value as Record<string, unknown>;

  let ok = true;
  for (const k of Object.keys(obj)) {
    if (!VERIFICATION_KEYS.includes(k)) { blockers.push('VERIFICATION_UNKNOWN_FIELD'); ok = false; break; }
  }
  if (obj.record !== SUPPLIED_SOURCE_VERIFICATION_INPUT_ID) { blockers.push('VERIFICATION_INVALID'); return none; }
  if (obj.version !== 1) { blockers.push('VERIFICATION_VERSION_UNSUPPORTED'); ok = false; }
  if (obj.operation !== OPERATION) { blockers.push('VERIFICATION_OPERATION_MISMATCH'); ok = false; }
  if (obj.sourceCommitmentReport !== COMMITMENT_REPORT_ID) { blockers.push('VERIFICATION_SOURCE_REPORT_MISMATCH'); ok = false; }
  if (asSha256(obj.provenanceDigest) === undefined) { blockers.push('VERIFICATION_PROVENANCE_DIGEST_INVALID'); ok = false; }
  if (asSha256(obj.sourceCommitmentDigest) === undefined) { blockers.push('VERIFICATION_COMMITMENT_DIGEST_INVALID'); ok = false; }
  if (typeof obj.verifierDigest !== 'string') { blockers.push('VERIFICATION_VERIFIER_DIGEST_INVALID'); ok = false; }
  if (typeof obj.verifiedAtUtc !== 'string') { blockers.push('VERIFICATION_VERIFIED_AT_INVALID'); ok = false; }

  const fields = asObject(obj.fields);
  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length !== VERIFICATION_FIELDS.length || !VERIFICATION_FIELDS.every((f) => fieldKeys.includes(f))) {
    blockers.push('VERIFICATION_FIELDS_INVALID'); return none;
  }
  for (const f of VERIFICATION_FIELDS) {
    if (typeof fields[f] === 'string' && FIELD_STATES.includes(fields[f] as string)) continue;
    blockers.push('VERIFICATION_FIELD_STATE_INVALID'); ok = false;
  }
  return ok ? { ok: true, obj } : none;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function isUtcTimestamp(value: unknown): boolean {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function isLiveSurface(value: string): boolean {
  return /jellyfin|https?:\/\/|wss?:\/\/|x-emby|library\/refresh|\/mnt\//i.test(value);
}
function pathBearing(value: string): boolean {
  return /^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value);
}
// Strict predicate, for HAND-WRITTEN records: the supplied source records and the verification record.
// Iterative with a visited set, so it terminates on any input and a live surface at any depth fails closed.
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
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isLiveSurface(k) || pathBearing(k)) return true;
      stack.push(v);
    }
  }
  return false;
}
// Raw-path markers only, for GENERATED reports whose own boundary prose names the surfaces they avoid.
const RAW_PATH_MARKERS: readonly string[] = ['/mnt/', '\\mnt\\', '/media/Movies', 'user/media', 'catalog-authority-test-library'];
function hasRawPathMarker(value: string): boolean {
  return RAW_PATH_MARKERS.some((m) => value.includes(m));
}
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
