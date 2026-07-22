import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSuppliedSourceVerification,
  buildSuppliedSourceVerificationSkeleton,
  canonicalSourceRecordDigest,
  SUPPLIED_SOURCE_VERIFICATION_INPUT_ID,
  SUPPLIED_SOURCE_VERIFICATION_DISCLAIMERS,
  SUPPLIED_SOURCE_VERIFICATION_REMAINING_HUMAN_STEPS,
} from '../src/ops/promotion-supplied-source-record-verification.js';
import {
  buildProvenanceCommitment,
  buildProvenanceCommitmentSkeleton,
} from '../src/ops/promotion-source-record-provenance.js';
import { verifyPromotionChainReplay } from '../src/ops/promotion-chain-replay.js';
import { buildOperationClosureRecord, buildOperationClosureSkeleton } from '../src/ops/promotion-operation-closure-record.js';
import { buildPostRunDispositionRecord, buildPostRunDispositionSkeleton } from '../src/ops/promotion-post-run-disposition-record.js';
import { buildPostRunObservationRecord, buildPostRunObservationSkeleton } from '../src/ops/promotion-post-run-observation-record.js';
import {
  buildExecutionAuthorizationRecord,
  buildExecutionAuthorizationRecordSkeleton,
} from '../src/ops/promotion-execution-authorization-record.js';
import { buildExecutionAuthorization } from '../src/ops/promotion-execution-authorization.js';
import { buildApprovalAttestation, validateApprovalAttestation } from '../src/ops/promotion-approval.js';
import { buildLivePreflightPlan } from '../src/ops/promotion-live-preflight-plan.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const APPROVED_ROOT = '/mnt/user/media/Movies';
const OPERATOR_DIGEST = createHash('sha256').update('phase-238-operator-under-test').digest('hex');
const OBSERVER_DIGEST = createHash('sha256').update('phase-238-observer-under-test').digest('hex');
const REVIEWER_DIGEST = createHash('sha256').update('phase-238-reviewer-under-test').digest('hex');
const CLOSER_DIGEST = createHash('sha256').update('phase-238-closer-under-test').digest('hex');
const COMMITTER_DIGEST = createHash('sha256').update('phase-238-committer-under-test').digest('hex');
const VERIFIER_DIGEST = createHash('sha256').update('phase-238-verifier-under-test').digest('hex');
const DECIDED_AT = '2026-07-21T00:00:00Z';
const OBSERVED_AT = '2026-07-21T01:00:00Z';
const REVIEWED_AT = '2026-07-21T02:00:00Z';
const CLOSED_AT = '2026-07-21T03:00:00Z';
const COMMITTED_AT = '2026-07-21T04:00:00Z';
const VERIFIED_AT = '2026-07-21T05:00:00Z';
const STATE_BEFORE = createHash('sha256').update('synthetic-observed-state-before').digest('hex');
const STATE_AFTER = createHash('sha256').update('synthetic-observed-state-after').digest('hex');

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-suppliedsource-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-suppliedsource-')); }

type Rec = Record<string, unknown>;
interface ChainOpts { itemId?: string; approvalId?: string; body?: Buffer }
interface Sources { gateEvidence: Rec; authorizationDecision: Rec; observation: Rec; disposition: Rec; closure: Rec }
interface Chain { reports: Rec; sources: Sources }

// A COMPLETE, genuine, five-phase SYNTHETIC chain plus the source records each phase consumed. Synthetic on
// purpose: no approved authorization, recorded observation, accepted disposition, closed closure or committed
// manifest exists for the real P227-A bundle, and this suite never constructs one.
function fullChain(root: string, o: ChainOpts = {}): Chain {
  const itemId = o.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = o.approvalId ?? 'phase-238-synthetic-test';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Supplied Source Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, o.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Supplied Source Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
  const built = buildApprovalAttestation(input);
  assert(built.ok, 'precondition: approval built');
  const approvalEvidence = built.evidence;
  const approvalValidation = validateApprovalAttestation(built.approval!, input).evidence;
  const plan = {
    noClobber: true, sameChecksum: true, observedStateRequired: true,
    rollback: { strategy: 'withdraw-run-created-materialization', preservePreexisting: true },
    withdrawal: { allowed: true, byRunId: true, refusePreexisting: true },
    items: [{ itemId, approvalId, approvalStatus: 'PENDING', sourceDigest: approvalEvidence.sourceRealPathDigest, destinationDigest: approvalEvidence.destinationPathDigest }],
  };
  const preflightReport = buildLivePreflightPlan({ plan });
  const gateEvidence = {
    approvalEvidence, approvalValidation, preflightPlan: plan, preflightReport,
    preflightSelfDigest: verifySelfDigests([preflightReport]),
  };
  const gate = buildExecutionAuthorization(gateEvidence);
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: gate ready (${gate.blockers.join(',')})`);

  const authorizationDecision: Rec = {
    ...JSON.parse(JSON.stringify(buildExecutionAuthorizationRecordSkeleton(gate)!)) as Rec,
    decision: 'APPROVED', operatorDigest: OPERATOR_DIGEST, decidedAtUtc: DECIDED_AT,
    observedStateBeforeDigest: STATE_BEFORE,
    fields: { operatorAuthorized: 'AFFIRMED', observedStateWitnessedBefore: 'AFFIRMED', withdrawalPathRehearsed: 'AFFIRMED', observedStateWitnessedAfter: 'PENDING', runExecutedByHuman: 'PENDING' },
  };
  const authorization = buildExecutionAuthorizationRecord({ gate, record: authorizationDecision });
  assertEq(authorization.overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', `precondition: approved (${authorization.blockers.join(',')})`);

  const observationRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildPostRunObservationSkeleton(authorization)!)) as Rec,
    observedRunOutcome: 'COMPLETED',
    observedStateBeforeDigest: STATE_BEFORE, observedStateAfterDigest: STATE_AFTER,
    preexistingPreserved: true, withdrewOnlyRunCreatedMaterialization: true,
    observerDigest: OBSERVER_DIGEST, observedAtUtc: OBSERVED_AT,
  };
  const observation = buildPostRunObservationRecord({ authorizationRecord: authorization, observation: observationRecord });
  assertEq(observation.overall, 'POST_RUN_OBSERVATION_RECORDED', `precondition: recorded (${observation.blockers.join(',')})`);

  const dispositionRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildPostRunDispositionSkeleton(observation)!)) as Rec,
    reviewerDigest: REVIEWER_DIGEST, reviewedAtUtc: REVIEWED_AT,
    fields: {
      outcomeAccepted: 'AFFIRMED', observedOutcomeReviewed: 'AFFIRMED',
      preexistingIntegrityConfirmed: 'AFFIRMED', evidenceRetainedOutOfBand: 'AFFIRMED', remediationPerformed: 'PENDING',
    },
  };
  const disposition = buildPostRunDispositionRecord({ observationRecord: observation, disposition: dispositionRecord });
  assertEq(disposition.overall, 'POST_RUN_DISPOSITION_ACCEPTED', `precondition: accepted (${disposition.blockers.join(',')})`);

  const closureRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildOperationClosureSkeleton(disposition)!)) as Rec,
    closerDigest: CLOSER_DIGEST, closedAtUtc: CLOSED_AT,
    fields: {
      closureAffirmed: 'AFFIRMED',
      evidenceArchivedOutOfBand: 'AFFIRMED', chainDigestsRecordedInArchive: 'AFFIRMED',
      noOutstandingRemediation: 'AFFIRMED', evidencePurged: 'PENDING',
    },
  };
  const closure = buildOperationClosureRecord({ dispositionRecord: disposition, closure: closureRecord });
  assertEq(closure.overall, 'OPERATION_CLOSURE_CLOSED', `precondition: closed (${closure.blockers.join(',')})`);

  return {
    reports: {
      gate: gate as unknown as Rec, authorization: authorization as unknown as Rec,
      observation: observation as unknown as Rec, disposition: disposition as unknown as Rec,
      closure: closure as unknown as Rec,
    },
    sources: {
      gateEvidence: gateEvidence as unknown as Rec, authorizationDecision,
      observation: observationRecord, disposition: dispositionRecord, closure: closureRecord,
    },
  };
}

interface Bundle { chain: Chain; replay: Rec; manifest: Rec; commitment: Rec }

// The four human source records, by the phase that consumed each.
function sourcesByPhase(chain: Chain): Record<number, unknown> {
  return { 232: chain.sources.authorizationDecision, 233: chain.sources.observation, 234: chain.sources.disposition, 235: chain.sources.closure };
}
function suppliedSources(chain: Chain): Rec {
  return {
    authorizationDecision: chain.sources.authorizationDecision, observation: chain.sources.observation,
    disposition: chain.sources.disposition, closure: chain.sources.closure,
  };
}

// A full synthetic bundle: verified-closed replay, a manifest committing the CANONICAL content digests, and a
// genuine PROVENANCE_COMMITTED Phase 237 report over it. `contentFor` lets a test commit to something else.
function committedBundle(root: string, o: ChainOpts & { contentFor?: (phase: number, record: unknown) => string } = {}): Bundle {
  const chain = fullChain(root, o);
  const replay = verifyPromotionChainReplay({ ...chain.reports, sources: chain.sources });
  assertEq(replay.overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', `precondition: replay verified closed (${replay.blockers.join(',')})`);
  const skeleton = JSON.parse(JSON.stringify(buildProvenanceCommitmentSkeleton(replay)!)) as Rec;
  const contents = sourcesByPhase(chain);
  const manifest: Rec = {
    ...skeleton,
    sourceRecords: (skeleton.sourceRecords as Rec[]).map((e) => ({
      ...e,
      contentDigest: (o.contentFor ?? ((_p, r) => canonicalSourceRecordDigest(r)))(e.phase as number, contents[e.phase as number]),
    })),
    committerDigest: COMMITTER_DIGEST,
    committedAtUtc: COMMITTED_AT,
    fields: {
      commitmentAffirmed: 'AFFIRMED', sourceRecordsRetainedIndependently: 'AFFIRMED',
      sourceRecordsContentDigested: 'AFFIRMED', sourceRecordsReviewed: 'AFFIRMED', sourceRecordsBoundToThisReplay: 'AFFIRMED',
    },
  };
  const commitment = buildProvenanceCommitment({ replay, manifest });
  assertEq(commitment.overall, 'PROVENANCE_COMMITTED', `precondition: committed (${commitment.blockers.join(',')})`);
  return { chain, replay: replay as unknown as Rec, manifest, commitment: commitment as unknown as Rec };
}

function skeletonOf(commitment: unknown): Rec {
  const s = buildSuppliedSourceVerificationSkeleton(commitment);
  assert(s !== null, 'precondition: skeleton emitted for a sound commitment');
  return JSON.parse(JSON.stringify(s)) as Rec;
}
// An AFFIRMED human verification record over a bundle.
function verifiedRecord(commitment: unknown, over: Rec = {}): Rec {
  const { fields: overFields, ...rest } = over;
  return {
    ...skeletonOf(commitment),
    verifierDigest: VERIFIER_DIGEST, verifiedAtUtc: VERIFIED_AT,
    ...rest,
    fields: {
      verificationAffirmed: 'AFFIRMED', sourceRecordsIndependentlyRetrieved: 'AFFIRMED', sourceRecordsByteCompared: 'AFFIRMED',
      ...((overFields as Rec) ?? {}),
    },
  };
}
// The full, honest submission for a bundle.
function submission(b: Bundle, over: Rec = {}): Rec {
  return {
    commitment: b.commitment, manifest: b.manifest, reports: b.chain.reports,
    sources: suppliedSources(b.chain), verification: verifiedRecord(b.commitment),
    ...over,
  };
}

// Re-seal a mutated report so it recomputes its own digest cleanly. A self-digest is not a signature.
function reseal(report: Rec, field: string, scope: string, mutate: (r: Rec) => void): Rec {
  const forged = JSON.parse(JSON.stringify(report)) as Rec;
  mutate(forged);
  delete forged[field];
  const body: Rec = {};
  for (const k of Object.keys(forged)) body[k] = forged[k];
  forged[field] = createHash('sha256').update(`${scope}:${JSON.stringify(body)}`).digest('hex');
  return forged;
}

console.log('Running Phase 238 supplied-source-record verification suite:\n');

await test('a genuine supplied source-record set verifies against the commitment -- and nothing was retrieved', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const v = buildSuppliedSourceVerification(submission(b) as never);
    assertEq(v.overall, 'SOURCE_RECORDS_VERIFIED', `verified (blockers: ${v.blockers.join(',')} mismatches: ${v.mismatches.join(',')})`);
    assertEq(v.recordedVerification, 'VERIFIED', 'decision echoed');
    assertEq(v.sourceRecordsVerified, true, 'the supplied records match the commitment');
    assertEq(v.blockers.length, 0, 'no blockers');
    assertEq(v.mismatches.length, 0, 'no mismatches');
    assert(v.commitmentEligible && v.manifestBoundToCommitment && v.allContentDigestsMatched && v.allReportsRederived, 'all computational checks green');
    assertEq(v.sourceRecordCount, 4, 'four source records supplied');
    // Verifying is not retrieving, and never an identity check.
    assertEq(v.verifiedByThisTool, true, 'this tool genuinely computed the comparison');
    assertEq(v.retrievedByThisTool, false, 'this tool retrieved nothing');
    assertEq(v.identityVerifiedByThisTool, false, 'this tool verified no identity');
    assertEq(v.selfAuthorized, false, 'never self-authorized');
    for (const s of v.sourceRecords) {
      assert(s.reportPresent && s.reportVerified && s.reportDigestCommitted, `phase ${s.phase} report is the committed one`);
      assert(s.sourcePresent && s.contentDigestMatched && s.rederivedFromSource, `phase ${s.phase} record matches and re-derives`);
    }
    assertEq(v.remainingHumanSteps.length, SUPPLIED_SOURCE_VERIFICATION_REMAINING_HUMAN_STEPS.length, 'remaining human steps stated');
    assertEq(v.disclaimers.length, SUPPLIED_SOURCE_VERIFICATION_DISCLAIMERS.length, 'disclaimers stated');
    assertEq(verifySelfDigests([v]).overall, 'ALL_VERIFIED', 'the report self-verifies');
    // Redaction: no supplied record, identity, timestamp, path or content digest is echoed.
    const json = JSON.stringify(v);
    assert(!json.includes('/mnt/') && !json.includes('catalog-authority-test-library'), 'no raw path in report');
    assert(!json.includes('phase-238-synthetic-test') && !json.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids in report');
    assert(![OPERATOR_DIGEST, OBSERVER_DIGEST, REVIEWER_DIGEST, CLOSER_DIGEST, COMMITTER_DIGEST, VERIFIER_DIGEST].some((d) => json.includes(d)), 'no participant identity in report');
    assert(!json.includes(VERIFIED_AT) && !json.includes(OBSERVED_AT), 'no timestamps in report');
    assert(!json.includes(canonicalSourceRecordDigest(b.chain.sources.observation)), 'no content digest value in report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The canonical rule must be genuinely canonical, or a committer and a verifier who serialize differently
// would disagree about identical records.
await test('the canonical content digest ignores key order but not content', () => {
  const record = { b: 1, a: { d: [3, 1, 2], c: 'x' }, e: [{ z: 1, y: 2 }] };
  const reordered = { a: { c: 'x', d: [3, 1, 2] }, e: [{ y: 2, z: 1 }], b: 1 };
  assertEq(canonicalSourceRecordDigest(record), canonicalSourceRecordDigest(reordered), 'key order does not change the digest');
  // Array ORDER is content, not formatting: it must change the digest.
  assert(canonicalSourceRecordDigest(record) !== canonicalSourceRecordDigest({ ...record, a: { c: 'x', d: [1, 2, 3] } }), 'array order changes the digest');
  assert(canonicalSourceRecordDigest(record) !== canonicalSourceRecordDigest({ ...record, b: 2 }), 'a changed value changes the digest');
  // Cycle-safe: a self-referential record terminates rather than overflowing.
  const cyclic: Rec = { a: 1 };
  cyclic.self = cyclic;
  assertEq(canonicalSourceRecordDigest(cyclic).length, 64, 'a cyclic record still digests');
});

test('BLOCKED by default: with nothing supplied the submission is NOT_ELIGIBLE', () => {
  const v = buildSuppliedSourceVerification({});
  assertEq(v.overall, 'NOT_ELIGIBLE', 'nothing to verify against');
  assertEq(v.recordedVerification, 'NONE', 'no decision');
  assertEq(v.sourceRecordsVerified, false, 'nothing verified');
  assert(v.blockers.includes('COMMITMENT_RECORD_MISSING'), 'COMMITMENT_RECORD_MISSING reported');
  assertEq(v.commitmentEligible, false, 'not eligible');
  assertEq(buildSuppliedSourceVerificationSkeleton(undefined), null, 'no skeleton without a commitment');
  assert(v.redactionSafe === true && !JSON.stringify(v).includes('/mnt/'), 'redaction-safe');
});

await test('the emitted skeleton pre-affirms nothing: it validates as PENDING and verifies nothing', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const skeleton = skeletonOf(b.commitment);
    assertEq(skeleton.record, SUPPLIED_SOURCE_VERIFICATION_INPUT_ID, 'skeleton is a verification input');
    assertEq(skeleton.verifierDigest, 'PENDING', 'skeleton names no verifier');
    assertEq(skeleton.verifiedAtUtc, 'PENDING', 'skeleton records no time');
    assert(Object.values(skeleton.fields as Rec).every((x) => x === 'PENDING'), 'every skeleton field PENDING');
    assert(Object.values(skeleton).every((x) => x !== true && x !== 'AFFIRMED'), 'the skeleton affirms nothing');
    const v = buildSuppliedSourceVerification(submission(b, { verification: skeleton }) as never);
    assertEq(v.overall, 'SOURCE_RECORDS_PENDING', `blank record is valid but undecided (${v.blockers.join(',')})`);
    assertEq(v.recordedVerification, 'PENDING', 'decision PENDING');
    assertEq(v.sourceRecordsVerified, false, 'a blank record verifies nothing');
    // The computation still ran and still agrees -- the human simply has not signed off.
    assert(v.allContentDigestsMatched && v.allReportsRederived, 'the comparison itself is clean');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a DECLINED verification is valid, records the refusal, and verifies nothing', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const declined = verifiedRecord(b.commitment, { fields: { verificationAffirmed: 'REFUSED' } });
    const v = buildSuppliedSourceVerification(submission(b, { verification: declined }) as never);
    assertEq(v.overall, 'SOURCE_RECORDS_DECLINED', `declined (${v.blockers.join(',')})`);
    assertEq(v.recordedVerification, 'DECLINED', 'refusal recorded');
    assertEq(v.sourceRecordsVerified, false, 'a refusal verifies nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE POINT OF THE PHASE. A substituted record no longer digests to what was committed.
await test('THE substitution case: a swapped source record fails the committed content digest', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const other = committedBundle(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-238-other', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    const swapped = { ...suppliedSources(b.chain), observation: other.chain.sources.observation };
    const v = buildSuppliedSourceVerification(submission(b, { sources: swapped }) as never);
    assertEq(v.overall, 'SOURCE_RECORDS_INVALID', 'a substituted record cannot be affirmed as verified');
    assert(v.mismatches.includes('SOURCE_PHASE_233_CONTENT_DIGEST_MISMATCH'), 'the substituted record is reported');
    assert(v.blockers.includes('VERIFICATION_AFFIRMED_WITH_MISMATCHED_RECORDS'), 'affirming verification over a mismatch is the error');
    assertEq(v.allContentDigestsMatched, false, 'not all content digests matched');
    assertEq(v.sourceRecordsVerified, false, 'nothing verified');
    // A mismatch is a FINDING: the honest response is to DECLINE, and that stays available.
    const declined = buildSuppliedSourceVerification(submission(b, {
      sources: swapped, verification: verifiedRecord(b.commitment, { fields: { verificationAffirmed: 'REFUSED' } }),
    }) as never);
    assertEq(declined.overall, 'SOURCE_RECORDS_DECLINED', 'a human may decline a failed verification');
    assert(declined.mismatches.includes('SOURCE_PHASE_233_CONTENT_DIGEST_MISMATCH'), 'the finding is still reported');
    assertEq(declined.blockers.length, 0, 'a declined mismatch is not a malformed submission');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Matching the committed digest is NOT enough: the record must also be the one that produced the report.
await test('a record that matches its committed digest but does not re-derive its report fails closed', () => {
  const root = workspace();
  try {
    const chain = fullChain(root);
    const other = fullChain(root, { itemId: '88888888888888888888888888888888', approvalId: 'phase-238-nonderiving', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-nonderiving')]) });
    // Commit to the digest of ANOTHER chain's disposition record, then supply exactly that record. The content
    // digest therefore matches by construction -- only re-derivation can see the problem.
    const replay = verifyPromotionChainReplay({ ...chain.reports, sources: chain.sources });
    const skeleton = JSON.parse(JSON.stringify(buildProvenanceCommitmentSkeleton(replay)!)) as Rec;
    const contents: Record<number, unknown> = { ...sourcesByPhase(chain), 234: other.sources.disposition };
    const manifest: Rec = {
      ...skeleton,
      sourceRecords: (skeleton.sourceRecords as Rec[]).map((e) => ({ ...e, contentDigest: canonicalSourceRecordDigest(contents[e.phase as number]) })),
      committerDigest: COMMITTER_DIGEST, committedAtUtc: COMMITTED_AT,
      fields: {
        commitmentAffirmed: 'AFFIRMED', sourceRecordsRetainedIndependently: 'AFFIRMED',
        sourceRecordsContentDigested: 'AFFIRMED', sourceRecordsReviewed: 'AFFIRMED', sourceRecordsBoundToThisReplay: 'AFFIRMED',
      },
    };
    const commitment = buildProvenanceCommitment({ replay, manifest });
    assertEq(commitment.overall, 'PROVENANCE_COMMITTED', 'precondition: the commitment itself is valid');
    const v = buildSuppliedSourceVerification({
      commitment, manifest, reports: chain.reports,
      sources: { ...suppliedSources(chain), disposition: other.sources.disposition },
      verification: verifiedRecord(commitment as unknown as Rec),
    } as never);
    const state = v.sourceRecords.find((s) => s.phase === 234)!;
    assertEq(state.contentDigestMatched, true, 'the content digest genuinely matches what was committed');
    assertEq(state.rederivedFromSource, false, 'but the record does not produce the report');
    assert(v.mismatches.includes('REPORT_PHASE_234_NOT_REDERIVED_FROM_SOURCE'), 'REPORT_PHASE_234_NOT_REDERIVED_FROM_SOURCE reported');
    assertEq(v.overall, 'SOURCE_RECORDS_INVALID', 'cannot be affirmed as verified');
    assertEq(v.allReportsRederived, false, 'not all reports re-derived');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Feeding each phase the SUPPLIED parent is what stops laundering.
await test('a doctored parent report cannot be laundered by a clean child', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const doctored = reseal(b.chain.reports.authorization as Rec, 'recordDigest', 'phase-232-execution-authorization-record', (r) => { r.injectedClaim = 'smuggled'; });
    assertEq(verifySelfDigests([doctored]).overall, 'ALL_VERIFIED', 'precondition: the doctored parent recomputes cleanly');
    const v = buildSuppliedSourceVerification(submission(b, { reports: { ...b.chain.reports, authorization: doctored } }) as never);
    assertEq(v.overall, 'SOURCE_RECORDS_INVALID', 'a doctored parent is caught');
    // It fails at its OWN level: its source no longer produces it, and it is not the committed report.
    assert(v.mismatches.includes('REPORT_PHASE_232_NOT_REDERIVED_FROM_SOURCE'), 'the doctored parent does not re-derive');
    assert(v.mismatches.includes('REPORT_PHASE_232_NOT_COMMITTED'), 'and it is not the report that was committed');
    // ...and the clean child cannot rescue it: Phase 233 re-derives against the SUPPLIED parent.
    assert(v.mismatches.includes('REPORT_PHASE_233_NOT_REDERIVED_FROM_SOURCE'), 'the child re-derived against the doctored parent also fails');
    assert(!v.blockers.includes('REPORT_PHASE_232_DIGEST_MISMATCH'), 'the digest check does NOT catch the reseal');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a substituted manifest does not recompute the committed digest', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const other = committedBundle(root, { itemId: '77777777777777777777777777777777', approvalId: 'phase-238-manifest', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-manifest')]) });
    const v = buildSuppliedSourceVerification(submission(b, { manifest: other.manifest }) as never);
    assertEq(v.overall, 'SOURCE_RECORDS_INVALID', 'a foreign manifest is rejected');
    assert(v.blockers.includes('MANIFEST_NOT_BOUND_TO_COMMITMENT'), 'MANIFEST_NOT_BOUND_TO_COMMITMENT reported');
    assertEq(v.manifestBoundToCommitment, false, 'not bound');
    // Editing a single committed content digest breaks the recomputation too.
    const edited = JSON.parse(JSON.stringify(b.manifest)) as Rec;
    (edited.sourceRecords as Rec[])[1]!.contentDigest = 'a'.repeat(64);
    const e = buildSuppliedSourceVerification(submission(b, { manifest: edited }) as never);
    assert(e.blockers.includes('MANIFEST_NOT_BOUND_TO_COMMITMENT'), 'an edited manifest entry is caught');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: manifest omission, duplication and reordering each fail closed distinctly', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const entries = b.manifest.sourceRecords as Rec[];
    const cases: Array<[string, unknown[], string]> = [
      ['omission', entries.slice(0, 3), 'MANIFEST_ENTRY_COUNT_INVALID'],
      ['duplication', [entries[0], entries[0], entries[2], entries[3]], 'MANIFEST_ENTRY_DUPLICATED'],
      ['reordering', [entries[1], entries[0], entries[2], entries[3]], 'MANIFEST_ENTRY_OUT_OF_ORDER'],
    ];
    for (const [what, records, code] of cases) {
      const v = buildSuppliedSourceVerification(submission(b, { manifest: { ...b.manifest, sourceRecords: records } }) as never);
      assertEq(v.overall, 'SOURCE_RECORDS_INVALID', `${what} rejected`);
      assert(v.blockers.includes(code), `${what} -> ${code}`);
      assertEq(v.sourceRecordsVerified, false, `nothing verified: ${what}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a supplied report that is not the committed one, and a tampered one, both fail closed', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const other = committedBundle(root, { itemId: '66666666666666666666666666666666', approvalId: 'phase-238-report', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-report')]) });
    // A genuine report from another chain: verifies on its own, but is not the committed one.
    const foreign = buildSuppliedSourceVerification(submission(b, { reports: { ...b.chain.reports, closure: other.chain.reports.closure } }) as never);
    assert(foreign.mismatches.includes('REPORT_PHASE_235_NOT_COMMITTED'), 'a foreign report is not the committed one');
    assertEq(foreign.overall, 'SOURCE_RECORDS_INVALID', 'cannot be affirmed as verified');
    // A tampered report fails on its own digest first.
    const tampered = JSON.parse(JSON.stringify(b.chain.reports.disposition)) as Rec;
    tampered.injectedClaim = 'smuggled-through-a-green-report';
    const t = buildSuppliedSourceVerification(submission(b, { reports: { ...b.chain.reports, disposition: tampered } }) as never);
    assert(t.blockers.includes('REPORT_PHASE_234_DIGEST_MISMATCH'), 'a tampered report -> REPORT_PHASE_234_DIGEST_MISMATCH');
    assertEq(t.overall, 'SOURCE_RECORDS_INVALID', 'tampered report rejected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a commitment that is not PROVENANCE_COMMITTED is NOT_ELIGIBLE, whatever the submission says', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    // A genuine but UNDECIDED Phase 237 commitment: valid, just never committed.
    const blank = JSON.parse(JSON.stringify(buildProvenanceCommitmentSkeleton(b.replay)!)) as Rec;
    const pending = buildProvenanceCommitment({ replay: b.replay, manifest: blank });
    assertEq(pending.overall, 'PROVENANCE_PENDING', 'precondition: a genuine but undecided commitment');
    assertEq(verifySelfDigests([pending]).overall, 'ALL_VERIFIED', 'precondition: it is genuine');
    assertEq(buildSuppliedSourceVerificationSkeleton(pending), null, 'no skeleton for an uncommitted provenance');
    const v = buildSuppliedSourceVerification(submission(b, { commitment: pending }) as never);
    assertEq(v.overall, 'NOT_ELIGIBLE', 'nothing to verify against');
    assert(v.blockers.includes('COMMITMENT_RECORD_NOT_COMMITTED'), 'COMMITMENT_RECORD_NOT_COMMITTED reported');
    assertEq(v.sourceRecordsVerified, false, 'nothing verified');
    assertEq(v.recordedVerification, 'NONE', 'no decision recorded');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_ELIGIBLE takes precedence over a broken submission', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const blank = JSON.parse(JSON.stringify(buildProvenanceCommitmentSkeleton(b.replay)!)) as Rec;
    const pending = buildProvenanceCommitment({ replay: b.replay, manifest: blank });
    for (const broken of [undefined, 'not-an-object', { record: 'wrong' }, [] as unknown]) {
      const v = buildSuppliedSourceVerification({ commitment: pending, verification: broken } as never);
      assertEq(v.overall, 'NOT_ELIGIBLE', 'an ineligible commitment wins over a broken submission');
      assertEq(v.sourceRecordsVerified, false, 'nothing verified');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A self-digest is not a signature: the eligibility checks must stand on their own.
await test('adversarial: a FORGED Phase 237 commitment that recomputes its own digest is caught by the eligibility checks', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const cases: Array<[string, (r: Rec) => void, string]> = [
      ['the report is not redaction-safe', (r) => { r.redactionSafe = false; }, 'COMMITMENT_RECORD_NOT_REDACTION_SAFE'],
      ['the recorded decision is not COMMITTED', (r) => { r.recordedCommitment = 'PENDING'; }, 'COMMITMENT_RECORD_DECISION_NOT_COMMITTED'],
      ['the committed flag is quietly false', (r) => { r.provenanceCommitted = false; }, 'COMMITMENT_RECORD_NOT_MARKED_COMMITTED'],
      ['the replay was never eligible', (r) => { r.replayEligible = false; }, 'COMMITMENT_RECORD_REPLAY_NOT_ELIGIBLE'],
      ['the manifest was not well-formed', (r) => { r.manifestWellFormed = false; }, 'COMMITMENT_RECORD_MANIFEST_NOT_WELL_FORMED'],
      ['the manifest was not bound', (r) => { r.manifestBound = false; }, 'COMMITMENT_RECORD_MANIFEST_NOT_BOUND'],
      ['the manifest was not coherent', (r) => { r.manifestCoherent = false; }, 'COMMITMENT_RECORD_MANIFEST_NOT_COHERENT'],
      ['the commitment claims it committed', (r) => { r.committedByThisTool = true; }, 'COMMITMENT_RECORD_COMMITTED_CLAIMED'],
      ['the commitment claims it verified an identity', (r) => { r.verifiedIdentityByThisTool = true; }, 'COMMITMENT_RECORD_IDENTITY_VERIFIED_CLAIMED'],
      ['blockers under a green headline', (r) => { r.blockers = ['SOMETHING_FAILED']; }, 'COMMITMENT_RECORD_BLOCKERS_PRESENT'],
      ['the wrong number of source records', (r) => { r.sourceRecordCount = 3; }, 'COMMITMENT_RECORD_SOURCE_RECORD_COUNT_INVALID'],
    ];
    for (const [what, mutate, code] of cases) {
      const forged = reseal(b.commitment, 'provenanceDigest', 'phase-237-source-record-provenance', mutate);
      assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `precondition: ${what} recomputes cleanly`);
      assertEq((forged as Rec).overall, 'PROVENANCE_COMMITTED', `precondition: ${what} keeps a green headline`);
      const v = buildSuppliedSourceVerification(submission(b, { commitment: forged }) as never);
      assertEq(v.overall, 'NOT_ELIGIBLE', `forged commitment rejected: ${what}`);
      assert(!v.blockers.includes('COMMITMENT_RECORD_DIGEST_MISMATCH'), `${what}: the digest check does NOT catch this`);
      assert(v.blockers.includes(code), `${what} -> ${code}`);
      assertEq(v.sourceRecordsVerified, false, `nothing verified: ${what}`);
      assertEq(buildSuppliedSourceVerificationSkeleton(forged), null, `no skeleton: ${what}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a missing source record or report fails closed', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const noSource = buildSuppliedSourceVerification(submission(b, { sources: { ...suppliedSources(b.chain), closure: undefined } }) as never);
    assert(noSource.blockers.includes('SOURCE_PHASE_235_MISSING'), 'a missing source record is reported');
    assertEq(noSource.overall, 'SOURCE_RECORDS_INVALID', 'missing source rejected');
    assertEq(noSource.sourceRecordCount, 3, 'only three records supplied');
    const noReport = buildSuppliedSourceVerification(submission(b, { reports: { ...b.chain.reports, observation: undefined } }) as never);
    assert(noReport.blockers.includes('REPORT_PHASE_233_MISSING'), 'a missing report is reported');
    const noGate = buildSuppliedSourceVerification(submission(b, { reports: { ...b.chain.reports, gate: undefined } }) as never);
    assert(noGate.blockers.includes('GATE_REPORT_MISSING'), 'a missing gate is reported');
    assert(noGate.mismatches.includes('REPORT_PHASE_232_NOT_REDERIVED_FROM_SOURCE'), 'without the gate, Phase 232 cannot re-derive');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// REGRESSION, shared across the chain. The old timestamp check was
// `shape-regex && Number.isFinite(Date.parse(v))`, and for an ISO-SHAPED string V8 NORMALISES out-of-range
// components rather than rejecting them -- so a record could pin a moment that never existed and silently mean
// a different one. A record that says WHEN a human acted must refuse an impossible moment, not relocate it.
await test('REGRESSION: an impossible calendar verification time is rejected, never silently normalised', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const IMPOSSIBLE_MOMENTS: readonly string[] = [
      '2026-02-30T12:00:00Z',  // meant 2026-03-02 under the old check
      '2026-02-29T12:00:00Z',  // 2026 is not a leap year; meant 2026-03-01
      '2026-04-31T12:00:00Z',  // meant 2026-05-01
      '2026-06-31T12:00:00Z',
      '2026-09-31T12:00:00Z',
      '2026-11-31T12:00:00Z',
      '2026-01-01T24:00:00Z',  // hour 24; meant the NEXT DAY at 00:00:00
      '2026-01-00T12:00:00Z',
      '2026-00-10T12:00:00Z',
      '2026-13-01T12:00:00Z',
      '2026-01-01T12:60:00Z',
      '2026-01-01T12:00:60Z',
    ];
    const REAL_MOMENTS: readonly string[] = ['2024-02-29T12:00:00Z', '2026-12-31T23:59:59Z', '2026-07-21T00:00:00Z'];
    for (const stamp of IMPOSSIBLE_MOMENTS) {
      const v = buildSuppliedSourceVerification(submission(b, { verification: verifiedRecord(b.commitment, { verifiedAtUtc: stamp }) }) as never);
      assertEq(v.overall, 'SOURCE_RECORDS_INVALID', `rejected: ${stamp}`);
      assert(v.blockers.includes('VERIFICATION_VERIFIED_AT_REQUIRED'), `${stamp} -> VERIFICATION_VERIFIED_AT_REQUIRED`);
    }
    for (const stamp of REAL_MOMENTS) {
      const v = buildSuppliedSourceVerification(submission(b, { verification: verifiedRecord(b.commitment, { verifiedAtUtc: stamp }) }) as never);
      assert(!v.blockers.includes('VERIFICATION_VERIFIED_AT_REQUIRED'), `a real moment must still be accepted: ${stamp}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: malformed enums, digests and timestamps in the verification record fail closed', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const cases: Array<[string, Rec, string]> = [
      ['a bad decision state', { fields: { verificationAffirmed: 'PROBABLY' } }, 'VERIFICATION_FIELD_STATE_INVALID'],
      ['a non-digest verifier', { verifierDigest: 'me' }, 'VERIFICATION_VERIFIER_DIGEST_REQUIRED'],
      ['a loose timestamp', { verifiedAtUtc: '21 July 2026' }, 'VERIFICATION_VERIFIED_AT_REQUIRED'],
      ['a wrong version', { version: 2 }, 'VERIFICATION_VERSION_UNSUPPORTED'],
      ['a wrong operation', { operation: 'something-else' }, 'VERIFICATION_OPERATION_MISMATCH'],
      ['an unbound commitment digest', { sourceCommitmentDigest: 'b'.repeat(64) }, 'VERIFICATION_SOURCE_COMMITMENT_MISMATCH'],
    ];
    for (const [what, over, code] of cases) {
      const v = buildSuppliedSourceVerification(submission(b, { verification: verifiedRecord(b.commitment, over) }) as never);
      assertEq(v.overall, 'SOURCE_RECORDS_INVALID', `${what} rejected`);
      assert(v.blockers.includes(code), `${what} -> ${code}`);
    }
    // An undecided record may not name a verifier or a time.
    const named = buildSuppliedSourceVerification(submission(b, {
      verification: verifiedRecord(b.commitment, { fields: { verificationAffirmed: 'PENDING' } }),
    }) as never);
    assert(named.blockers.includes('VERIFICATION_VERIFIER_DIGEST_NOT_PENDING'), 'an undecided record may not name a verifier');
    // Affirming without doing the work fails closed.
    const unbacked = buildSuppliedSourceVerification(submission(b, {
      verification: verifiedRecord(b.commitment, { fields: { sourceRecordsByteCompared: 'PENDING' } }),
    }) as never);
    assert(unbacked.blockers.includes('VERIFICATION_AFFIRMED_WITHOUT_FULL_AFFIRMATION'), 'affirming without the work is rejected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: an unknown field and a smuggled raw path fail closed and are never echoed', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const unknown = buildSuppliedSourceVerification(submission(b, {
      verification: { ...verifiedRecord(b.commitment), notes: 'looked fine' },
    }) as never);
    assert(unknown.blockers.includes('VERIFICATION_UNKNOWN_FIELD'), 'an off-allowlist field is rejected');
    assertEq(unknown.overall, 'SOURCE_RECORDS_INVALID', 'unknown field rejected');

    const leakyVerification = buildSuppliedSourceVerification(submission(b, {
      verification: { ...verifiedRecord(b.commitment), verifierDigest: '/mnt/user/media/Movies/Supplied Source Proof (2026)/source.mp4' },
    }) as never);
    assert(leakyVerification.blockers.includes('VERIFICATION_LIVE_SURFACE'), 'a raw path in the verification record is caught');
    assert(!JSON.stringify(leakyVerification).includes('/mnt/'), 'the smuggled path is never echoed');

    // A raw path smuggled into a supplied SOURCE record is caught by the strict predicate.
    const leakySource = buildSuppliedSourceVerification(submission(b, {
      sources: { ...suppliedSources(b.chain), disposition: { ...(b.chain.sources.disposition), note: '/mnt/user/media/Movies/leak.mkv' } },
    }) as never);
    assert(leakySource.blockers.includes('SOURCE_RECORDS_LIVE_SURFACE'), 'a raw path in a source record is caught');
    assertEq(leakySource.sourcesRedactionSafe, false, 'sources not redaction-safe');
    const json = JSON.stringify(leakySource);
    assert(!json.includes('/mnt/') && !json.includes('leak.mkv'), 'the smuggled path is never echoed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI verifies a supplied set, writes a blank skeleton, and never echoes raw paths or ids', () => {
  const root = workspace();
  try {
    const b = committedBundle(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const paths = {
      commitment: w('commitment.json', b.commitment), manifest: w('manifest.json', b.manifest),
      gate: w('gate.json', b.chain.reports.gate), authorization: w('auth.json', b.chain.reports.authorization),
      observation: w('obs.json', b.chain.reports.observation), disposition: w('disp.json', b.chain.reports.disposition),
      closure: w('closure.json', b.chain.reports.closure),
      srcAuth: w('src-auth.json', b.chain.sources.authorizationDecision), srcObs: w('src-obs.json', b.chain.sources.observation),
      srcDisp: w('src-disp.json', b.chain.sources.disposition), srcClosure: w('src-closure.json', b.chain.sources.closure),
      verification: w('verification.json', verifiedRecord(b.commitment)),
      declined: w('declined.json', verifiedRecord(b.commitment, { fields: { verificationAffirmed: 'REFUSED' } })),
    };
    const outPath = join(root, 'SUPPLIEDMARKER-out', 'verification.json');
    const skeletonPath = join(root, 'SUPPLIEDMARKER-out', 'skeleton.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-supplied-source-record-verification-cli.ts', import.meta.url));
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });
    const base = [
      '--commitment', paths.commitment, '--manifest', paths.manifest,
      '--gate', paths.gate, '--authorization', paths.authorization, '--observation', paths.observation,
      '--disposition', paths.disposition, '--closure', paths.closure,
      '--sourceauthorization', paths.srcAuth, '--sourceobservation', paths.srcObs,
      '--sourcedisposition', paths.srcDisp, '--sourceclosure', paths.srcClosure,
    ];

    const ok = run([...base, '--verification', paths.verification, '--out', outPath, '--skeletonout', skeletonPath]);
    assert(ok.error === undefined, `spawn ok: ${ok.error?.message ?? ''}`);
    assertEq(ok.status, 0, `VERIFIED exit 0 (stderr: ${ok.stderr ?? ''})`);
    assert(existsSync(outPath) && existsSync(skeletonPath), 'report and skeleton written');
    const parsed = JSON.parse(ok.stdout ?? '') as Rec;
    assertEq(parsed.overall, 'SOURCE_RECORDS_VERIFIED', 'stdout overall');
    assertEq(parsed.retrievedByThisTool, false, 'stdout retrievedByThisTool false');
    assertEq(parsed.identityVerifiedByThisTool, false, 'stdout identityVerifiedByThisTool false');
    assertEq(parsed.skeletonWritten, true, 'stdout reports the skeleton');
    const skeleton = JSON.parse(readFileSync(skeletonPath, 'utf8')) as Rec;
    assert(Object.values(skeleton.fields as Rec).every((x) => x === 'PENDING'), 'the written skeleton is blank');
    const stdout = ok.stdout ?? '';
    assert(!stdout.includes('SUPPLIEDMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    assert(!stdout.includes('phase-238-synthetic-test') && !stdout.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids in stdout');
    assert(![OPERATOR_DIGEST, VERIFIER_DIGEST, COMMITTER_DIGEST].some((d) => stdout.includes(d)), 'no participant identity in stdout');

    assertEq(run([...base]).status, 1, 'no verification record exits 1');
    assertEq(run([...base, '--verification', paths.declined]).status, 4, 'a declined verification exits 4');
    assertEq(run([...base, '--verification', skeletonPath]).status, 3, 'a blank verification exits 3');
    assertEq(run(['--commitment', join(dir, 'nope.json')]).status, 2, 'unreadable input exits 2');
    assertEq(run([]).status, 5, 'nothing supplied exits 5 (NOT_ELIGIBLE)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The ACTUAL prepared, redaction-safe P227-A evidence, captured verbatim from the non-live artifacts under
// evidence/phase-231. NOTE: no approved authorization, recorded observation, accepted disposition, closed
// closure, committed manifest or verified submission is constructed for this bundle anywhere in this suite.
const REAL_APPROVAL_EVIDENCE = {
  report: 'phase-230-promotion-approval-attestation', version: 1, mode: 'build', ok: true, redactionSafe: true,
  status: 'APPROVAL_ATTESTATION_READY',
  approvalIdDigest: '8f43ff3cd966c368b277a069560978fbcd2e1f15063d420058d5b7b3e0def477',
  itemDigest: 'c23dcefc87e63e8b10fb4c7dd67aac99a0fe512318c0c07c1323e889ffac9431',
  targetRoot: '/mnt/user/media/Movies',
  sourceRealPathDigest: '08505b269e54350636ebdf6969bcffcbc61f60a27de52449cf7b6c9871d5227f',
  sourceSha256: 'f61646264e3f8806ec43742abf75ed142731c57b4346327429dd62ab55afb7cb',
  destinationPathDigest: '099ec7872ddad5654f56aeb86ab3bde7a459d0864533169a70bacab6ef14b924',
  destinationNameDigest: '7383f885db60eaf9c3b18212c12caeaa121b13a362d956c7d4572025dd2b51cd',
  extension: '.mp4', sourceSizeBytes: 1636, titleEchoed: false, sourcePathEchoed: false, destinationPathEchoed: false,
  problems: [], evidenceDigest: '65c6f28e70a572ec99912f5f6140e41daa0f6eb27dcf9228b565ccd11c1e85c8',
};
const REAL_APPROVAL_VALIDATION = {
  ...REAL_APPROVAL_EVIDENCE, mode: 'validate',
  evidenceDigest: '4590bc443da55ad4b6354869c490015491723b533b13a49505fe9967035a8622',
};
const REAL_PREFLIGHT_PLAN = {
  noClobber: true, sameChecksum: true, observedStateRequired: true,
  rollback: { strategy: 'withdraw-run-created-materialization', preservePreexisting: true },
  withdrawal: { allowed: true, byRunId: true, refusePreexisting: true },
  items: [{
    itemId: '0a40074065d91a75ad41f33fc212e917', approvalId: 'phase-231-p227-a-20260720', approvalStatus: 'PENDING',
    sourceDigest: '08505b269e54350636ebdf6969bcffcbc61f60a27de52449cf7b6c9871d5227f',
    destinationDigest: '099ec7872ddad5654f56aeb86ab3bde7a459d0864533169a70bacab6ef14b924',
  }],
};

// The real chain: it stops at Phase 232 PENDING because no human approved the run, so its replay is
// VERIFIED_OPEN and its Phase 237 result is NOT_ELIGIBLE. There is no commitment to verify against, and this
// function constructs none.
function realCommitment(): Rec {
  const preflightReport = buildLivePreflightPlan({ plan: REAL_PREFLIGHT_PLAN });
  const gateEvidence = {
    approvalEvidence: REAL_APPROVAL_EVIDENCE, approvalValidation: REAL_APPROVAL_VALIDATION,
    preflightPlan: REAL_PREFLIGHT_PLAN, preflightReport, preflightSelfDigest: verifySelfDigests([preflightReport]),
  };
  const gate = buildExecutionAuthorization(gateEvidence);
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: real gate ready (${gate.blockers.join(',')})`);
  const authorizationDecision = buildExecutionAuthorizationRecordSkeleton(gate)! as unknown as Rec;
  const authorization = buildExecutionAuthorizationRecord({ gate, record: authorizationDecision });
  assertEq(authorization.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', 'the real run has no human approval');
  const replay = verifyPromotionChainReplay({ gate, authorization, sources: { gateEvidence, authorizationDecision } });
  assertEq(replay.overall, 'CHAIN_REPLAY_VERIFIED_OPEN', 'precondition: the real replay is open');
  const commitment = buildProvenanceCommitment({ replay });
  assertEq(commitment.overall, 'NOT_ELIGIBLE', 'the real chain has no provenance commitment');
  return commitment as unknown as Rec;
}

await test('the actual P227-A chain is LOCKED as NOT_ELIGIBLE: no commitment exists to verify against', () => {
  const commitment = realCommitment();
  assertEq(buildSuppliedSourceVerificationSkeleton(commitment), null, 'no verification skeleton for the real chain');
  const v = buildSuppliedSourceVerification({ commitment });
  assertEq(v.overall, 'NOT_ELIGIBLE', 'the real chain has nothing to verify');
  assertEq(v.recordedVerification, 'NONE', 'no verification for the real run');
  assertEq(v.sourceRecordsVerified, false, 'the real P227-A records are NOT verified');
  assertEq(v.commitmentEligible, false, 'not eligible');
  assertEq(v.sourceRecordCount, 0, 'no source records supplied');
  assert(v.blockers.includes('COMMITMENT_RECORD_NOT_COMMITTED'), 'COMMITMENT_RECORD_NOT_COMMITTED reported');
  assertEq(v.retrievedByThisTool, false, 'this tool retrieved nothing');
  assertEq(verifySelfDigests([v]).overall, 'ALL_VERIFIED', 'the real-chain report self-verifies');
  const json = JSON.stringify(v);
  assert(!json.includes('/mnt/') && !json.includes('0a40074065d91a75ad41f33fc212e917') && !json.includes('phase-231-p227-a-20260720'), 'redaction-safe: no path, no raw ids');
});

// The lock cannot be talked out of: a perfectly-formed verification shaped for the real operation still cannot
// verify records against a commitment that does not exist.
await test('the actual P227-A chain stays NOT_ELIGIBLE even against a fully-formed VERIFIED submission', () => {
  const commitment = realCommitment();
  const shaped = {
    record: SUPPLIED_SOURCE_VERIFICATION_INPUT_ID, version: 1, operation: 'promote-observe-withdraw',
    sourceCommitmentReport: 'phase-237-promotion-source-record-provenance-commitment',
    provenanceDigest: commitment.provenanceDigest as string,
    sourceCommitmentDigest: createHash('sha256').update('fabricated-commitment').digest('hex'),
    fields: {
      verificationAffirmed: 'AFFIRMED', sourceRecordsIndependentlyRetrieved: 'AFFIRMED', sourceRecordsByteCompared: 'AFFIRMED',
    },
    verifierDigest: VERIFIER_DIGEST, verifiedAtUtc: VERIFIED_AT,
  };
  const v = buildSuppliedSourceVerification({
    commitment,
    manifest: { sourceRecords: [232, 233, 234, 235].map((phase) => ({ phase, reportDigest: createHash('sha256').update(`fab-r-${phase}`).digest('hex'), contentDigest: createHash('sha256').update(`fab-c-${phase}`).digest('hex') })) },
    verification: shaped,
  });
  assertEq(v.overall, 'NOT_ELIGIBLE', 'still not eligible');
  assertEq(v.sourceRecordsVerified, false, 'the real P227-A records remain unverified');
  assertEq(v.recordedVerification, 'NONE', 'no verification recorded');
  assertEq(v.manifestBoundToCommitment, false, 'nothing binds to an ineligible commitment');
  assertEq(Object.keys(v.boundDigests).length, 0, 'no digests bound');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
