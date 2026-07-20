import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNoLiveAuthorizationGuard } from '../src/ops/promotion-no-live-authorization-guard.js';
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
const clean = (report: string, overall: string) => ({ report, version: 1, redactionSafe: true, authorization: 'NONE', status: 'PENDING', overall });

console.log('Running Phase 230 no-live-authorization guard suite:\n');

test('NO_LIVE_AUTHORIZATION_CLEAN for artifacts that claim no live authorization', () => {
  const r = buildNoLiveAuthorizationGuard({ artifacts: [clean('phase-230-promotion-closure-summary-v3', 'CLOSURE_SUMMARY_READY'), clean('phase-230-promotion-review-authorization', 'LOCAL_REVIEW_AUTHORIZED')] });
  assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_CLEAN', `clean (blockers: ${r.blockers.join(',')})`);
  assertEq(r.authorization, 'NONE', 'authorizes nothing');
  assert(r.verdicts.every((v) => !v.claimsLiveAuthorization), 'no live-authorization claims');
  assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'self-verifies');
});

test('VIOLATED on any artifact claiming APPROVED / EXECUTE / LIVE_READY / PHASE_231_AUTHORIZED', () => {
  const cases: unknown[] = [
    { report: 'x', authorization: 'APPROVED' },
    { report: 'x', status: 'EXECUTE' },
    { report: 'x', overall: 'LIVE_READY' },
    { report: 'x', authorization: 'NONE', phase231Authorized: true },
    { report: 'x', authorization: 'NONE', gates: ['PHASE_231_AUTHORIZED'] },
    { report: 'x', approved: true },
  ];
  for (const c of cases) {
    const r = buildNoLiveAuthorizationGuard({ artifacts: [c] });
    assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_VIOLATED', `violated for ${JSON.stringify(c).slice(0, 40)}`);
    assert(r.blockers.includes('LIVE_AUTHORIZATION_CLAIMED'), 'LIVE_AUTHORIZATION_CLAIMED');
    assert(!JSON.stringify(r).includes('APPROVED') && !JSON.stringify(r).includes('LIVE_READY') && !JSON.stringify(r).includes('PHASE_231_AUTHORIZED'), 'offending value never echoed');
  }
});

test('a PENDING human gate doc may LIST the tokens as pending steps (exempt)', () => {
  const gateDoc = { report: 'phase-230-promotion-human-gate', authorization: 'NONE', status: 'PENDING', humanGate: true, pendingGates: ['PHASE_231_AUTHORIZED', 'APPROVED'] };
  const r = buildNoLiveAuthorizationGuard({ artifacts: [gateDoc] });
  assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_CLEAN', 'pending gate doc is exempt');
  assert(r.verdicts[0]!.pendingGateExempt && !r.verdicts[0]!.claimsLiveAuthorization, 'exempt, not a claim');
  // but a gate doc that actually claims APPROVED authorization is NOT exempt
  const fakeGate = { report: 'x', authorization: 'APPROVED', status: 'PENDING', humanGate: true };
  assertEq(buildNoLiveAuthorizationGuard({ artifacts: [fakeGate] }).overall, 'NO_LIVE_AUTHORIZATION_VIOLATED', 'authorization claim not exempt');
});

test('a PENDING human gate can NEVER smuggle a hard claim flag or forbidden claim-field value', () => {
  // Every one of these is a valid-looking PENDING human gate (humanGate:true, status/authorization ok) that
  // ALSO carries an actual live-authorization claim. The gate exemption must be refused for all of them.
  const base = { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE' } as const;
  const smugglers: Array<Record<string, unknown>> = [
    { ...base, approved: true },
    { ...base, execute: true },
    { ...base, liveReady: true },
    { ...base, phase231Authorized: true },
    { ...base, liveAuthorized: true },
    // forbidden token as a claim-field VALUE (status/overall) while still passing the gate's PENDING check on
    // the other fields -- overall is not part of the gate predicate, so it must fail closed on its own.
    { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE', overall: 'LIVE_READY' },
    { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'PENDING', overall: 'PHASE_231_AUTHORIZED' },
  ];
  for (const c of smugglers) {
    const r = buildNoLiveAuthorizationGuard({ artifacts: [c] });
    assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_VIOLATED', `gate cannot smuggle ${JSON.stringify(c).slice(0, 60)}`);
    assert(r.blockers.includes('LIVE_AUTHORIZATION_CLAIMED'), 'LIVE_AUTHORIZATION_CLAIMED');
    assert(r.verdicts[0]!.hardClaim === true, 'flagged as a hard claim');
    assert(!r.verdicts[0]!.pendingGateExempt, 'gate exemption refused');
    assert(!JSON.stringify(r).includes('LIVE_READY') && !JSON.stringify(r).includes('PHASE_231_AUTHORIZED'), 'offending value never echoed');
  }
});

test('a PENDING human gate can NEVER smuggle a NESTED hard claim (flag or forbidden claim-field value)', () => {
  // Same smuggle attempt as above, but the claim is buried inside a sub-object/array so a top-level-only check
  // would miss it. All must fail closed as hard claims.
  const base = { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE' } as const;
  const smugglers: Array<Record<string, unknown>> = [
    { ...base, gate: { approved: true } },
    { ...base, decision: { detail: { execute: true } } },
    { ...base, steps: [{ note: 'x' }, { phase231Authorized: true }] },
    { ...base, meta: { liveAuthorized: true } },
    { ...base, decision: { status: 'LIVE_READY' } },
    { ...base, gate: { result: { overall: 'PHASE_231_AUTHORIZED' } } },
    { ...base, rows: [{ status: 'PHASE_231_AUTHORIZED' }] },
  ];
  for (const c of smugglers) {
    const r = buildNoLiveAuthorizationGuard({ artifacts: [c] });
    assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_VIOLATED', `gate cannot smuggle nested ${JSON.stringify(c).slice(0, 60)}`);
    assert(r.blockers.includes('LIVE_AUTHORIZATION_CLAIMED'), 'LIVE_AUTHORIZATION_CLAIMED');
    assert(r.verdicts[0]!.hardClaim === true, 'flagged as a hard claim');
    assert(!r.verdicts[0]!.pendingGateExempt, 'gate exemption refused');
    assert(!JSON.stringify(r).includes('LIVE_READY') && !JSON.stringify(r).includes('PHASE_231_AUTHORIZED'), 'offending value never echoed');
  }
});

test('VIOLATED on case / separator / affix VARIANTS of the forbidden tokens (claim fields + flags)', () => {
  // Adversarial variant corpus: each is a hard claim carried in a claim FIELD as a token variant.
  const variants: unknown[] = [
    { report: 'x', status: 'approved_for_live' },
    { report: 'x', overall: 'APPROVED_FOR_LIVE' },
    { report: 'x', authorization: 'phase_231_authorized' },
    { report: 'x', status: 'phase-231-authorized' },
    { report: 'x', overall: 'live_ready' },
    { report: 'x', status: 'live-ready' },
    { report: 'x', overall: 'Live Ready' },
    { report: 'x', overall: 'LiveReady' },
    { report: 'x', status: 'LIVEREADY' },
    { report: 'x', authorization: 'phase231Authorized' },
    { report: 'x', status: 'granted' },
    { report: 'x', overall: 'Execute' },
    { report: 'x', overall: 'EXECUTE' },
    // nested variant claim-field value, inside a would-be pending gate -> still a hard claim
    { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE', gate: { overall: 'phase-231-authorized' } },
  ];
  for (const c of variants) {
    const r = buildNoLiveAuthorizationGuard({ artifacts: [c] });
    assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_VIOLATED', `variant flagged: ${JSON.stringify(c).slice(0, 60)}`);
    assert(r.verdicts[0]!.hardClaim === true, 'hard claim');
    assert(!/live[_ -]?ready|phase[_ -]?231|approved|granted|execute/i.test(JSON.stringify(r.verdicts)) , 'offending value never echoed');
  }
});

test('variant tokens listed as PENDING steps are exempt inside a human gate, but not elsewhere', () => {
  const gateDoc = { report: 'phase-230-promotion-human-gate', authorization: 'NONE', status: 'PENDING', humanGate: true, pendingGates: ['phase-231-authorized', 'approved_for_live', 'live-ready'] };
  assertEq(buildNoLiveAuthorizationGuard({ artifacts: [gateDoc] }).overall, 'NO_LIVE_AUTHORIZATION_CLEAN', 'variant tokens may be LISTED as pending steps in a gate');
  const notAGate = { report: 'x', pendingGates: ['phase-231-authorized'] };
  assertEq(buildNoLiveAuthorizationGuard({ artifacts: [notAGate] }).overall, 'NO_LIVE_AUTHORIZATION_VIOLATED', 'same list outside a gate fails closed');
});

test('VIOLATED on a forbidden token as the scalar value of a NON-canonical field, even inside a gate', () => {
  // A token that is the whole value of ANY field (not just authorization/status/overall) is a structural hard
  // claim -- it must not fall through to the exemptable textual path just because the field name is arbitrary.
  const scalar: unknown[] = [
    { report: 'x', decision: 'APPROVED' },
    { report: 'x', result: 'PHASE_231_AUTHORIZED' },
    { report: 'x', verdict: 'live_ready' },
    { report: 'x', state: 'phase-231-authorized' },
    { report: 'x', liveDecision: 'APPROVED_FOR_LIVE' },
    { report: 'x', nested: { outcome: 'GRANTED' } },
    // the core repro: valid-looking PENDING human gate carrying a scalar token in a non-canonical field
    { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE', decision: 'APPROVED' },
    { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE', gate: { result: 'phase-231-authorized' } },
  ];
  for (const c of scalar) {
    const r = buildNoLiveAuthorizationGuard({ artifacts: [c] });
    assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_VIOLATED', `scalar-field token flagged: ${JSON.stringify(c).slice(0, 60)}`);
    assert(r.verdicts[0]!.hardClaim === true, 'hard claim');
    assert(!r.verdicts[0]!.pendingGateExempt, 'gate exemption refused');
  }
  // ...but the SAME tokens listed as ARRAY ELEMENTS remain exemptable pending-step listings inside a gate.
  const listing = { report: 'phase-230-promotion-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE', pendingGates: ['APPROVED', 'PHASE_231_AUTHORIZED', 'live_ready'] };
  assertEq(buildNoLiveAuthorizationGuard({ artifacts: [listing] }).overall, 'NO_LIVE_AUTHORIZATION_CLEAN', 'array-element listing stays exempt in a gate');
});

test('VIOLATED on a claim-field token WRAPPED in an array/object (not a bare string), even inside a gate', () => {
  // A claim field (authorization/status/overall) whose value is an array/object embedding a forbidden token is
  // a HARD claim -- it must not fall through to the exemptable textual path.
  const wrapped: unknown[] = [
    { report: 'x', overall: ['LIVE_READY'] },
    { report: 'x', status: ['x', 'PHASE_231_AUTHORIZED'] },
    { report: 'x', overall: { value: 'phase-231-authorized' } },
    { report: 'x', authorization: { decided: 'APPROVED' } },
    { report: 'x', overall: [{ token: 'live_ready' }] },
    // the core repro: a valid-looking PENDING human gate with an array/object-wrapped claim-field token
    { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE', overall: ['LIVE_READY'] },
    { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE', overall: { result: 'PHASE_231_AUTHORIZED' } },
  ];
  for (const c of wrapped) {
    const r = buildNoLiveAuthorizationGuard({ artifacts: [c] });
    assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_VIOLATED', `wrapped claim-field flagged: ${JSON.stringify(c).slice(0, 60)}`);
    assert(r.verdicts[0]!.hardClaim === true, 'hard claim');
    assert(!r.verdicts[0]!.pendingGateExempt, 'gate exemption refused');
  }
});

test('VIOLATED on a forbidden token smuggled as an OBJECT KEY with a truthy value', () => {
  // The claim is carried as a KEY name (variant/camelCase/separator) rather than a value. All are hard claims.
  const keyed: unknown[] = [
    { report: 'x', live_ready: true },
    { report: 'x', 'live-ready': 1 },
    { report: 'x', LiveReady: true },
    { report: 'x', approved_for_live: { detail: 'x' } },
    { report: 'x', approvedForLive: 'yes' },
    { report: 'x', phase231Authorized: true },
    { report: 'x', 'phase-231-authorized': 1 },
    { report: 'x', GRANTED: true },
    // nested inside a would-be PENDING human gate -> still a hard claim, NOT exempt
    { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE', meta: { live_ready: true } },
    { report: 'phase-230-promotion-fake-human-gate', humanGate: true, status: 'PENDING', authorization: 'NONE', gates: [{ approved_for_live: 1 }] },
  ];
  for (const c of keyed) {
    const r = buildNoLiveAuthorizationGuard({ artifacts: [c] });
    assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_VIOLATED', `keyed claim flagged: ${JSON.stringify(c).slice(0, 60)}`);
    assert(r.verdicts[0]!.hardClaim === true, 'hard claim');
    assert(!r.verdicts[0]!.pendingGateExempt, 'gate exemption refused');
  }
  // ...but a forbidden-token key explicitly set to a FALSY value is NOT a claim (e.g. "approved: false").
  assertEq(buildNoLiveAuthorizationGuard({ artifacts: [{ report: 'x', authorization: 'NONE', approved: false, live_ready: 0 }] }).overall, 'NO_LIVE_AUTHORIZATION_CLEAN', 'falsy token key is not a claim');
});

test('no FALSE POSITIVES on local review terms or negative prose', () => {
  const benign: unknown[] = [
    { report: 'phase-230-promotion-review-authorization', authorization: 'NONE', status: 'PENDING', overall: 'LOCAL_REVIEW_AUTHORIZED' },
    { report: 'x', authorization: 'NONE', note: 'Phase 231 authorization is NOT granted' },
    { report: 'x', authorization: 'NONE', note: 'Live promotion has not been approved; approval is pending human review.' },
    { report: 'x', authorization: 'NONE', overall: 'CLOSURE_SUMMARY_READY', detail: 'readiness verified locally' },
    { report: 'x', authorization: 'NONE', note: 'authorization and authorized are not tokens on their own' },
    // benign object KEYS that must NOT be flagged, even though truthy
    { report: 'phase-230-promotion-review-authorization', authorization: 'NONE', reviewAuthorization: { ok: true }, localReviewAuthorized: true },
    { report: 'x', authorization: 'NONE', readinessVerified: true, unapproved: true, approvalPending: true },
  ];
  for (const b of benign) {
    const r = buildNoLiveAuthorizationGuard({ artifacts: [b] });
    assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_CLEAN', `benign not flagged: ${JSON.stringify(b).slice(0, 60)}`);
    assert(!r.verdicts[0]!.hardClaim && !r.verdicts[0]!.claimsLiveAuthorization, 'no claim');
  }
});

test('VIOLATED (fail closed) on no artifacts, redaction-safe', () => {
  const r = buildNoLiveAuthorizationGuard({ artifacts: [] });
  assertEq(r.overall, 'NO_LIVE_AUTHORIZATION_VIOLATED', 'no artifacts fails closed');
  assert(r.blockers.includes('NO_ARTIFACTS'), 'NO_ARTIFACTS');
  assert(r.redactionSafe === true && !JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

await test('CLI runs the guard and never echoes raw paths to stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-nolive-'));
  try {
    const bundlePath = join(root, 'artifacts.json'); writeFileSync(bundlePath, JSON.stringify([clean('phase-230-promotion-closure-summary-v3', 'CLOSURE_SUMMARY_READY')]));
    const outPath = join(root, 'catalog-authority-test-library', 'NLMARKER-out', 'guard.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-no-live-authorization-guard-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--artifacts', bundlePath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CLEAN exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'guard report written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'NO_LIVE_AUTHORIZATION_CLEAN', 'stdout overall');
    assert(!(res.stdout ?? '').includes('NLMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
