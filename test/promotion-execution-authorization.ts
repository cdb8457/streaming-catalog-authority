import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildExecutionAuthorization,
  EXECUTION_AUTHORIZATION_HUMAN_GATES,
  EXECUTION_AUTHORIZATION_DISCLAIMERS,
  type ExecutionAuthorizationInput,
} from '../src/ops/promotion-execution-authorization.js';
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

const MINIMAL_MP4_FIXTURE = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isomcatalog-authority-execauth-fixture', 'ascii'),
]);

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-execauth-')); }

function sourceInTestLibrary(root: string, name = 'source.mp4', body: Buffer = MINIMAL_MP4_FIXTURE): { source: string; testRoot: string } {
  const testRoot = join(root, 'catalog-authority-test-library');
  const source = join(testRoot, 'Movies', 'Execauth Proof (2026)', name);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, body);
  return { source, testRoot };
}

// Build a complete, genuine, mutually-bound P227-A-shaped bundle from primitives. The plan's per-item
// source/destination digests are taken from the approval evidence, exactly as the prepared artifacts do.
function bundleFor(root: string, over: { itemId?: string; approvalId?: string; body?: Buffer } = {}) {
  const itemId = over.itemId ?? '0a40074065d91a75ad41f33fc212e917';
  const approvalId = over.approvalId ?? 'phase-231-p227-a-test';
  const { source, testRoot } = sourceInTestLibrary(root, 'source.mp4', over.body);
  const input = { itemId, title: 'Execauth Proof', year: 2026, sourceFile: source, testLibraryRoot: testRoot, targetRoot: APPROVED_ROOT, approvalId };
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
  const preflightSelfDigest = verifySelfDigests([preflightReport]);
  assertEq(preflightReport.overall, 'PREFLIGHT_PLAN_VALID', 'precondition: preflight valid');
  assertEq(preflightSelfDigest.overall, 'ALL_VERIFIED', 'precondition: self-digest all-verified');
  const bundle: ExecutionAuthorizationInput = { approvalEvidence, approvalValidation, preflightPlan: plan, preflightReport, preflightSelfDigest };
  return { bundle, plan, approvalEvidence, approvalValidation, preflightReport, itemId, approvalId };
}

console.log('Running Phase 231 execution-authorization gate suite:\n');

await test('READY only with a fully valid, cross-bound P227-A bundle; emits a NOT-authorized bound template', () => {
  const root = workspace();
  try {
    const { bundle, itemId, approvalId } = bundleFor(root);
    const a = buildExecutionAuthorization(bundle);
    assertEq(a.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `ready (blockers: ${a.blockers.join(',')})`);
    assertEq(a.authorization, 'NONE', 'live authorization is NONE');
    assertEq(a.status, 'PENDING', 'status PENDING');
    assert(a.approvalEvidenceValid && a.approvalValidationBound && a.preflightValid && a.preflightRederived && a.selfDigestBound && a.operationBound, 'all six gates green');
    assertEq(a.blockers.length, 0, 'no blockers');
    // The emitted template is present, digest-bound, and every field is a PENDING placeholder.
    assert(a.template !== null, 'template emitted');
    assertEq(a.template!.operation, 'promote-observe-withdraw', 'operation is promote-observe-withdraw');
    assertEq(a.template!.authorization, 'NONE', 'template authorization NONE');
    assert(Object.values(a.template!.fields).every((v) => v === 'PENDING'), 'every template field PENDING');
    assert(a.template!.approvalIdDigest.length === 64 && a.template!.planDigest.length === 64, 'template carries digests');
    // Redaction: no raw path, no raw item id, no raw approval id, and never grants approval.
    const json = JSON.stringify(a);
    assert(!json.includes('/mnt/'), 'no raw path in report');
    assert(!json.includes(itemId), 'no raw item id in report');
    assert(!json.includes(approvalId), 'no raw approval id in report');
    assert(!json.includes('APPROVED') && !json.includes('GRANTED'), 'no completed authorization outcome emitted');
    assertEq(a.humanGates.length, EXECUTION_AUTHORIZATION_HUMAN_GATES.length, 'human gates stated');
    assertEq(a.disclaimers.length, EXECUTION_AUTHORIZATION_DISCLAIMERS.length, 'disclaimers stated');
    assertEq(verifySelfDigests([a]).overall, 'ALL_VERIFIED', 'gate self-verifies');
    // All five component digests are bound.
    assert(['approval-evidence', 'approval-validation', 'preflight-report', 'preflight-plan', 'preflight-self-digest'].every((k) => k in a.boundDigests), 'all components bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('BLOCKED by default: nothing is authorized without evidence, and no template is emitted', () => {
  const a = buildExecutionAuthorization({});
  assertEq(a.overall, 'EXECUTION_AUTHORIZATION_BLOCKED', 'blocked without evidence');
  assertEq(a.template, null, 'no template emitted when blocked');
  assertEq(a.authorization, 'NONE', 'authorization still NONE');
  for (const code of ['APPROVAL_EVIDENCE_MISSING', 'APPROVAL_VALIDATION_MISSING', 'PREFLIGHT_REPORT_MISSING', 'PREFLIGHT_PLAN_MISSING', 'PREFLIGHT_SELF_DIGEST_MISSING']) {
    assert(a.blockers.includes(code), `${code} blocker`);
  }
  assert(!a.operationBound && !a.preflightValid, 'nothing valid/bound');
  assert(a.redactionSafe === true && !JSON.stringify(a).includes('/mnt/'), 'redaction-safe');
});

await test('THE security case: a green approval evidence with a tampered body fails on digest recompute', () => {
  const root = workspace();
  try {
    const { bundle } = bundleFor(root);
    const tampered = JSON.parse(JSON.stringify(bundle.approvalEvidence)) as Record<string, unknown>;
    assertEq(tampered.status, 'APPROVAL_ATTESTATION_READY', 'precondition: green');
    tampered.injectedClaim = 'smuggled-through-a-green-status';
    const a = buildExecutionAuthorization({ ...bundle, approvalEvidence: tampered });
    assertEq(a.overall, 'EXECUTION_AUTHORIZATION_BLOCKED', 'tampered evidence not ready');
    assert(a.blockers.includes('APPROVAL_EVIDENCE_DIGEST_MISMATCH'), 'green-body tamper -> digest mismatch');
    assertEq(a.template, null, 'no template on tamper');
    assert(!('approval-evidence' in a.boundDigests), 'tampered evidence not bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a genuine approval-validation for a DIFFERENT item is caught by the binding cross-check', () => {
  const root = workspace();
  try {
    const good = bundleFor(root);
    // A genuinely valid validation attestation, but for a different item (different id + body). It recomputes
    // green on its own, yet its binding digests differ from the build evidence -> APPROVAL_VALIDATION_NOT_BOUND.
    const other = bundleFor(root, { itemId: '99999999999999999999999999999999', approvalId: 'phase-231-other', body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-other')]) });
    assertEq(verifySelfDigests([other.approvalValidation]).overall, 'ALL_VERIFIED', 'precondition: foreign validation is genuinely green');
    const a = buildExecutionAuthorization({ ...good.bundle, approvalValidation: other.approvalValidation });
    assertEq(a.overall, 'EXECUTION_AUTHORIZATION_BLOCKED', 'unbound validation not ready');
    assert(a.blockers.includes('APPROVAL_VALIDATION_NOT_BOUND'), 'foreign validation -> APPROVAL_VALIDATION_NOT_BOUND');
    assert(!a.approvalValidationBound, 'validation not bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a plan item whose source digest does not match the approval fails the one-shot operation binding', () => {
  const root = workspace();
  try {
    const { bundle, plan } = bundleFor(root);
    const foreignPlan = JSON.parse(JSON.stringify(plan)) as { items: Array<Record<string, unknown>> };
    foreignPlan.items[0]!.sourceDigest = 'a'.repeat(64); // a well-formed but wrong source digest
    const report = buildLivePreflightPlan({ plan: foreignPlan });
    const selfDigest = verifySelfDigests([report]);
    const a = buildExecutionAuthorization({ ...bundle, preflightPlan: foreignPlan, preflightReport: report, preflightSelfDigest: selfDigest });
    assertEq(a.overall, 'EXECUTION_AUTHORIZATION_BLOCKED', 'mismatched source not ready');
    assert(a.blockers.includes('OPERATION_SOURCE_DIGEST_MISMATCH'), 'wrong source digest -> OPERATION_SOURCE_DIGEST_MISMATCH');
    assert(!a.operationBound, 'operation not bound');
    assertEq(a.template, null, 'no template when operation unbound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: more than one item fails the one-shot constraint', () => {
  const root = workspace();
  try {
    const { bundle, plan } = bundleFor(root);
    const twoItems = JSON.parse(JSON.stringify(plan)) as { items: unknown[] };
    twoItems.items = [twoItems.items[0], JSON.parse(JSON.stringify(twoItems.items[0]))];
    const report = buildLivePreflightPlan({ plan: twoItems });
    const selfDigest = verifySelfDigests([report]);
    const a = buildExecutionAuthorization({ ...bundle, preflightPlan: twoItems, preflightReport: report, preflightSelfDigest: selfDigest });
    assertEq(a.overall, 'EXECUTION_AUTHORIZATION_BLOCKED', 'two items not ready');
    assert(a.blockers.includes('ITEM_COUNT_NOT_ONE'), 'two items -> ITEM_COUNT_NOT_ONE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The self-digest artifact must be the verification of EXACTLY this one preflight report -- not a bundle
// that merely includes it. A genuine ALL_VERIFIED self-digest over two reports has a different verifier
// digest than the verification of the single preflight report, so it fails the binding.
await test('adversarial: a self-digest that verifies more than just this one preflight report is not accepted', () => {
  const root = workspace();
  try {
    const { bundle } = bundleFor(root);
    // A genuine, ALL_VERIFIED self-digest -- but over TWO reports (the preflight report AND the approval
    // evidence), so it does not equal the verification of the single preflight report.
    const bundledSelfDigest = verifySelfDigests([bundle.preflightReport, bundle.approvalEvidence]);
    assertEq(bundledSelfDigest.overall, 'ALL_VERIFIED', 'precondition: bundled self-digest is genuinely green');
    assertEq(bundledSelfDigest.count, 2, 'precondition: covers two reports');
    const a = buildExecutionAuthorization({ ...bundle, preflightSelfDigest: bundledSelfDigest });
    assertEq(a.overall, 'EXECUTION_AUTHORIZATION_BLOCKED', 'over-broad self-digest not ready');
    assert(a.blockers.includes('PREFLIGHT_SELF_DIGEST_NOT_BOUND'), 'over-broad self-digest -> PREFLIGHT_SELF_DIGEST_NOT_BOUND');
    assert(!a.selfDigestBound, 'self-digest not bound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a report whose plan does not re-derive from the supplied plan fails closed', () => {
  const root = workspace();
  try {
    const { bundle, plan } = bundleFor(root);
    // A genuine, valid two-item report + self-digest, but the supplied plan is the one-item plan: rebuilding
    // the one-item plan yields a different planDigest than the two-item report -> PREFLIGHT_PLAN_NOT_REDERIVED.
    const twoItemPlan = { ...plan, items: [plan.items[0], JSON.parse(JSON.stringify(plan.items[0]))] };
    const twoItemReport = buildLivePreflightPlan({ plan: twoItemPlan });
    const twoItemSelfDigest = verifySelfDigests([twoItemReport]);
    const a = buildExecutionAuthorization({ ...bundle, preflightReport: twoItemReport, preflightSelfDigest: twoItemSelfDigest });
    assertEq(a.overall, 'EXECUTION_AUTHORIZATION_BLOCKED', 'non-rederiving report not ready');
    assert(a.blockers.includes('PREFLIGHT_PLAN_NOT_REDERIVED'), 'mismatched plan -> PREFLIGHT_PLAN_NOT_REDERIVED');
    assert(!a.preflightRederived, 'plan not re-derived');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI builds the execution-authorization template and never echoes raw paths or ids to stdout', () => {
  const root = workspace();
  try {
    const { bundle } = bundleFor(root);
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const ae = w('ae.json', bundle.approvalEvidence); const av = w('av.json', bundle.approvalValidation);
    const pp = w('pp.json', bundle.preflightPlan); const pr = w('pr.json', bundle.preflightReport); const psd = w('psd.json', bundle.preflightSelfDigest);
    const outPath = join(root, 'catalog-authority-test-library', 'EXECMARKER-out', 'auth.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-execution-authorization-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--approvalevidence', ae, '--approvalvalidation', av, '--preflightplan', pp, '--preflightreport', pr, '--preflightselfdigest', psd, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'template file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', 'stdout overall');
    assertEq(parsed.templateEmitted, true, 'stdout reports templateEmitted');
    assertEq(parsed.authorization, 'NONE', 'stdout authorization NONE');
    assert(!(res.stdout ?? '').includes('EXECMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The gate must return TEMPLATE_READY for the ACTUAL prepared, redaction-safe P227-A evidence (captured
// verbatim from the non-live artifacts under evidence/phase-231). This locks the gate to the real bundle
// offline and deterministically -- no SSH, no secret approval file, no live surface.
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
  report: 'phase-230-promotion-approval-attestation', version: 1, mode: 'validate', ok: true, redactionSafe: true,
  status: 'APPROVAL_ATTESTATION_READY',
  approvalIdDigest: '8f43ff3cd966c368b277a069560978fbcd2e1f15063d420058d5b7b3e0def477',
  itemDigest: 'c23dcefc87e63e8b10fb4c7dd67aac99a0fe512318c0c07c1323e889ffac9431',
  targetRoot: '/mnt/user/media/Movies',
  sourceRealPathDigest: '08505b269e54350636ebdf6969bcffcbc61f60a27de52449cf7b6c9871d5227f',
  sourceSha256: 'f61646264e3f8806ec43742abf75ed142731c57b4346327429dd62ab55afb7cb',
  destinationPathDigest: '099ec7872ddad5654f56aeb86ab3bde7a459d0864533169a70bacab6ef14b924',
  destinationNameDigest: '7383f885db60eaf9c3b18212c12caeaa121b13a362d956c7d4572025dd2b51cd',
  extension: '.mp4', sourceSizeBytes: 1636, titleEchoed: false, sourcePathEchoed: false, destinationPathEchoed: false,
  problems: [], evidenceDigest: '4590bc443da55ad4b6354869c490015491723b533b13a49505fe9967035a8622',
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

await test('the gate is TEMPLATE_READY for the actual prepared P227-A evidence (offline fixture)', () => {
  // Re-derive the report and its self-digest from the captured plan, exactly as the prepared artifacts were
  // produced, so the fixture stays in lockstep with the producer modules.
  const preflightReport = buildLivePreflightPlan({ plan: REAL_PREFLIGHT_PLAN });
  assertEq(preflightReport.planDigest, '0ad6995be031cc0a64eaa04736b2a970bc88c075d6ed8129861693e90351e766', 'captured plan re-derives to the prepared planDigest');
  const preflightSelfDigest = verifySelfDigests([preflightReport]);
  assertEq(preflightSelfDigest.verifierDigest, '2535889a3631da5c1277a0d60c263c30ebc2fb0c770e1041302168ad4ae16122', 'captured self-digest matches');
  const a = buildExecutionAuthorization({
    approvalEvidence: REAL_APPROVAL_EVIDENCE,
    approvalValidation: REAL_APPROVAL_VALIDATION,
    preflightPlan: REAL_PREFLIGHT_PLAN,
    preflightReport,
    preflightSelfDigest,
  });
  assertEq(a.overall, 'EXECUTION_AUTHORIZATION_TEMPLATE_READY', `real bundle ready (blockers: ${a.blockers.join(',')})`);
  assertEq(a.authorization, 'NONE', 'authorization NONE');
  assert(a.template !== null, 'bound template present');
  assert(Object.values(a.template!.fields).every((v) => v === 'PENDING'), 'bound template, all PENDING');
  assert(!JSON.stringify(a).includes('/mnt/') && !JSON.stringify(a).includes('0a40074065d91a75ad41f33fc212e917'), 'redaction-safe: no path, no raw item id');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
