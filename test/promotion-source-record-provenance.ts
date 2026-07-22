import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildProvenanceCommitment,
  buildProvenanceCommitmentSkeleton,
  PROVENANCE_COMMITMENT_INPUT_ID,
  PROVENANCE_COMMITMENT_DISCLAIMERS,
  PROVENANCE_COMMITMENT_REMAINING_HUMAN_STEPS,
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
const OPERATOR_DIGEST = createHash('sha256').update('phase-237-operator-under-test').digest('hex');
const OBSERVER_DIGEST = createHash('sha256').update('phase-237-observer-under-test').digest('hex');
const REVIEWER_DIGEST = createHash('sha256').update('phase-237-reviewer-under-test').digest('hex');
const CLOSER_DIGEST = createHash('sha256').update('phase-237-closer-under-test').digest('hex');
const COMMITTER_DIGEST = createHash('sha256').update('phase-237-committer-under-test').digest('hex');
const DECIDED_AT = '2026-07-21T00:00:00Z';
const OBSERVED_AT = '2026-07-21T01:00:00Z';
const REVIEWED_AT = '2026-07-21T02:00:00Z';
const CLOSED_AT = '2026-07-21T03:00:00Z';
const COMMITTED_AT = '2026-07-21T04:00:00Z';
const STATE_BEFORE = createHash('sha256').update('synthetic-observed-state-before').digest('hex');
const STATE_AFTER = createHash('sha256').update('synthetic-observed-state-after').digest('hex');

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-provenance-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-provenance-')); }

type Rec = Record<string, unknown>;
interface ChainOpts { itemId?: string; approvalId?: string; body?: Buffer; closure?: 'CLOSED' | 'HELD_OPEN' }
interface Sources { gateEvidence: Rec; authorizationDecision: Rec; observation: Rec; disposition: Rec; closure: Rec }
interface Chain { reports: Rec; sources: Sources }

// A COMPLETE, genuine, five-phase SYNTHETIC chain plus the source records each phase consumed. Synthetic on
// purpose: no approved authorization, recorded observation, accepted disposition or closed closure exists for
// the real P227-A bundle, and this suite never constructs one.
function fullChain(root: string, o: ChainOpts = {}): Chain {
  const itemId = o.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = o.approvalId ?? 'phase-237-synthetic-test';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Provenance Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, o.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Provenance Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
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

  const want = o.closure ?? 'CLOSED';
  const closureRecord: Rec = {
    ...JSON.parse(JSON.stringify(buildOperationClosureSkeleton(disposition)!)) as Rec,
    closerDigest: CLOSER_DIGEST, closedAtUtc: CLOSED_AT,
    fields: {
      closureAffirmed: want === 'CLOSED' ? 'AFFIRMED' : 'REFUSED',
      evidenceArchivedOutOfBand: 'AFFIRMED', chainDigestsRecordedInArchive: 'AFFIRMED',
      noOutstandingRemediation: 'AFFIRMED', evidencePurged: 'PENDING',
    },
  };
  const closure = buildOperationClosureRecord({ dispositionRecord: disposition, closure: closureRecord });
  assertEq(closure.overall, `OPERATION_CLOSURE_${want}`, `precondition: closure ${want} (${closure.blockers.join(',')})`);

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

// A genuine, fully VERIFIED_CLOSED Phase 236 replay -- the only thing this phase is eligible over.
function verifiedReplay(root: string, o: ChainOpts = {}): { replay: Rec; chain: Chain } {
  const chain = fullChain(root, o);
  const replay = verifyPromotionChainReplay({ ...chain.reports, sources: chain.sources });
  assertEq(replay.overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', `precondition: replay verified closed (${replay.blockers.join(',')})`);
  return { replay: replay as unknown as Rec, chain };
}

// The human's content digest for a source record. Synthetic: this suite retains no real record and the
// validator never recomputes these -- that is the point stated in the disclaimers.
function contentDigestOf(sourceRecord: unknown, salt = ''): string {
  return createHash('sha256').update(`synthetic-content:${salt}:${JSON.stringify(sourceRecord)}`).digest('hex');
}

function skeletonOf(replay: unknown): Rec {
  const skeleton = buildProvenanceCommitmentSkeleton(replay);
  assert(skeleton !== null, 'precondition: skeleton emitted for a verified closed replay');
  return JSON.parse(JSON.stringify(skeleton)) as Rec;
}

// A COMMITTED manifest over a synthetic chain: every affirmation made, every content digest pinned.
function committedManifest(replay: unknown, chain: Chain, over: Rec = {}): Rec {
  const skeleton = skeletonOf(replay);
  const s = chain.sources;
  const contents: Record<number, unknown> = { 232: s.authorizationDecision, 233: s.observation, 234: s.disposition, 235: s.closure };
  const { fields: overFields, sourceRecords: overRecords, ...rest } = over;
  return {
    ...skeleton,
    sourceRecords: (overRecords as unknown[]) ?? (skeleton.sourceRecords as Rec[]).map((e) => ({
      ...e, contentDigest: contentDigestOf(contents[e.phase as number]),
    })),
    committerDigest: COMMITTER_DIGEST,
    committedAtUtc: COMMITTED_AT,
    ...rest,
    fields: {
      commitmentAffirmed: 'AFFIRMED',
      sourceRecordsRetainedIndependently: 'AFFIRMED',
      sourceRecordsContentDigested: 'AFFIRMED',
      sourceRecordsReviewed: 'AFFIRMED',
      sourceRecordsBoundToThisReplay: 'AFFIRMED',
      ...((overFields as Rec) ?? {}),
    },
  };
}

// Re-seal a mutated Phase 236 report so it recomputes its own digest cleanly. A self-digest is not a
// signature: anyone can rebuild one, which is exactly why the eligibility checks must stand on their own.
function forgeReplay(report: Rec, mutate: (r: Rec) => void): Rec {
  const forged = JSON.parse(JSON.stringify(report)) as Rec;
  mutate(forged);
  delete forged.replayDigest;
  const body: Rec = {};
  for (const k of Object.keys(forged)) body[k] = forged[k];
  forged.replayDigest = createHash('sha256').update(`phase-236-chain-replay:${JSON.stringify(body)}`).digest('hex');
  return forged;
}

console.log('Running Phase 237 source-record provenance commitment suite:\n');

await test('a genuine digest-bound human commitment is recorded -- and this tool still commits and verifies nothing', () => {
  const root = workspace();
  try {
    const { replay, chain } = verifiedReplay(root);
    const p = buildProvenanceCommitment({ replay, manifest: committedManifest(replay, chain) });
    assertEq(p.overall, 'PROVENANCE_COMMITTED', `committed (blockers: ${p.blockers.join(',')})`);
    assertEq(p.recordedCommitment, 'COMMITTED', 'commitment echoed');
    assertEq(p.provenanceCommitted, true, 'a human commitment exists');
    assert(p.replayEligible && p.manifestWellFormed && p.manifestRedactionSafe && p.manifestBound && p.manifestCoherent, 'all five checks green');
    assertEq(p.blockers.length, 0, 'no blockers');
    // Recording a commitment is not making one, and never verifies an identity.
    assertEq(p.committedByThisTool, false, 'this tool committed nothing');
    assertEq(p.verifiedIdentityByThisTool, false, 'this tool verified no identity');
    assertEq(p.selfAuthorized, false, 'never self-authorized');
    assertEq(p.sourceRecordCount, 4, 'four source records committed');
    assert(p.sourceRecords.every((r) => r.present && r.reportDigestMatched && r.contentDigestPresent), 'every record present, paired and digested');
    assertEq(p.sourceRecords.map((r) => r.phase).join(','), '232,233,234,235', 'one entry per human-record phase');
    assert(typeof p.sourceCommitmentDigest === 'string' && p.sourceCommitmentDigest.length === 64, 'a durable commitment digest is published');
    assertEq(p.remainingHumanSteps.length, PROVENANCE_COMMITMENT_REMAINING_HUMAN_STEPS.length, 'remaining human steps stated');
    assertEq(p.disclaimers.length, PROVENANCE_COMMITMENT_DISCLAIMERS.length, 'disclaimers stated');
    assertEq(verifySelfDigests([p]).overall, 'ALL_VERIFIED', 'the provenance report self-verifies');
    // Bound to the replay and to every already-public chain digest.
    for (const k of ['replay-report', 'approvalIdDigest', 'itemDigest', 'sourceDigest', 'destinationDigest', 'planDigest', 'phase-232', 'phase-233', 'phase-234', 'phase-235']) {
      assert(k in p.boundDigests, `${k} bound`);
    }
    // Redaction: no path, no ids, no identities, and NOT the committed content digests.
    const json = JSON.stringify(p);
    assert(!json.includes('/mnt/') && !json.includes('catalog-authority-test-library'), 'no raw path in report');
    assert(!json.includes('phase-237-synthetic-test') && !json.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw approval or item id');
    assert(![OPERATOR_DIGEST, OBSERVER_DIGEST, REVIEWER_DIGEST, CLOSER_DIGEST, COMMITTER_DIGEST].some((d) => json.includes(d)), 'no participant identity echoed');
    assert(!json.includes(COMMITTED_AT) && !json.includes(DECIDED_AT), 'no timestamp echoed');
    const committedContent = contentDigestOf(chain.sources.observation);
    assert(!json.includes(committedContent), 'the committed content digests are never echoed back');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED by default: with no replay and no manifest the chain is NOT_ELIGIBLE', () => {
  const p = buildProvenanceCommitment({});
  assertEq(p.overall, 'NOT_ELIGIBLE', 'not eligible without inputs');
  assertEq(p.recordedCommitment, 'NONE', 'no commitment');
  assertEq(p.provenanceCommitted, false, 'nothing committed');
  assert(p.blockers.includes('REPLAY_RECORD_MISSING') && p.blockers.includes('MANIFEST_MISSING'), 'both inputs reported missing');
  assert(!p.replayEligible && !p.manifestWellFormed && !p.manifestBound && !p.manifestCoherent, 'nothing valid or bound');
  assertEq(p.sourceCommitmentDigest, null, 'no commitment digest published');
  assert(p.redactionSafe === true && !JSON.stringify(p).includes('/mnt/'), 'redaction-safe');
});

await test('the emitted skeleton pre-affirms nothing: it validates as PENDING and commits nothing', () => {
  const root = workspace();
  try {
    const { replay } = verifiedReplay(root);
    const skeleton = skeletonOf(replay);
    assertEq(skeleton.record, PROVENANCE_COMMITMENT_INPUT_ID, 'skeleton is a manifest input');
    assertEq(skeleton.committerDigest, 'PENDING', 'skeleton names no committer');
    assertEq(skeleton.committedAtUtc, 'PENDING', 'skeleton records no time');
    assert(Object.values(skeleton.fields as Rec).every((v) => v === 'PENDING'), 'every skeleton field PENDING');
    // It pre-fills ONLY derived bindings; it never invents a content digest.
    const entries = skeleton.sourceRecords as Rec[];
    assertEq(entries.length, 4, 'four blank entries');
    assert(entries.every((e) => e.contentDigest === 'PENDING'), 'no content digest is ever invented');
    assertEq(entries.map((e) => e.phase).join(','), '232,233,234,235', 'derived phases, in order');
    assert(entries.every((e) => typeof e.reportDigest === 'string' && (e.reportDigest as string).length === 64), 'derived report digests pre-filled');
    assert(Object.values(skeleton).every((v) => v !== true && v !== 'AFFIRMED' && v !== 'COMMITTED'), 'the skeleton asserts nothing');

    const p = buildProvenanceCommitment({ replay, manifest: skeleton });
    assertEq(p.overall, 'PROVENANCE_PENDING', `skeleton is valid but uncommitted (${p.blockers.join(',')})`);
    assertEq(p.recordedCommitment, 'PENDING', 'commitment PENDING');
    assertEq(p.provenanceCommitted, false, 'a blank skeleton commits nothing');
    assert(p.manifestBound && p.manifestCoherent, 'the blank skeleton is bound and coherent');
    assertEq(p.sourceCommitmentDigest, null, 'nothing committed, nothing pinned');
    assert(p.sourceRecords.every((r) => r.present && r.reportDigestMatched && !r.contentDigestPresent), 'paired but not yet digested');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a DECLINED manifest is valid, records the refusal, and commits nothing', () => {
  const root = workspace();
  try {
    const { replay, chain } = verifiedReplay(root);
    const declined = committedManifest(replay, chain, { fields: { commitmentAffirmed: 'REFUSED' } });
    const p = buildProvenanceCommitment({ replay, manifest: declined });
    assertEq(p.overall, 'PROVENANCE_DECLINED', `declined (${p.blockers.join(',')})`);
    assertEq(p.recordedCommitment, 'DECLINED', 'refusal recorded');
    assertEq(p.provenanceCommitted, false, 'a refusal commits nothing');
    assertEq(p.sourceCommitmentDigest, null, 'nothing pinned by a refusal');
    assert(p.manifestBound && p.manifestCoherent, 'a refusal is still a bound, coherent manifest');
    // Declining is ALWAYS available: it is never gated on the affirmations or on content digests.
    const bare = committedManifest(replay, chain, {
      fields: {
        commitmentAffirmed: 'REFUSED', sourceRecordsRetainedIndependently: 'PENDING',
        sourceRecordsContentDigested: 'PENDING', sourceRecordsReviewed: 'PENDING', sourceRecordsBoundToThisReplay: 'PENDING',
      },
      sourceRecords: (skeletonOf(replay).sourceRecords as Rec[]),
    });
    assertEq(buildProvenanceCommitment({ replay, manifest: bare }).overall, 'PROVENANCE_DECLINED', 'refusing is never refused');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a COMMITTED manifest missing any affirmation or content digest fails closed', () => {
  const root = workspace();
  try {
    const { replay, chain } = verifiedReplay(root);
    for (const f of ['sourceRecordsRetainedIndependently', 'sourceRecordsContentDigested', 'sourceRecordsReviewed', 'sourceRecordsBoundToThisReplay']) {
      const p = buildProvenanceCommitment({ replay, manifest: committedManifest(replay, chain, { fields: { [f]: 'PENDING' } }) });
      assertEq(p.overall, 'PROVENANCE_INVALID', `un-affirmed ${f} rejected`);
      assert(p.blockers.includes('MANIFEST_COMMITTED_WITHOUT_FULL_AFFIRMATION'), `${f} -> MANIFEST_COMMITTED_WITHOUT_FULL_AFFIRMATION`);
      assertEq(p.provenanceCommitted, false, 'nothing committed');
    }
    // Committing to nothing is not committing: every content digest must be pinned.
    const unpinned = committedManifest(replay, chain, { sourceRecords: (skeletonOf(replay).sourceRecords as Rec[]) });
    const u = buildProvenanceCommitment({ replay, manifest: unpinned });
    assertEq(u.overall, 'PROVENANCE_INVALID', 'a commitment with no content digests rejected');
    assert(u.blockers.includes('MANIFEST_CONTENT_DIGEST_REQUIRED'), 'unpinned -> MANIFEST_CONTENT_DIGEST_REQUIRED');
    // An undecided manifest pins nothing at all.
    const skeleton = skeletonOf(replay);
    const pinnedPending = { ...skeleton, sourceRecords: (skeleton.sourceRecords as Rec[]).map((e) => ({ ...e, contentDigest: contentDigestOf(e) })) };
    const q = buildProvenanceCommitment({ replay, manifest: pinnedPending });
    assertEq(q.overall, 'PROVENANCE_INVALID', 'an undecided manifest that pins digests rejected');
    assert(q.blockers.includes('MANIFEST_CONTENT_DIGEST_NOT_PENDING'), 'pinned while PENDING -> MANIFEST_CONTENT_DIGEST_NOT_PENDING');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE point of this phase: the manifest pins WHICH records were used, so swapping one is caught.
await test('THE substitution case: swapping any one committed source-record content digest is detectable', () => {
  const root = workspace();
  try {
    const { replay, chain } = verifiedReplay(root);
    const genuine = committedManifest(replay, chain);
    const committed = buildProvenanceCommitment({ replay, manifest: genuine });
    assertEq(committed.overall, 'PROVENANCE_COMMITTED', 'precondition: a genuine commitment');
    const anchor = committed.sourceCommitmentDigest;

    // Substituting the content digest of ANY single record changes the durable anchor -- that is what makes a
    // later swap detectable. The manifest stays structurally valid; the commitment is simply to something else.
    for (const phase of [232, 233, 234, 235]) {
      const swapped = {
        ...genuine,
        sourceRecords: (genuine.sourceRecords as Rec[]).map((e) => e.phase === phase
          ? { ...e, contentDigest: contentDigestOf(chain.sources.observation, `substituted-${phase}`) } : e),
      };
      const p = buildProvenanceCommitment({ replay, manifest: swapped });
      assertEq(p.overall, 'PROVENANCE_COMMITTED', `a substituted commitment is still well-formed: phase ${phase}`);
      assert(p.sourceCommitmentDigest !== anchor, `phase ${phase} substitution changes the commitment anchor`);
    }
    // Determinism: the same manifest always yields the same anchor, so a later re-check is meaningful.
    assertEq(buildProvenanceCommitment({ replay, manifest: genuine }).sourceCommitmentDigest, anchor, 'the anchor is deterministic');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a source record paired with the wrong report digest fails closed', () => {
  const root = workspace();
  try {
    const a = verifiedReplay(root);
    const b = verifiedReplay(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-237-other', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    const genuine = committedManifest(a.replay, a.chain);
    const otherEntries = skeletonOf(b.replay).sourceRecords as Rec[];
    // Chain A's manifest, but one entry paired with chain B's report digest for that phase.
    const mispaired = {
      ...genuine,
      sourceRecords: (genuine.sourceRecords as Rec[]).map((e) => e.phase === 233
        ? { ...e, reportDigest: otherEntries.find((o) => o.phase === 233)!.reportDigest } : e),
    };
    const p = buildProvenanceCommitment({ replay: a.replay, manifest: mispaired });
    assertEq(p.overall, 'PROVENANCE_INVALID', 'mispaired record rejected');
    assert(p.blockers.includes('MANIFEST_SOURCE_RECORD_REPORT_DIGEST_MISMATCH'), 'mispairing -> MANIFEST_SOURCE_RECORD_REPORT_DIGEST_MISMATCH');
    assert(!p.manifestBound, 'not bound');
    assertEq(p.provenanceCommitted, false, 'nothing committed');
    assert(p.sourceRecords.some((r) => r.phase === 233 && !r.reportDigestMatched), 'the mispaired phase is reported unmatched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('THE transplantation case: a genuine manifest cannot be replayed against a different replay', () => {
  const root = workspace();
  try {
    const a = verifiedReplay(root);
    const b = verifiedReplay(root, { itemId: '88888888888888888888888888888888', approvalId: 'phase-237-transplant', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-transplant')]) });
    const manifestA = committedManifest(a.replay, a.chain);
    assertEq(buildProvenanceCommitment({ replay: a.replay, manifest: manifestA }).overall, 'PROVENANCE_COMMITTED', 'precondition: genuine commitment over A');
    const p = buildProvenanceCommitment({ replay: b.replay, manifest: manifestA });
    assertEq(p.overall, 'PROVENANCE_INVALID', 'transplanted manifest rejected');
    assertEq(p.provenanceCommitted, false, 'no commitment carried over');
    assert(p.blockers.includes('MANIFEST_NOT_BOUND_TO_REPLAY'), 'replay digest mismatch reported');
    assert(p.blockers.includes('MANIFEST_ITEM_DIGEST_MISMATCH') && p.blockers.includes('MANIFEST_SOURCE_DIGEST_MISMATCH'), 'operation digest mismatches reported');
    assert(p.blockers.includes('MANIFEST_SOURCE_RECORD_REPORT_DIGEST_MISMATCH'), 'every record pairs with the wrong report');
    assertEq(Object.keys(p.boundDigests).length, 1, 'only the valid replay itself is bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: omission, duplication and reordering of source records each fail closed distinctly', () => {
  const root = workspace();
  try {
    const { replay, chain } = verifiedReplay(root);
    const genuine = committedManifest(replay, chain);
    const entries = genuine.sourceRecords as Rec[];

    const omitted = { ...genuine, sourceRecords: entries.filter((e) => e.phase !== 234) };
    const o = buildProvenanceCommitment({ replay, manifest: omitted });
    assertEq(o.overall, 'PROVENANCE_INVALID', 'omission rejected');
    assert(o.blockers.includes('MANIFEST_SOURCE_RECORD_COUNT_INVALID'), 'omission -> MANIFEST_SOURCE_RECORD_COUNT_INVALID');
    assert(o.blockers.includes('MANIFEST_SOURCE_RECORD_PHASE_INVALID'), 'and the missing phase is reported');

    const duplicated = { ...genuine, sourceRecords: [entries[0], entries[1], entries[2], entries[2]] };
    const d = buildProvenanceCommitment({ replay, manifest: duplicated });
    assertEq(d.overall, 'PROVENANCE_INVALID', 'duplication rejected');
    assert(d.blockers.includes('MANIFEST_SOURCE_RECORD_DUPLICATED'), 'duplication -> MANIFEST_SOURCE_RECORD_DUPLICATED');

    const reordered = { ...genuine, sourceRecords: [entries[1], entries[0], entries[2], entries[3]] };
    const r = buildProvenanceCommitment({ replay, manifest: reordered });
    assertEq(r.overall, 'PROVENANCE_INVALID', 'reordering rejected');
    assert(r.blockers.includes('MANIFEST_SOURCE_RECORD_OUT_OF_ORDER'), 'reordering -> MANIFEST_SOURCE_RECORD_OUT_OF_ORDER');
    assert(!r.blockers.includes('MANIFEST_SOURCE_RECORD_DUPLICATED'), 'reordering is distinct from duplication');

    const foreignPhase = { ...genuine, sourceRecords: entries.map((e) => e.phase === 235 ? { ...e, phase: 231 } : e) };
    const f = buildProvenanceCommitment({ replay, manifest: foreignPhase });
    assert(f.blockers.includes('MANIFEST_SOURCE_RECORD_PHASE_INVALID'), 'a phase outside 232-235 -> MANIFEST_SOURCE_RECORD_PHASE_INVALID');

    const notAList = { ...genuine, sourceRecords: { '232': entries[0] } };
    assert(buildProvenanceCommitment({ replay, manifest: notAList }).blockers.includes('MANIFEST_SOURCE_RECORDS_INVALID'), 'a non-list -> MANIFEST_SOURCE_RECORDS_INVALID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// NOT_ELIGIBLE is about the CHAIN, not the manifest, and it takes precedence over everything.
await test('a replay that is not VERIFIED_CLOSED is NOT_ELIGIBLE, whatever the manifest says', () => {
  const root = workspace();
  try {
    const good = verifiedReplay(root);
    const manifest = committedManifest(good.replay, good.chain);

    // VERIFIED_OPEN: a genuine chain a human held open rather than closed.
    const held = fullChain(root, { closure: 'HELD_OPEN', itemId: '77777777777777777777777777777777', approvalId: 'phase-237-open', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-open')]) });
    const openReplay = verifyPromotionChainReplay({ ...held.reports, sources: held.sources });
    assertEq(openReplay.overall, 'CHAIN_REPLAY_VERIFIED_OPEN', 'precondition: genuinely open');
    const openResult = buildProvenanceCommitment({ replay: openReplay, manifest });
    assertEq(openResult.overall, 'NOT_ELIGIBLE', 'an open chain has nothing to commit provenance for');
    assert(openResult.blockers.includes('REPLAY_RECORD_NOT_VERIFIED_CLOSED'), 'REPLAY_RECORD_NOT_VERIFIED_CLOSED reported');
    assert(openResult.blockers.includes('REPLAY_RECORD_OPERATION_NOT_CLOSED'), 'the unclosed operation is reported too');
    assertEq(buildProvenanceCommitmentSkeleton(openReplay), null, 'no skeleton for an open chain');

    // STRUCTURAL_ONLY: the same reports without their source records.
    const structural = verifyPromotionChainReplay(good.chain.reports);
    assertEq(structural.overall, 'CHAIN_REPLAY_STRUCTURAL_ONLY', 'precondition: structural only');
    const s = buildProvenanceCommitment({ replay: structural, manifest });
    assertEq(s.overall, 'NOT_ELIGIBLE', 'an unverified chain is not eligible');
    assert(s.blockers.includes('REPLAY_RECORD_NOT_SEMANTICALLY_REDERIVED'), 'REPLAY_RECORD_NOT_SEMANTICALLY_REDERIVED reported');
    assertEq(buildProvenanceCommitmentSkeleton(structural), null, 'no skeleton for a structural-only chain');

    // NOT_REPLAYABLE: a headless bundle.
    const headless = verifyPromotionChainReplay({ authorization: good.chain.reports.authorization });
    assertEq(headless.overall, 'CHAIN_NOT_REPLAYABLE', 'precondition: not replayable');
    const h = buildProvenanceCommitment({ replay: headless, manifest });
    assertEq(h.overall, 'NOT_ELIGIBLE', 'an unreplayable chain is not eligible');
    assert(h.blockers.includes('REPLAY_RECORD_BLOCKERS_PRESENT'), 'its own blockers are reported');
    assertEq(buildProvenanceCommitmentSkeleton(headless), null, 'no skeleton');

    for (const r of [openResult, s, h]) {
      assertEq(r.provenanceCommitted, false, 'nothing committed');
      assertEq(r.recordedCommitment, 'NONE', 'no commitment recorded');
      assert(!r.manifestBound, 'nothing binds to an ineligible replay');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_ELIGIBLE takes precedence over a broken manifest', () => {
  const root = workspace();
  try {
    const { replay } = verifiedReplay(root);
    const structural = verifyPromotionChainReplay({});
    for (const broken of [undefined, 'not-an-object', { record: 'wrong' }, [] as unknown]) {
      const p = buildProvenanceCommitment({ replay: structural, manifest: broken });
      assertEq(p.overall, 'NOT_ELIGIBLE', 'an ineligible chain wins over a broken manifest');
      assertEq(p.provenanceCommitted, false, 'nothing committed');
    }
    // And an entirely absent replay with a perfectly good manifest is still NOT_ELIGIBLE.
    const p = buildProvenanceCommitment({ manifest: skeletonOf(replay) });
    assertEq(p.overall, 'NOT_ELIGIBLE', 'absent replay -> NOT_ELIGIBLE');
    assert(p.blockers.includes('REPLAY_RECORD_MISSING'), 'REPLAY_RECORD_MISSING reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a green-bodied but tampered Phase 236 replay fails on digest recompute', () => {
  const root = workspace();
  try {
    const { replay, chain } = verifiedReplay(root);
    const tampered = JSON.parse(JSON.stringify(replay)) as Rec;
    assertEq(tampered.overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', 'precondition: green');
    tampered.injectedClaim = 'smuggled-through-a-green-replay';
    const p = buildProvenanceCommitment({ replay: tampered, manifest: committedManifest(replay, chain) });
    assertEq(p.overall, 'NOT_ELIGIBLE', 'a tampered replay is not eligible');
    assert(p.blockers.includes('REPLAY_RECORD_DIGEST_MISMATCH'), 'green-body tamper -> REPLAY_RECORD_DIGEST_MISMATCH');
    assert(!p.replayEligible && !p.manifestBound, 'nothing bound to a tampered replay');
    assertEq(Object.keys(p.boundDigests).length, 0, 'no digests bound');
    assertEq(buildProvenanceCommitmentSkeleton(tampered), null, 'no skeleton');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The lesson of commit d60d6ee, applied one layer up: a self-digest is not a signature, so the eligibility
// checks must stand on the replay's WHOLE BODY, not its headline. Each forgery below recomputes cleanly.
await test('adversarial: a FORGED Phase 236 replay that recomputes its own digest is caught by the eligibility checks', () => {
  const root = workspace();
  try {
    const { replay, chain } = verifiedReplay(root);
    const manifest = committedManifest(replay, chain);
    const cases: Array<[string, (r: Rec) => void, string]> = [
      ['the replay is not redaction-safe', (r) => { r.redactionSafe = false; }, 'REPLAY_RECORD_NOT_REDACTION_SAFE'],
      ['the chain is not complete', (r) => { r.chainComplete = false; }, 'REPLAY_RECORD_CHAIN_NOT_COMPLETE'],
      ['the operation is not closed', (r) => { r.operationClosed = false; }, 'REPLAY_RECORD_OPERATION_NOT_CLOSED'],
      ['nothing was semantically re-derived', (r) => { r.semanticallyRederived = false; }, 'REPLAY_RECORD_NOT_SEMANTICALLY_REDERIVED'],
      ['identity was never anchored', (r) => { r.identityAnchored = false; }, 'REPLAY_RECORD_IDENTITY_NOT_ANCHORED'],
      ['it did not actually replay', (r) => { r.replayedByThisTool = false; }, 'REPLAY_RECORD_NOT_REPLAYED_BY_TOOL'],
      ['it claims to have performed the run', (r) => { r.performedByThisTool = true; }, 'REPLAY_RECORD_PERFORMED_CLAIMED'],
      ['it claims to have captured state', (r) => { r.capturedByThisTool = true; }, 'REPLAY_RECORD_CAPTURED_CLAIMED'],
      ['it is self-authorized', (r) => { r.selfAuthorized = true; }, 'REPLAY_RECORD_SELF_AUTHORIZED'],
      ['blockers were recorded under a green headline', (r) => { r.blockers = ['SOMETHING_FAILED']; }, 'REPLAY_RECORD_BLOCKERS_PRESENT'],
      ['blockers is not even a list', (r) => { r.blockers = 'none'; }, 'REPLAY_RECORD_BLOCKERS_PRESENT'],
      ['a phase was never re-derived from its source', (r) => { (r.phases as Rec[])[2]!.rederivedFromSource = false; }, 'REPLAY_RECORD_PHASES_INCOMPLETE'],
      ['a phase identity never matched', (r) => { (r.phases as Rec[])[3]!.identityMatched = false; }, 'REPLAY_RECORD_PHASES_INCOMPLETE'],
      ['the operation digests were stripped', (r) => { r.operationDigests = {}; }, 'REPLAY_RECORD_OPERATION_DIGESTS_INCOMPLETE'],
      ['the chain digests were stripped', (r) => { r.chainDigests = {}; }, 'REPLAY_RECORD_CHAIN_DIGESTS_INCOMPLETE'],
    ];
    for (const [what, mutate, code] of cases) {
      const forged = forgeReplay(replay, mutate);
      // Prove the forgery is self-digest valid: the digest check cannot see any of this.
      assertEq(verifySelfDigests([forged]).overall, 'ALL_VERIFIED', `precondition: ${what} recomputes cleanly`);
      assertEq((forged as Rec).overall, 'CHAIN_REPLAY_VERIFIED_CLOSED', `precondition: ${what} keeps a green headline`);
      const p = buildProvenanceCommitment({ replay: forged, manifest });
      assertEq(p.overall, 'NOT_ELIGIBLE', `forged replay rejected: ${what}`);
      assert(!p.blockers.includes('REPLAY_RECORD_DIGEST_MISMATCH'), `${what}: the digest check does NOT catch this -- the semantic check must`);
      assert(p.blockers.includes(code), `${what} -> ${code}`);
      assertEq(p.provenanceCommitted, false, `nothing committed: ${what}`);
      assertEq(p.replayEligible, false, `not eligible: ${what}`);
      assertEq(buildProvenanceCommitmentSkeleton(forged), null, `no skeleton for a forged replay: ${what}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: malformed digests, enums and timestamps fail closed', () => {
  const root = workspace();
  try {
    const { replay, chain } = verifiedReplay(root);
    const bad: Array<[string, Rec, string]> = [
      ['a malformed replay digest', { replayDigest: 'not-a-digest' }, 'MANIFEST_REPLAY_DIGEST_INVALID'],
      ['a wrong source report id', { sourceReplayReport: 'phase-999-something' }, 'MANIFEST_SOURCE_REPORT_MISMATCH'],
      ['a wrong operation', { operation: 'something-else' }, 'MANIFEST_OPERATION_MISMATCH'],
      ['an unsupported version', { version: 2 }, 'MANIFEST_VERSION_UNSUPPORTED'],
      ['a malformed committer digest', { committerDigest: 'nope' }, 'MANIFEST_COMMITTER_DIGEST_REQUIRED'],
      ['a malformed timestamp', { committedAtUtc: '21 July 2026' }, 'MANIFEST_COMMITTED_AT_REQUIRED'],
    ];
    for (const [what, over, code] of bad) {
      const p = buildProvenanceCommitment({ replay, manifest: committedManifest(replay, chain, over) });
      assertEq(p.overall, 'PROVENANCE_INVALID', `${what} rejected`);
      assert(p.blockers.includes(code), `${what} -> ${code}`);
    }
    // Field-state enum.
    const badField = buildProvenanceCommitment({ replay, manifest: committedManifest(replay, chain, { fields: { sourceRecordsReviewed: 'PROBABLY' } }) });
    assert(badField.blockers.includes('MANIFEST_FIELD_STATE_INVALID'), 'a non-enum field state -> MANIFEST_FIELD_STATE_INVALID');
    // Entry-level malformation.
    const genuine = committedManifest(replay, chain);
    const badEntry = { ...genuine, sourceRecords: (genuine.sourceRecords as Rec[]).map((e) => e.phase === 232 ? { ...e, reportDigest: 'short' } : e) };
    assert(buildProvenanceCommitment({ replay, manifest: badEntry }).blockers.includes('MANIFEST_SOURCE_RECORD_ENTRY_INVALID'), 'a malformed report digest -> MANIFEST_SOURCE_RECORD_ENTRY_INVALID');
    const badContent = { ...genuine, sourceRecords: (genuine.sourceRecords as Rec[]).map((e) => e.phase === 233 ? { ...e, contentDigest: 'looked-fine' } : e) };
    assert(buildProvenanceCommitment({ replay, manifest: badContent }).blockers.includes('MANIFEST_SOURCE_RECORD_CONTENT_DIGEST_INVALID'), 'a malformed content digest -> MANIFEST_SOURCE_RECORD_CONTENT_DIGEST_INVALID');
    // Undecided manifests may claim neither a committer nor a time.
    const skeleton = skeletonOf(replay);
    assert(buildProvenanceCommitment({ replay, manifest: { ...skeleton, committerDigest: COMMITTER_DIGEST } }).blockers.includes('MANIFEST_COMMITTER_DIGEST_NOT_PENDING'), 'an undecided manifest may not name a committer');
    assert(buildProvenanceCommitment({ replay, manifest: { ...skeleton, committedAtUtc: COMMITTED_AT } }).blockers.includes('MANIFEST_COMMITTED_AT_NOT_PENDING'), 'an undecided manifest may not carry a time');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a smuggled raw path in the manifest fails closed and is never echoed', () => {
  const root = workspace();
  try {
    const { replay, chain } = verifiedReplay(root);
    const smuggled = { ...committedManifest(replay, chain), committerNote: '/mnt/user/media/Movies/Provenance Proof (2026)/source.mp4' };
    const p = buildProvenanceCommitment({ replay, manifest: smuggled });
    assertEq(p.overall, 'PROVENANCE_INVALID', 'smuggled path rejected');
    assert(p.blockers.includes('MANIFEST_LIVE_SURFACE'), 'raw path -> MANIFEST_LIVE_SURFACE');
    assert(p.blockers.includes('MANIFEST_UNKNOWN_FIELD'), 'off-allowlist field -> MANIFEST_UNKNOWN_FIELD');
    assert(!p.manifestRedactionSafe, 'manifest not redaction-safe');
    const json = JSON.stringify(p);
    assert(!json.includes('/mnt/') && !json.includes('source.mp4'), 'the smuggled path is never echoed back');
    // An off-allowlist field is rejected on its own merits even when it carries nothing sensitive.
    const benign = buildProvenanceCommitment({ replay, manifest: { ...committedManifest(replay, chain), notes: 'all good' } });
    assertEq(benign.overall, 'PROVENANCE_INVALID', 'unknown field rejected alone');
    assert(benign.blockers.includes('MANIFEST_UNKNOWN_FIELD') && benign.manifestRedactionSafe, 'unknown but redaction-safe');
    // A live surface buried inside an entry is caught too.
    const genuine = committedManifest(replay, chain);
    const buried = { ...genuine, sourceRecords: (genuine.sourceRecords as Rec[]).map((e) => e.phase === 234 ? { ...e, note: 'http://jellyfin.local/library/refresh' } : e) };
    const b = buildProvenanceCommitment({ replay, manifest: buried });
    assert(b.blockers.includes('MANIFEST_LIVE_SURFACE'), 'a buried live surface -> MANIFEST_LIVE_SURFACE');
    assert(!JSON.stringify(b).includes('jellyfin'), 'the live identifier is never echoed back');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI records a bound commitment, writes a blank skeleton, and never echoes raw paths or ids', () => {
  const root = workspace();
  try {
    const { replay, chain } = verifiedReplay(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const replayPath = w('replay.json', replay);
    const manifestPath = w('manifest.json', committedManifest(replay, chain));
    const outPath = join(root, 'PROVMARKER-out', 'provenance.json');
    const skeletonPath = join(root, 'PROVMARKER-out', 'skeleton.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-source-record-provenance-cli.ts', import.meta.url));
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });

    const ok = run(['--replay', replayPath, '--manifest', manifestPath, '--out', outPath, '--skeletonout', skeletonPath]);
    assert(ok.error === undefined, `spawn ok: ${ok.error?.message ?? ''}`);
    assertEq(ok.status, 0, `COMMITTED exit 0 (stderr: ${ok.stderr ?? ''})`);
    assert(existsSync(outPath) && existsSync(skeletonPath), 'report and skeleton written');
    const parsed = JSON.parse(ok.stdout ?? '') as Rec;
    assertEq(parsed.overall, 'PROVENANCE_COMMITTED', 'stdout overall');
    assertEq(parsed.provenanceCommitted, true, 'stdout reports the commitment');
    assertEq(parsed.committedByThisTool, false, 'stdout committedByThisTool false');
    assertEq(parsed.verifiedIdentityByThisTool, false, 'stdout verifiedIdentityByThisTool false');
    assertEq(parsed.skeletonWritten, true, 'stdout reports the skeleton');
    // The written skeleton is blank regardless of the committed manifest alongside it.
    const skeleton = JSON.parse(readFileSync(skeletonPath, 'utf8')) as Rec;
    assert((skeleton.sourceRecords as Rec[]).every((e) => e.contentDigest === 'PENDING'), 'written skeleton invents no content digest');
    assert(Object.values(skeleton.fields as Rec).every((v) => v === 'PENDING'), 'written skeleton is blank');
    const stdout = ok.stdout ?? '';
    assert(!stdout.includes('PROVMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    assert(!stdout.includes('phase-237-synthetic-test') && !stdout.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids in stdout');
    assert(![OPERATOR_DIGEST, OBSERVER_DIGEST, REVIEWER_DIGEST, CLOSER_DIGEST, COMMITTER_DIGEST].some((d) => stdout.includes(d)), 'no participant identity in stdout');
    assert(!stdout.includes(contentDigestOf(chain.sources.closure)), 'no committed content digest in stdout');

    // Every other exit path.
    assertEq(run(['--replay', replayPath, '--manifest', w('skel.json', skeletonOf(replay))]).status, 3, 'blank manifest exits 3');
    assertEq(run(['--replay', replayPath, '--manifest', w('dec.json', committedManifest(replay, chain, { fields: { commitmentAffirmed: 'REFUSED' } }))]).status, 4, 'declined exits 4');
    assertEq(run(['--replay', replayPath, '--manifest', w('bad.json', { record: 'wrong' })]).status, 1, 'invalid manifest exits 1');
    assertEq(run(['--replay', replayPath]).status, 1, 'missing manifest exits 1');
    const structuralPath = w('structural.json', verifyPromotionChainReplay(chain.reports));
    const ineligible = run(['--replay', structuralPath, '--manifest', manifestPath, '--skeletonout', join(root, 'PROVMARKER-out', 'none.json')]);
    assertEq(ineligible.status, 5, 'ineligible replay exits 5');
    assertEq((JSON.parse(ineligible.stdout ?? '') as Rec).skeletonWritten, false, 'no skeleton written for an ineligible replay');
    assertEq(run(['--replay', join(dir, 'does-not-exist.json')]).status, 2, 'unreadable input exits 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The ACTUAL prepared, redaction-safe P227-A evidence, captured verbatim from the non-live artifacts under
// evidence/phase-231. Locked here so the validator is exercised against the real chain offline and
// deterministically -- no SSH, no secret approval file, no live surface. NOTE: no approved authorization,
// recorded observation, accepted disposition, closed closure or committed manifest is constructed for this
// bundle anywhere in this suite. The real run never happened.
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

// The real chain, end to end and offline. It stops at Phase 232 PENDING because no human approved the run, so
// its replay is VERIFIED_OPEN and it can never be eligible. This function constructs no approval and no
// downstream record.
function realReplay(): Rec {
  const preflightReport = buildLivePreflightPlan({ plan: REAL_PREFLIGHT_PLAN });
  const gateEvidence = {
    approvalEvidence: REAL_APPROVAL_EVIDENCE,
    approvalValidation: REAL_APPROVAL_VALIDATION,
    preflightPlan: REAL_PREFLIGHT_PLAN,
    preflightReport,
    preflightSelfDigest: verifySelfDigests([preflightReport]),
  };
  const gate = buildExecutionAuthorization(gateEvidence);
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: real gate ready (${gate.blockers.join(',')})`);
  const authorizationDecision = buildExecutionAuthorizationRecordSkeleton(gate)! as unknown as Rec;
  const authorization = buildExecutionAuthorizationRecord({ gate, record: authorizationDecision });
  assertEq(authorization.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', 'the real run has no human approval');
  const replay = verifyPromotionChainReplay({
    gate, authorization, sources: { gateEvidence, authorizationDecision },
  });
  assertEq(replay.overall, 'CHAIN_REPLAY_VERIFIED_OPEN', `precondition: the real replay is open (${replay.blockers.join(',')})`);
  assertEq(replay.terminalPhase, 232, 'the real chain terminates at Phase 232');
  return replay as unknown as Rec;
}

await test('the actual P227-A chain is LOCKED as NOT_ELIGIBLE: unauthorized, open, never closed', () => {
  const replay = realReplay();
  assertEq((replay as Rec).operationClosed, false, 'precondition: the real operation is not closed');
  assertEq(buildProvenanceCommitmentSkeleton(replay), null, 'no provenance skeleton exists for the real chain');
  const p = buildProvenanceCommitment({ replay });
  assertEq(p.overall, 'NOT_ELIGIBLE', 'the real chain has nothing to commit provenance for');
  assertEq(p.recordedCommitment, 'NONE', 'no commitment for the real run');
  assertEq(p.provenanceCommitted, false, 'the real P227-A run has NO committed provenance');
  assertEq(p.replayEligible, false, 'not eligible');
  assertEq(p.sourceCommitmentDigest, null, 'nothing pinned');
  assertEq(p.sourceRecordCount, 0, 'no source records committed');
  assert(p.blockers.includes('REPLAY_RECORD_NOT_VERIFIED_CLOSED'), 'REPLAY_RECORD_NOT_VERIFIED_CLOSED reported');
  assert(p.blockers.includes('REPLAY_RECORD_OPERATION_NOT_CLOSED'), 'the open operation is reported');
  assert(p.blockers.includes('MANIFEST_MISSING'), 'and no manifest exists either');
  assertEq(p.committedByThisTool, false, 'this tool committed nothing');
  assertEq(p.verifiedIdentityByThisTool, false, 'this tool verified no identity');
  assertEq(verifySelfDigests([p]).overall, 'ALL_VERIFIED', 'the real-chain report self-verifies');
  const json = JSON.stringify(p);
  assert(!json.includes('/mnt/') && !json.includes('0a40074065d91a75ad41f33fc212e917') && !json.includes('phase-231-p227-a-20260720'), 'redaction-safe: no path, no raw ids');
});

// The lock cannot be talked out of: a perfectly-formed commitment shaped for the real operation still cannot
// commit provenance for a chain that never closed.
await test('the actual P227-A chain stays NOT_ELIGIBLE even against a fully-formed COMMITTED manifest', () => {
  const replay = realReplay();
  const shaped = {
    record: PROVENANCE_COMMITMENT_INPUT_ID, version: 1, operation: 'promote-observe-withdraw',
    sourceReplayReport: 'phase-236-promotion-chain-replay-verification',
    replayDigest: replay.replayDigest as string,
    approvalIdDigest: REAL_APPROVAL_EVIDENCE.approvalIdDigest, itemDigest: REAL_APPROVAL_EVIDENCE.itemDigest,
    sourceDigest: REAL_APPROVAL_EVIDENCE.sourceRealPathDigest, destinationDigest: REAL_APPROVAL_EVIDENCE.destinationPathDigest,
    planDigest: REAL_APPROVAL_EVIDENCE.sourceSha256,
    sourceRecords: [232, 233, 234, 235].map((phase) => ({
      phase,
      reportDigest: createHash('sha256').update(`fabricated-report-${phase}`).digest('hex'),
      contentDigest: createHash('sha256').update(`fabricated-content-${phase}`).digest('hex'),
    })),
    fields: {
      commitmentAffirmed: 'AFFIRMED', sourceRecordsRetainedIndependently: 'AFFIRMED',
      sourceRecordsContentDigested: 'AFFIRMED', sourceRecordsReviewed: 'AFFIRMED', sourceRecordsBoundToThisReplay: 'AFFIRMED',
    },
    committerDigest: COMMITTER_DIGEST, committedAtUtc: COMMITTED_AT,
  };
  const p = buildProvenanceCommitment({ replay, manifest: shaped });
  assertEq(p.overall, 'NOT_ELIGIBLE', 'still not eligible');
  assertEq(p.provenanceCommitted, false, 'the real P227-A run remains without committed provenance');
  assertEq(p.recordedCommitment, 'NONE', 'no commitment recorded');
  assertEq(p.sourceCommitmentDigest, null, 'nothing pinned');
  assert(!p.manifestBound, 'nothing binds to an ineligible replay');
  assertEq(Object.keys(p.boundDigests).length, 0, 'no digests bound');
  assert(p.blockers.includes('REPLAY_RECORD_NOT_VERIFIED_CLOSED'), 'the ineligible chain is the finding');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
