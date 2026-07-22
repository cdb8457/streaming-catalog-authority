import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildExecutionAuthorizationRecord,
  buildExecutionAuthorizationRecordSkeleton,
  EXECUTION_AUTHORIZATION_RECORD_INPUT_ID,
  EXECUTION_AUTHORIZATION_RECORD_DISCLAIMERS,
  EXECUTION_AUTHORIZATION_RECORD_REMAINING_HUMAN_STEPS,
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
const OPERATOR_DIGEST = createHash('sha256').update('phase-232-operator-under-test').digest('hex');
const DECIDED_AT = '2026-07-21T00:00:00Z';
// The digest of the observed state an approving operator witnessed. Phase 233 binds to this.
const WITNESSED_BEFORE = createHash('sha256').update('phase-232-witnessed-before-state').digest('hex');

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-execrecord-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-execrecord-')); }

// Build a genuine, fully cross-bound Phase 231 gate over a SYNTHETIC one-item bundle. Synthetic on purpose:
// the approved-record cases below must never be built over the real captured P227-A evidence.
function gateFor(root: string, over: { itemId?: string; approvalId?: string; body?: Buffer } = {}): Record<string, unknown> {
  const itemId = over.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = over.approvalId ?? 'phase-232-synthetic-test';
  const testRoot = join(root, `catalog-authority-test-library-${itemId.slice(0, 8)}`);
  const source = join(testRoot, 'Movies', 'Execrecord Proof (2026)', 'source.mp4');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, over.body ?? MINIMAL_MP4_FIXTURE);
  const input = { itemId, title: 'Execrecord Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
  const built = buildApprovalAttestation(input);
  assert(built.ok, 'precondition: approval built');
  const approvalEvidence = built.evidence;
  const approvalValidation = validateApprovalAttestation(built.approval!, input).evidence;
  const plan = {
    noClobber: true,
    sameChecksum: true,
    observedStateRequired: true,
    rollback: { strategy: 'withdraw-run-created-materialization', preservePreexisting: true },
    withdrawal: { allowed: true, byRunId: true, refusePreexisting: true },
    items: [{ itemId, approvalId, approvalStatus: 'PENDING', sourceDigest: approvalEvidence.sourceRealPathDigest, destinationDigest: approvalEvidence.destinationPathDigest }],
  };
  const preflightReport = buildLivePreflightPlan({ plan });
  const gate = buildExecutionAuthorization({
    approvalEvidence, approvalValidation, preflightPlan: plan, preflightReport,
    preflightSelfDigest: verifySelfDigests([preflightReport]),
  });
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: gate ready (${gate.blockers.join(',')})`);
  return gate as unknown as Record<string, unknown>;
}

type Rec = Record<string, unknown>;

function skeletonOf(gate: unknown): Rec {
  const skeleton = buildExecutionAuthorizationRecordSkeleton(gate);
  assert(skeleton !== null, 'precondition: skeleton emitted for a ready gate');
  return JSON.parse(JSON.stringify(skeleton)) as Rec;
}
function recordFor(gate: unknown, over: Rec = {}): Rec {
  const skeleton = skeletonOf(gate);
  const fields = { ...(skeleton.fields as Rec), ...((over.fields as Rec) ?? {}) };
  return { ...skeleton, ...over, fields };
}
// A well-formed human APPROVAL record for a SYNTHETIC gate. Never built over the real P227-A bundle.
function approvedRecord(gate: unknown, over: Rec = {}): Rec {
  const { fields: overFields, ...rest } = over;
  return recordFor(gate, {
    decision: 'APPROVED', operatorDigest: OPERATOR_DIGEST, decidedAtUtc: DECIDED_AT,
    observedStateBeforeDigest: WITNESSED_BEFORE,
    ...rest,
    fields: { operatorAuthorized: 'AFFIRMED', observedStateWitnessedBefore: 'AFFIRMED', withdrawalPathRehearsed: 'AFFIRMED', ...((overFields as Rec) ?? {}) },
  });
}

console.log('Running Phase 232 human execution-authorization record suite:\n');

await test('a valid, digest-bound human APPROVAL record is recorded -- and still performs no run', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    const r = buildExecutionAuthorizationRecord({ gate, record: approvedRecord(gate) });
    assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', `approved (blockers: ${r.blockers.join(',')})`);
    assertEq(r.recordedDecision, 'APPROVED', 'decision echoed');
    assertEq(r.authorizationRecorded, true, 'a human authorization record exists');
    assert(r.gateValid && r.recordWellFormed && r.recordRedactionSafe && r.recordBound && r.decisionCoherent, 'all five checks green');
    assertEq(r.blockers.length, 0, 'no blockers');
    // Recording a decision is NOT performing or capturing anything.
    assertEq(r.execution, 'NOT_PERFORMED', 'execution NOT_PERFORMED even when approved');
    assertEq(r.capturedArtifacts, 'NONE', 'captured artifacts NONE even when approved');
    assertEq(r.selfAuthorized, false, 'never self-authorized');
    assertEq(r.fieldStates.observedStateWitnessedAfter, 'PENDING', 'post-run field still PENDING');
    assertEq(r.fieldStates.runExecutedByHuman, 'PENDING', 'run field still PENDING');
    assertEq(r.remainingHumanSteps.length, EXECUTION_AUTHORIZATION_RECORD_REMAINING_HUMAN_STEPS.length, 'remaining human steps stated');
    assertEq(r.disclaimers.length, EXECUTION_AUTHORIZATION_RECORD_DISCLAIMERS.length, 'disclaimers stated');
    assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'record report self-verifies');
    // All six bindings are recorded, and the report stays redaction-safe.
    for (const k of ['gate-authorization', 'operation-approval-id', 'operation-item', 'operation-source', 'operation-destination', 'operation-plan']) {
      assert(k in r.boundDigests, `${k} bound`);
    }
    const json = JSON.stringify(r);
    assert(!json.includes('/mnt/') && !json.includes('catalog-authority-test-library'), 'no raw path in report');
    assert(!json.includes('phase-232-synthetic-test') && !json.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw approval or item id in report');
    assert(!json.includes('phase-232-operator-under-test') && !json.includes(OPERATOR_DIGEST), 'the report echoes no operator identity, not even its digest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED by default: with no gate and no record nothing is recorded or authorized', () => {
  const r = buildExecutionAuthorizationRecord({});
  assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', 'invalid without inputs');
  assertEq(r.recordedDecision, 'NONE', 'no decision');
  assertEq(r.authorizationRecorded, false, 'nothing authorized');
  assert(r.blockers.includes('GATE_MISSING') && r.blockers.includes('RECORD_MISSING'), 'both inputs reported missing');
  assert(!r.gateValid && !r.recordWellFormed && !r.recordBound && !r.decisionCoherent, 'nothing valid or bound');
  assertEq(r.execution, 'NOT_PERFORMED', 'execution NOT_PERFORMED');
  assert(r.redactionSafe === true && !JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

await test('the emitted skeleton is blank: it validates as PENDING and grants nothing', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    const skeleton = skeletonOf(gate);
    assertEq(skeleton.record, EXECUTION_AUTHORIZATION_RECORD_INPUT_ID, 'skeleton is a record input');
    assertEq(skeleton.decision, 'PENDING', 'skeleton decision PENDING');
    assertEq(skeleton.operatorDigest, 'PENDING', 'skeleton names no operator');
    assertEq(skeleton.decidedAtUtc, 'PENDING', 'skeleton records no decision time');
    assert(Object.values(skeleton.fields as Rec).every((v) => v === 'PENDING'), 'every skeleton field PENDING');
    const r = buildExecutionAuthorizationRecord({ gate, record: skeleton });
    assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', `skeleton is valid but undecided (${r.blockers.join(',')})`);
    assertEq(r.recordedDecision, 'PENDING', 'decision PENDING');
    assertEq(r.authorizationRecorded, false, 'a blank skeleton authorizes nothing');
    assert(r.recordBound && r.decisionCoherent, 'skeleton is bound and coherent');
    assert(!JSON.stringify(skeleton).includes('/mnt/'), 'skeleton is redaction-safe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE security case for this phase: a record is a human approval of ONE operation. A genuine approval for
// one gate must not carry over to a different gate / item / re-planned run.
await test('THE security case: a genuine APPROVED record cannot be transplanted onto a different operation', () => {
  const root = workspace();
  try {
    const gateA = gateFor(root);
    const gateB = gateFor(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-232-other', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    const recordA = approvedRecord(gateA);
    // Sanity: the record genuinely approves operation A.
    assertEq(buildExecutionAuthorizationRecord({ gate: gateA, record: recordA }).overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', 'precondition: genuine approval of A');
    const r = buildExecutionAuthorizationRecord({ gate: gateB, record: recordA });
    assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', 'transplanted record rejected');
    assertEq(r.authorizationRecorded, false, 'no authorization carried over');
    assert(r.blockers.includes('RECORD_NOT_BOUND_TO_GATE'), 'gate digest mismatch reported');
    assert(r.blockers.includes('RECORD_ITEM_DIGEST_MISMATCH') && r.blockers.includes('RECORD_SOURCE_DIGEST_MISMATCH'), 'operation digest mismatches reported');
    assert(!r.recordBound, 'record not bound');
    assertEq(Object.keys(r.boundDigests).length, 1, 'only the valid gate itself is bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a green-bodied but tampered Phase 231 gate fails on digest recompute', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    const record = approvedRecord(gate);
    const tampered = JSON.parse(JSON.stringify(gate)) as Rec;
    assertEq(tampered.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', 'precondition: green');
    tampered.injectedClaim = 'smuggled-through-a-green-gate';
    const r = buildExecutionAuthorizationRecord({ gate: tampered, record });
    assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', 'tampered gate rejected');
    assert(r.blockers.includes('GATE_DIGEST_MISMATCH'), 'green-body tamper -> GATE_DIGEST_MISMATCH');
    assert(!r.gateValid && !r.recordBound, 'nothing bound to a tampered gate');
    assertEq(Object.keys(r.boundDigests).length, 0, 'no digests bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The mechanism records an authorization DECISION, never an execution. A record claiming the run already
// happened is invalid no matter how green everything else is.
await test('adversarial: a record claiming the run was executed is rejected -- post-run fields must stay PENDING', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    for (const claimed of ['runExecutedByHuman', 'observedStateWitnessedAfter']) {
      const r = buildExecutionAuthorizationRecord({ gate, record: approvedRecord(gate, { fields: { [claimed]: 'AFFIRMED' } }) });
      assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', `${claimed} claim rejected`);
      assert(r.blockers.includes('RECORD_POST_RUN_FIELD_NOT_PENDING'), `${claimed} -> RECORD_POST_RUN_FIELD_NOT_PENDING`);
      assertEq(r.authorizationRecorded, false, 'claimed execution authorizes nothing');
      assertEq(r.execution, 'NOT_PERFORMED', 'execution stays NOT_PERFORMED');
      assertEq(r.capturedArtifacts, 'NONE', 'captured artifacts stay NONE');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: an APPROVED decision without every pre-run affirmation fails closed', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    for (const missing of ['operatorAuthorized', 'observedStateWitnessedBefore', 'withdrawalPathRehearsed']) {
      const r = buildExecutionAuthorizationRecord({ gate, record: approvedRecord(gate, { fields: { [missing]: 'PENDING' } }) });
      assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', `un-affirmed ${missing} rejected`);
      assert(r.blockers.includes('RECORD_APPROVED_WITHOUT_PRE_RUN_AFFIRMATION'), `${missing} -> RECORD_APPROVED_WITHOUT_PRE_RUN_AFFIRMATION`);
      assert(!r.decisionCoherent && !r.authorizationRecorded, 'incoherent record authorizes nothing');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a DECLINED record is valid, records the refusal, and authorizes nothing', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    const declined = recordFor(gate, {
      decision: 'DECLINED', operatorDigest: OPERATOR_DIGEST, decidedAtUtc: DECIDED_AT,
      fields: { operatorAuthorized: 'REFUSED', observedStateWitnessedBefore: 'AFFIRMED' },
    });
    const r = buildExecutionAuthorizationRecord({ gate, record: declined });
    assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_DECLINED', `declined (${r.blockers.join(',')})`);
    assertEq(r.recordedDecision, 'DECLINED', 'refusal recorded');
    assertEq(r.authorizationRecorded, false, 'a refusal authorizes nothing');
    assert(r.recordBound && r.decisionCoherent, 'a refusal is still a bound, coherent record');
    // A DECLINED record that nonetheless affirms the operator authorized it is incoherent.
    const contradictory = { ...declined, fields: { ...(declined.fields as Rec), operatorAuthorized: 'AFFIRMED' } };
    const bad = buildExecutionAuthorizationRecord({ gate, record: contradictory });
    assertEq(bad.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', 'contradictory refusal rejected');
    assert(bad.blockers.includes('RECORD_DECLINED_WITHOUT_REFUSED_AUTHORIZATION'), 'contradiction reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: an undecided record that quietly affirms the operator authorization is rejected', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    const r = buildExecutionAuthorizationRecord({ gate, record: recordFor(gate, { fields: { operatorAuthorized: 'AFFIRMED' } }) });
    assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', 'PENDING decision with affirmed authorization rejected');
    assert(r.blockers.includes('RECORD_PENDING_WITH_DECIDED_AUTHORIZATION'), 'PENDING/AFFIRMED contradiction reported');
    assertEq(r.authorizationRecorded, false, 'no authorization inferred from a field');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A decided record must say WHO (by digest) and WHEN; an undecided one must claim neither.
// An approval affirms `observedStateWitnessedBefore` -- so it must say WHICH state was witnessed. An
// affirmation of nothing in particular binds nothing, and Phase 233 would have nothing to check against.
await test('an APPROVED record must pin the observed state its operator witnessed', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    // Approved, every field affirmed, but naming no witnessed state.
    const unpinned = buildExecutionAuthorizationRecord({ gate, record: approvedRecord(gate, { observedStateBeforeDigest: 'PENDING' }) });
    assertEq(unpinned.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', 'an approval that pins no witnessed state is rejected');
    assert(unpinned.blockers.includes('RECORD_OBSERVED_STATE_BEFORE_REQUIRED'), 'RECORD_OBSERVED_STATE_BEFORE_REQUIRED reported');
    assertEq(unpinned.authorizationRecorded, false, 'nothing authorized');
    assert(!('observed-state-before' in unpinned.boundDigests), 'no witnessed state published');

    // A valid approval publishes it for Phase 233 to bind to.
    const good = buildExecutionAuthorizationRecord({ gate, record: approvedRecord(gate) });
    assertEq(good.boundDigests['observed-state-before'], WITNESSED_BEFORE, 'the witnessed state is published');

    // A record that authorized NOTHING witnessed nothing it can pin.
    const declined = recordFor(gate, {
      decision: 'DECLINED', operatorDigest: OPERATOR_DIGEST, decidedAtUtc: DECIDED_AT,
      observedStateBeforeDigest: WITNESSED_BEFORE,
      fields: { operatorAuthorized: 'REFUSED' },
    });
    const d = buildExecutionAuthorizationRecord({ gate, record: declined });
    assertEq(d.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', 'a refusal may not pin a witnessed state');
    assert(d.blockers.includes('RECORD_OBSERVED_STATE_BEFORE_NOT_PENDING'), 'RECORD_OBSERVED_STATE_BEFORE_NOT_PENDING reported');
    const undecided = buildExecutionAuthorizationRecord({ gate, record: recordFor(gate, { observedStateBeforeDigest: WITNESSED_BEFORE }) });
    assert(undecided.blockers.includes('RECORD_OBSERVED_STATE_BEFORE_NOT_PENDING'), 'an undecided record may not pin one either');

    // Malformed values fail the shape check, and the field sits inside the strict allowlist and redaction scan.
    for (const bad of ['looked-about-right', 42, null, 'PENDING '] as unknown[]) {
      const r = buildExecutionAuthorizationRecord({ gate, record: approvedRecord(gate, { observedStateBeforeDigest: bad }) });
      assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', `malformed witnessed state rejected: ${String(bad)}`);
      assert(r.blockers.includes('RECORD_OBSERVED_STATE_BEFORE_INVALID'), `RECORD_OBSERVED_STATE_BEFORE_INVALID for ${String(bad)}`);
    }
    const leaky = buildExecutionAuthorizationRecord({ gate, record: approvedRecord(gate, { observedStateBeforeDigest: '/mnt/user/media/Movies/witness.mkv' }) });
    assert(leaky.blockers.includes('RECORD_LIVE_SURFACE'), 'a raw path in the witnessed field is caught by the redaction scan');
    assert(!JSON.stringify(leaky).includes('/mnt/'), 'and is never echoed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: operator digest and decision time must match the decision state', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    const anonymous = buildExecutionAuthorizationRecord({ gate, record: approvedRecord(gate, { operatorDigest: 'PENDING' }) });
    assert(anonymous.blockers.includes('RECORD_OPERATOR_DIGEST_REQUIRED'), 'an approval must name its operator by digest');
    assertEq(anonymous.authorizationRecorded, false, 'anonymous approval rejected');
    const undated = buildExecutionAuthorizationRecord({ gate, record: approvedRecord(gate, { decidedAtUtc: '21 July 2026' }) });
    assert(undated.blockers.includes('RECORD_DECIDED_AT_REQUIRED'), 'an approval must carry a strict UTC timestamp');
    const predated = buildExecutionAuthorizationRecord({ gate, record: recordFor(gate, { operatorDigest: OPERATOR_DIGEST }) });
    assert(predated.blockers.includes('RECORD_OPERATOR_DIGEST_NOT_PENDING'), 'an undecided record may not name an operator');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A human writes this record by hand, so it is the likeliest place for a raw path to leak in.
await test('adversarial: a smuggled raw path in the record fails closed and is never echoed', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    const smuggled = { ...approvedRecord(gate), operatorNote: '/mnt/user/media/Movies/Execrecord Proof (2026)/source.mp4' };
    const r = buildExecutionAuthorizationRecord({ gate, record: smuggled });
    assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', 'smuggled path rejected');
    assert(r.blockers.includes('RECORD_LIVE_SURFACE'), 'raw path -> RECORD_LIVE_SURFACE');
    assert(r.blockers.includes('RECORD_UNKNOWN_FIELD'), 'off-allowlist field -> RECORD_UNKNOWN_FIELD');
    assert(!r.recordRedactionSafe, 'record not redaction-safe');
    const json = JSON.stringify(r);
    assert(!json.includes('/mnt/') && !json.includes('source.mp4'), 'the smuggled path is never echoed back');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: no record can be bound to a BLOCKED Phase 231 gate, and no skeleton is emitted for one', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    const record = approvedRecord(gate);
    const blockedGate = buildExecutionAuthorization({});
    assertEq(blockedGate.overall, 'EXECUTION_AUTHORIZATION_BLOCKED', 'precondition: blocked gate');
    assertEq(verifySelfDigests([blockedGate]).overall, 'ALL_VERIFIED', 'precondition: blocked gate is genuine');
    assertEq(buildExecutionAuthorizationRecordSkeleton(blockedGate), null, 'no skeleton for a blocked gate');
    const r = buildExecutionAuthorizationRecord({ gate: blockedGate, record });
    assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', 'blocked gate rejects the record');
    assert(r.blockers.includes('GATE_NOT_TEMPLATE_READY') && r.blockers.includes('GATE_TEMPLATE_MISSING'), 'blocked-gate blockers reported');
    assertEq(r.authorizationRecorded, false, 'an approval over a blocked gate authorizes nothing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI records a bound decision, writes a blank skeleton, and never echoes raw paths or ids', () => {
  const root = workspace();
  try {
    const gate = gateFor(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const gatePath = w('gate.json', gate);
    const recordPath = w('record.json', approvedRecord(gate));
    const outPath = join(root, 'EXECRECMARKER-out', 'record-report.json');
    const skeletonPath = join(root, 'EXECRECMARKER-out', 'skeleton.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-execution-authorization-record-cli.ts', import.meta.url));
    const run = (args: readonly string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });

    const ok = run(['--gate', gatePath, '--record', recordPath, '--out', outPath, '--skeletonout', skeletonPath]);
    assert(ok.error === undefined, `spawn ok: ${ok.error?.message ?? ''}`);
    assertEq(ok.status, 0, `APPROVED exit 0 (stderr: ${ok.stderr ?? ''})`);
    assert(existsSync(outPath) && existsSync(skeletonPath), 'report and skeleton written');
    const parsed = JSON.parse(ok.stdout ?? '') as Rec;
    assertEq(parsed.overall, 'EXECUTION_AUTHORIZATION_RECORD_APPROVED', 'stdout overall');
    assertEq(parsed.authorizationRecorded, true, 'stdout reports the recorded authorization');
    assertEq(parsed.execution, 'NOT_PERFORMED', 'stdout execution NOT_PERFORMED');
    assertEq(parsed.capturedArtifacts, 'NONE', 'stdout captured artifacts NONE');
    assertEq(parsed.skeletonWritten, true, 'stdout reports the skeleton');
    // The written skeleton is blank regardless of the approved record it was emitted alongside.
    const skeleton = JSON.parse(readFileSync(skeletonPath, 'utf8')) as Rec;
    assertEq(skeleton.decision, 'PENDING', 'written skeleton is undecided');
    assert(Object.values(skeleton.fields as Rec).every((v) => v === 'PENDING'), 'written skeleton is blank');
    const stdout = ok.stdout ?? '';
    assert(!stdout.includes('EXECRECMARKER') && !stdout.includes('catalog-authority-test-library') && !stdout.includes('/mnt/'), 'no path fragments in stdout');
    assert(!stdout.includes('phase-232-synthetic-test') && !stdout.includes('0a40074065d91a75ad41f33fc212e917'), 'no raw ids in stdout');

    // Fail closed on the wire too: a gate with no record exits non-zero and records nothing.
    const blocked = run(['--gate', gatePath]);
    assertEq(blocked.status, 1, `missing record exits 1 (stderr: ${blocked.stderr ?? ''})`);
    const blockedOut = JSON.parse(blocked.stdout ?? '') as Rec;
    assertEq(blockedOut.authorizationRecorded, false, 'nothing recorded without a record');
    assertEq(run(['--gate', join(dir, 'does-not-exist.json')]).status, 2, 'unreadable input exits 2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The ACTUAL prepared, redaction-safe P227-A evidence (captured verbatim from the non-live artifacts under
// evidence/phase-231). Locked here so the validator is exercised against the real gate offline and
// deterministically -- no SSH, no secret approval file, no live surface. NOTE: no APPROVED record is
// constructed for this bundle anywhere in this suite; the real P227-A run stays unauthorized.
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

function realGate(): Record<string, unknown> {
  const preflightReport = buildLivePreflightPlan({ plan: REAL_PREFLIGHT_PLAN });
  const gate = buildExecutionAuthorization({
    approvalEvidence: REAL_APPROVAL_EVIDENCE,
    approvalValidation: REAL_APPROVAL_VALIDATION,
    preflightPlan: REAL_PREFLIGHT_PLAN,
    preflightReport,
    preflightSelfDigest: verifySelfDigests([preflightReport]),
  });
  assertEq(gate.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `precondition: real gate ready (${gate.blockers.join(',')})`);
  return gate as unknown as Record<string, unknown>;
}

// The witnessed-state binding is a Phase 232 change ONLY. Phase 231 is produced before any human witnesses
// anything, so the real gate must be byte-identical to what it was before that change -- locked here.
await test('the witnessed-state binding leaves the real P227-A gate completely unchanged', () => {
  assertEq(realGate().authorizationDigest, 'a128c9d0797afd034615256a59c06c14d9d88187d42c7fdfce0ef0ee6d40cdaa',
    'the real Phase 231 gate digest is untouched by the Phase 232 witnessed-state field');
});

await test('the real prepared P227-A run has NO operator record: the validator fails closed', () => {
  const r = buildExecutionAuthorizationRecord({ gate: realGate() });
  assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_INVALID', 'no record -> invalid');
  assertEq(r.recordedDecision, 'NONE', 'no decision exists for the real run');
  assertEq(r.authorizationRecorded, false, 'the real P227-A run is NOT authorized');
  assert(r.blockers.includes('RECORD_MISSING'), 'RECORD_MISSING reported');
  assert(r.gateValid, 'the real gate itself is valid');
  assertEq(r.execution, 'NOT_PERFORMED', 'nothing executed');
  assertEq(r.capturedArtifacts, 'NONE', 'nothing captured');
});

await test('the real prepared P227-A run stays PENDING under a blank skeleton -- the mechanism grants nothing', () => {
  const gate = realGate();
  const skeleton = skeletonOf(gate);
  assertEq(skeleton.decision, 'PENDING', 'the real bundle gets only a blank, undecided record');
  const r = buildExecutionAuthorizationRecord({ gate, record: skeleton });
  assertEq(r.overall, 'EXECUTION_AUTHORIZATION_RECORD_PENDING', `real bundle pending (${r.blockers.join(',')})`);
  assertEq(r.recordedDecision, 'PENDING', 'no human decision recorded for the real run');
  assertEq(r.authorizationRecorded, false, 'the real P227-A run remains unauthorized');
  assert(r.recordBound && r.gateValid && r.decisionCoherent, 'the blank record is genuinely bound to the real operation');
  assertEq(r.fieldStates.runExecutedByHuman, 'PENDING', 'the run has not been executed');
  assertEq(r.capturedArtifacts, 'NONE', 'captured artifacts NONE');
  assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'real-bundle report self-verifies');
  const json = JSON.stringify(r);
  assert(!json.includes('/mnt/') && !json.includes('0a40074065d91a75ad41f33fc212e917') && !json.includes('phase-231-p227-a-20260720'), 'redaction-safe: no path, no raw ids');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
