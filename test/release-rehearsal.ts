import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  REHEARSAL_GATE_UNREADABLE_EXIT,
  TAG_DEPENDENT_READINESS_GATE,
  interpretRehearsalGate,
  type RehearsalReportView,
} from '../src/ops/release-rehearsal-gate.js';
import { RELEASE_REPOSITORY, RELEASE_REPOSITORY_OWNER } from '../src/ops/release-coordinates.js';
import {
  REHEARSAL_EXIT_CODES,
  ReleaseRehearsalError,
  assertRehearsalReportIsRedactionSafe,
  evaluateReleaseRehearsal,
  renderRehearsalJson,
  renderRehearsalText,
  validateCiEvidence,
  type CandidateCoordinates,
  type CiEvidenceInput,
  type DocEvidence,
  type RehearsalEvidence,
  type RehearsalGate,
  type RehearsalOutcome,
} from '../src/ops/release-rehearsal.js';
import { RELEASE_IMAGE_REPOSITORY, RELEASE_IMAGE_TAG } from '../src/ops/consumer-release-bundle.js';

// Phase 252 — adversarial suite for the final first-release rehearsal and human handoff.
//
// The rehearsal only matters if it REFUSES to hand off when it should. So the anchor is a healthy candidate
// that is HANDOFF_READY, and then every gate is attacked: a readiness or integrity verifier that blocked,
// missing CI evidence, STALE evidence (a different commit), CONTRADICTORY evidence (a non-success
// conclusion), MALFORMED evidence, an assembly that was not fresh, missing docs or command paths. Each must
// drive the outcome away from HANDOFF_READY to exactly the right one — and HANDOFF_READY must never be
// mistaken for approval, nor manufactured from absent evidence.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/** Extract a single workflow job's text: from its `  <name>:` line to the next two-space job boundary. */
function jobBlockOf(workflowText: string, name: string): string | null {
  const idx = workflowText.indexOf(`\n  ${name}:`);
  if (idx < 0) return null;
  const after = workflowText.slice(idx + 1);
  const next = after.search(/\n {2}\S/);
  return next < 0 ? after : after.slice(0, next);
}

console.log('Running Phase 252 release-rehearsal adversarial suite:\n');

const AT = '2020-01-01T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const TAG = RELEASE_IMAGE_TAG;

const HEALTHY_CANDIDATE: CandidateCoordinates = {
  tag: TAG,
  imageRepository: RELEASE_IMAGE_REPOSITORY,
  imageRef: `${RELEASE_IMAGE_REPOSITORY}:${TAG}`,
  imageDigest: null,
  archiveName: `catalog-authority-operator-ui-${TAG}.tar.gz`,
  archiveSha256: 'a'.repeat(64),
  bundleVersion: TAG,
  sourceRevision: COMMIT,
  candidateCommit: COMMIT,
};

const ALL_DOCS: DocEvidence = {
  installDocumented: true, upgradeDocumented: true, rollbackDocumented: true, verifyDocumented: true,
  linuxCommand: true, macosCommand: true, windowsCommand: true,
};

function goodCi(commit = COMMIT): CiEvidenceInput {
  return {
    phase248: { ref: 'https://github.com/o/r/actions/runs/1', commit, conclusion: 'success' },
    phase249: { ref: 'https://github.com/o/r/actions/runs/2', commit, conclusion: 'success' },
  };
}

function healthyEvidence(overrides: Partial<RehearsalEvidence> = {}): RehearsalEvidence {
  return {
    candidate: HEALTHY_CANDIDATE,
    assembledInFreshDir: true,
    readinessOutcome: 'READY_FOR_HUMAN_RELEASE_DECISION',
    verificationOutcome: 'VERIFIED',
    ci: goodCi(),
    docs: ALL_DOCS,
    ...overrides,
  };
}

function evalWith(overrides: Partial<RehearsalEvidence> = {}): ReturnType<typeof evaluateReleaseRehearsal> {
  return evaluateReleaseRehearsal(healthyEvidence(overrides), { generatedAt: AT });
}

function gateOf(gates: readonly RehearsalGate[], id: string): RehearsalGate {
  const found = gates.find((g) => g.id === id);
  if (found === undefined) throw new Error(`no gate with id ${id}`);
  return found;
}

// ---------------------------------------------------------------------------------------------------------
// Baseline and the meaning of HANDOFF_READY.
// ---------------------------------------------------------------------------------------------------------

test('a healthy candidate is HANDOFF_READY with every gate passing', () => {
  const report = evalWith();
  assertEq(report.outcome, 'HANDOFF_READY', 'the outcome is HANDOFF_READY');
  assertEq(report.counts.pass, 7, 'all seven gates pass');
  assertEq(report.counts.block + report.counts.invalid + report.counts.notRun, 0, 'nothing blocks');
});

test('HANDOFF_READY is evidence, not approval, and holds no write permission', () => {
  const report = evalWith();
  assertEq(report.outcomeIsNotApproval, true, 'the report states it is not approval');
  assert(/NOT release approval/i.test(report.authorityNote), 'the authority note is explicit');
  assert(/publishes.*nothing/i.test(report.authorityNote), 'and that it publishes nothing');
  assert(report.boundaries.some((b) => /no write permission/i.test(b)), 'the boundaries state no write permission');
  assert(report.boundaries.some((b) => /never fabricates/i.test(b)), 'and that it never fabricates a passing result');
});

test('the handoff packet names exactly one remaining human action, tied to the tag', () => {
  const report = evalWith();
  assert(report.handoff.remainingHumanAction.includes(TAG), 'the remaining action names the release tag');
  assert(/single human-controlled release action/i.test(report.handoff.remainingHumanAction), 'and says it is the single one');
  assert(report.handoff.rollbackFacts.some((f) => /does NOT roll data back/i.test(f)), 'the rollback facts include the data-vs-image caveat');
  assert(report.handoff.knownLimitations.some((l) => /offline/i.test(l)), 'the known limitations state it is offline');
  assertEq(report.handoff.evidenceReferences.browserAcceptance, 'https://github.com/o/r/actions/runs/1', 'the browser CI reference is carried through for the human');
  assertEq(report.handoff.evidenceReferences.lifecycleAcceptance, 'https://github.com/o/r/actions/runs/2', 'as is the lifecycle CI reference');
});

test('a fixed human checklist and decision record template are present', () => {
  const report = evalWith();
  assert(report.humanChecklist.length >= 5, 'the checklist has the human confirmations');
  assert(report.humanChecklist.some((c) => /evidence, not approval/i.test(c)), 'including that HANDOFF_READY is not approval');
  assert(report.decisionRecordTemplate.some((l) => /APPROVE release/i.test(l)), 'the decision record has an approve/hold choice');
  assert(report.decisionRecordTemplate.some((l) => /self-digest/i.test(l)), 'and records the rehearsal self-digest');
});

// ---------------------------------------------------------------------------------------------------------
// CI evidence: required as input, never fabricated. Missing / stale / contradictory / malformed.
// ---------------------------------------------------------------------------------------------------------

test('missing browser-acceptance evidence is NOT_RUN, never a pass', () => {
  const report = evalWith({ ci: { phase248: undefined, phase249: goodCi().phase249 } });
  assertEq(gateOf(report.gates, 'browser-acceptance-evidence').status, 'NOT_RUN', 'the browser gate is NOT_RUN');
  assertEq(report.outcome, 'NOT_RUN', 'and readiness is not claimed');
});

test('missing lifecycle-acceptance evidence is NOT_RUN', () => {
  const report = evalWith({ ci: { phase248: goodCi().phase248, phase249: undefined } });
  assertEq(gateOf(report.gates, 'lifecycle-acceptance-evidence').status, 'NOT_RUN', 'the lifecycle gate is NOT_RUN');
  assertEq(report.outcome, 'NOT_RUN', 'and readiness is not claimed');
});

test('both acceptance references missing is NOT_RUN, not HANDOFF_READY', () => {
  const report = evalWith({ ci: {} });
  assertEq(report.outcome, 'NOT_RUN', 'absent evidence never becomes a handoff');
});

test('STALE evidence for a different commit is BLOCKED', () => {
  const report = evalWith({ ci: goodCi(OTHER_COMMIT) });
  assertEq(gateOf(report.gates, 'browser-acceptance-evidence').status, 'BLOCK', 'the browser gate blocks on a stale commit');
  assert(/stale/i.test(gateOf(report.gates, 'browser-acceptance-evidence').detail), 'and says the evidence is stale');
  assertEq(report.outcome, 'BLOCKED', 'the outcome is BLOCKED');
});

test('CONTRADICTORY evidence (a non-success conclusion) is BLOCKED', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const ci = { phase248: { ref: 'r', commit: COMMIT, conclusion }, phase249: goodCi().phase249 };
    const report = evalWith({ ci });
    assertEq(gateOf(report.gates, 'browser-acceptance-evidence').status, 'BLOCK', `${conclusion} blocks`);
    assertEq(report.outcome, 'BLOCKED', `${conclusion} makes the outcome BLOCKED`);
  }
});

test('MALFORMED evidence is INVALID, and INVALID outranks a mere block', () => {
  assertEq(evalWith({ ci: { phase248: 'not-an-object', phase249: goodCi().phase249 } }).outcome, 'INVALID', 'a non-object reference is INVALID');
  assertEq(evalWith({ ci: { phase248: { ref: 'r', commit: COMMIT }, phase249: goodCi().phase249 } }).outcome, 'INVALID', 'a missing conclusion is INVALID');
  assertEq(evalWith({ ci: { phase248: { ref: 'r', commit: 'nothex', conclusion: 'success' }, phase249: goodCi().phase249 } }).outcome, 'INVALID', 'a non-hex commit is INVALID');
  assertEq(evalWith({ ci: { phase248: { ref: '', commit: COMMIT, conclusion: 'success' }, phase249: goodCi().phase249 } }).outcome, 'INVALID', 'an empty ref is INVALID');
});

test('validateCiEvidence directly: the full corpus maps to the right status and never invents a pass', () => {
  const id = 'x', title = 'y';
  assertEq(validateCiEvidence(undefined, COMMIT, id, title).gate.status, 'NOT_RUN', 'absent -> NOT_RUN');
  assertEq(validateCiEvidence({ ref: 'r', commit: COMMIT, conclusion: 'success' }, COMMIT, id, title).gate.status, 'PASS', 'matching success -> PASS');
  assertEq(validateCiEvidence({ ref: 'r', commit: OTHER_COMMIT, conclusion: 'success' }, COMMIT, id, title).gate.status, 'BLOCK', 'stale -> BLOCK');
  assertEq(validateCiEvidence({ ref: 'r', commit: COMMIT, conclusion: 'failure' }, COMMIT, id, title).gate.status, 'BLOCK', 'failure -> BLOCK');
  assertEq(validateCiEvidence({ ref: 'r', commit: COMMIT, conclusion: 'success' }, null, id, title).gate.status, 'NOT_RUN', 'no candidate commit -> NOT_RUN (cannot tie)');
  assertEq(validateCiEvidence(42, COMMIT, id, title).gate.status, 'INVALID', 'a number -> INVALID');
  // A malicious conclusion string is never echoed raw into the detail.
  const weird = validateCiEvidence({ ref: 'r', commit: COMMIT, conclusion: 'x'.repeat(200) }, COMMIT, id, title);
  assert(!weird.gate.detail.includes('x'.repeat(200)), 'an oversized conclusion is not echoed into the detail');
});

test('a supplied success reference whose commit cannot be tied (no candidate commit) is NOT_RUN', () => {
  const candidate = { ...HEALTHY_CANDIDATE, candidateCommit: null };
  const report = evaluateReleaseRehearsal(healthyEvidence({ candidate }), { generatedAt: AT });
  assertEq(gateOf(report.gates, 'browser-acceptance-evidence').status, 'NOT_RUN', 'evidence cannot be tied to an unknown commit');
  assertEq(report.outcome, 'NOT_RUN', 'so readiness is not claimed');
});

// ---------------------------------------------------------------------------------------------------------
// The offline verifiers and the assembly gate.
// ---------------------------------------------------------------------------------------------------------

test('a blocked readiness proof blocks the handoff', () => {
  const report = evalWith({ readinessOutcome: 'BLOCKED' });
  assertEq(gateOf(report.gates, 'offline-readiness').status, 'BLOCK', 'the readiness gate blocks');
  assertEq(report.outcome, 'BLOCKED', 'and so does the handoff');
});

test('an unfinished readiness proof is NOT_RUN; an uninterpretable one is INVALID', () => {
  assertEq(evalWith({ readinessOutcome: 'NOT_RUN' }).outcome, 'NOT_RUN', 'NOT_RUN readiness -> NOT_RUN');
  assertEq(evalWith({ readinessOutcome: 'INVALID' }).outcome, 'INVALID', 'INVALID readiness -> INVALID');
});

test('a failed integrity verifier is INVALID; an unverifiable one is NOT_RUN', () => {
  assertEq(gateOf(evalWith({ verificationOutcome: 'INVALID' }).gates, 'offline-integrity').status, 'INVALID', 'INVALID integrity gate');
  assertEq(evalWith({ verificationOutcome: 'INVALID' }).outcome, 'INVALID', 'and INVALID outcome');
  assertEq(evalWith({ verificationOutcome: 'UNVERIFIED' }).outcome, 'NOT_RUN', 'UNVERIFIED integrity -> NOT_RUN');
});

test('an assembly that was not fresh is BLOCKED', () => {
  const report = evalWith({ assembledInFreshDir: false });
  assertEq(gateOf(report.gates, 'candidate-assembled').status, 'BLOCK', 'the assembly gate blocks');
  assertEq(report.outcome, 'BLOCKED', 'and so does the handoff');
});

test('missing install documentation or a missing command path blocks the handoff', () => {
  assertEq(evalWith({ docs: { ...ALL_DOCS, installDocumented: false } }).outcome, 'BLOCKED', 'no install docs -> BLOCKED');
  assertEq(evalWith({ docs: { ...ALL_DOCS, rollbackDocumented: false } }).outcome, 'BLOCKED', 'no rollback docs -> BLOCKED');
  const noMac = evalWith({ docs: { ...ALL_DOCS, macosCommand: false } });
  assertEq(gateOf(noMac.gates, 'command-paths').status, 'BLOCK', 'a missing macOS command blocks the command-paths gate');
  assert(/macOS/i.test(gateOf(noMac.gates, 'command-paths').detail), 'and names the missing platform');
  assertEq(noMac.outcome, 'BLOCKED', 'and the outcome is BLOCKED');
});

test('precedence: INVALID > BLOCKED > NOT_RUN > HANDOFF_READY', () => {
  // readiness blocked (BLOCK) + evidence missing (NOT_RUN) -> BLOCKED
  assertEq(evalWith({ readinessOutcome: 'BLOCKED', ci: {} }).outcome, 'BLOCKED', 'block beats not-run');
  // integrity invalid (INVALID) + readiness blocked (BLOCK) -> INVALID
  assertEq(evalWith({ verificationOutcome: 'INVALID', readinessOutcome: 'BLOCKED' }).outcome, 'INVALID', 'invalid beats block');
});

// ---------------------------------------------------------------------------------------------------------
// Self-digest and redaction.
// ---------------------------------------------------------------------------------------------------------

test('the self-digest is deterministic, wall-clock independent, and sensitive to a verdict change', () => {
  const a = evaluateReleaseRehearsal(healthyEvidence(), { generatedAt: AT });
  const b = evaluateReleaseRehearsal(healthyEvidence(), { generatedAt: '2099-01-01T00:00:00.000Z' });
  assertEq(a.selfDigest, b.selfDigest, 'the same evidence yields the same digest regardless of the clock');
  const changed = evaluateReleaseRehearsal(healthyEvidence({ assembledInFreshDir: false }), { generatedAt: AT });
  assert(changed.selfDigest !== a.selfDigest, 'changing a gate verdict changes the digest');
});

test('the healthy report renders redaction-safe as JSON and text', () => {
  renderRehearsalJson(evalWith());
  renderRehearsalText(evalWith());
});

test('the redaction backstop refuses leaked data anywhere in the report', () => {
  const leaks = ['-----BEGIN RSA PRIVATE KEY-----', 'ghp_0123456789abcdefghijZZ', 'postgres://u:hunter2xy@h/db', '/home/clint/x', 'C:\\Users\\clint\\x', '/mnt/user/media/Movies'];
  for (const leak of leaks) {
    let threw = false;
    try { assertRehearsalReportIsRedactionSafe(`text ${leak} text`); } catch (err) { threw = err instanceof ReleaseRehearsalError; }
    assert(threw, `the backstop refuses ${leak}`);
  }
  // A candidate carrying a host path in its revision refuses to render rather than leaking it.
  const poisoned = evaluateReleaseRehearsal(healthyEvidence({ candidate: { ...HEALTHY_CANDIDATE, sourceRevision: '/home/clint/secret' } }), { generatedAt: AT });
  let threw = false;
  try { renderRehearsalJson(poisoned); } catch (err) { threw = err instanceof ReleaseRehearsalError; }
  assert(threw, 'a poisoned candidate is not printed');
});

// ---------------------------------------------------------------------------------------------------------
// Fixed exit codes and the CLI against the real checkout.
// ---------------------------------------------------------------------------------------------------------

test('the outcome exit codes are fixed and distinct', () => {
  assertEq(REHEARSAL_EXIT_CODES.HANDOFF_READY, 0, 'HANDOFF_READY is 0');
  assertEq(REHEARSAL_EXIT_CODES.BLOCKED, 30, 'BLOCKED is 30');
  assertEq(REHEARSAL_EXIT_CODES.INVALID, 31, 'INVALID is 31');
  assertEq(REHEARSAL_EXIT_CODES.NOT_RUN, 32, 'NOT_RUN is 32');
});

test('the CLI runs against the real checkout, exits with a fixed code, and never leaks a secret', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/ops/release-rehearsal-cli.ts'), '--generated-at', AT],
    { cwd: root, encoding: 'utf8', timeout: 300000 });
  const outcomes: readonly RehearsalOutcome[] = ['HANDOFF_READY', 'BLOCKED', 'INVALID', 'NOT_RUN'];
  const stdout = String(run.stdout ?? '');
  assert(outcomes.includes(JSON.parse(stdout || '{}').outcome), 'it prints a bounded outcome');
  assert([0, 30, 31, 32].includes(run.status ?? -1), `it exits with a fixed rehearsal code, got ${String(run.status)}`);
  assert(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(stdout), 'no private key in the output');
});

test('the CLI validates supplied evidence: a stale commit blocks the browser gate, a matching one passes lifecycle', () => {
  const run = spawnSync(process.execPath, [
    '--import', 'tsx', join(root, 'src/ops/release-rehearsal-cli.ts'),
    '--generated-at', AT, '--candidate-commit', COMMIT, '--revision', COMMIT,
  ], {
    cwd: root, encoding: 'utf8', timeout: 300000,
    env: {
      ...process.env,
      PHASE248_REF: 'https://github.com/o/r/actions/runs/1', PHASE248_COMMIT: OTHER_COMMIT, PHASE248_CONCLUSION: 'success',
      PHASE249_REF: 'https://github.com/o/r/actions/runs/2', PHASE249_COMMIT: COMMIT, PHASE249_CONCLUSION: 'success',
    },
  });
  const report = JSON.parse(String(run.stdout ?? '{}')) as { gates: RehearsalGate[] };
  assertEq(gateOf(report.gates, 'browser-acceptance-evidence').status, 'BLOCK', 'the CLI blocks the stale browser evidence');
  assertEq(gateOf(report.gates, 'lifecycle-acceptance-evidence').status, 'PASS', 'and passes the matching lifecycle evidence');
});

// ---------------------------------------------------------------------------------------------------------
// Docs, package wiring, and CI wiring (read-only, no write permission).
// ---------------------------------------------------------------------------------------------------------

test('the Phase 252 doc and package scripts are present and consistent', () => {
  assert(existsSync(join(root, 'docs/PHASE_252_RELEASE_REHEARSAL.md')), 'the Phase 252 doc exists');
  const doc = read('docs/PHASE_252_RELEASE_REHEARSAL.md');
  for (const required of ['Phase 252', 'ops:release-rehearsal', 'HANDOFF_READY', 'BLOCKED', 'INVALID', 'NOT_RUN', 'not approval', 'rollback', 'checklist', 'Phase 248', 'Phase 249']) {
    assert(doc.includes(required), `the doc mentions ${required}`);
  }
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:release-rehearsal'], 'tsx src/ops/release-rehearsal-cli.ts', 'the ops script is wired');
  assertEq(pkg.scripts['test:release-rehearsal'], 'tsx test/release-rehearsal.ts', 'the test script is wired');
  assertEq(pkg.scripts['test:phase252-local'], 'tsx test/release-rehearsal.ts', 'the phase252-local alias is wired');
});

test('CI runs the rehearsal suite and wires a read-only rehearsal job with no write permission', () => {
  const wf = read('.github/workflows/runtime-image.yml');
  assert(wf.includes('test:phase252-local'), 'CI runs test:phase252-local in the suites gate');
  assert(wf.includes('ops:release-rehearsal'), 'CI runs the rehearsal as a job');
  // The rehearsal job must not grant write. Extract its block and confirm no write permission appears in it.
  const jobBlock = jobBlockOf(wf, 'rehearsal');
  assert(jobBlock !== null, 'a rehearsal job exists');
  assert(!/write/.test(jobBlock!), 'the rehearsal job grants no write permission');
  assert(!/docker\/login-action|build-push-action|gh release upload/.test(jobBlock!), 'and it never logs in, pushes, or uploads');
  // It has no `if:`, so it can never be conditionally skipped and thereby let publish through.
  assert(!/\n {4}if:/.test(jobBlock!), 'the rehearsal job carries no if: that could skip it');
  // Its permissions are inherited (no `permissions:` key of its own).
  assert(!/\n {4}permissions:/.test(jobBlock!), 'the rehearsal job declares no permissions, inheriting read-only');
});

test('the rehearsal binds the Phase 248/249 acceptances to this release commit, honestly', () => {
  const jobBlock = jobBlockOf(read('.github/workflows/runtime-image.yml'), 'rehearsal');
  assert(jobBlock !== null, 'a rehearsal job exists');
  // The candidate commit and both acceptance commits are github.sha — the acceptance evidence is tied to the
  // exact commit being released, so a stale run cannot satisfy it.
  assert(jobBlock!.includes('CANDIDATE_COMMIT: ${{ github.sha }}'), 'the candidate commit is github.sha');
  assert(jobBlock!.includes('PHASE248_COMMIT: ${{ github.sha }}'), 'the Phase 248 evidence commit is github.sha');
  assert(jobBlock!.includes('PHASE249_COMMIT: ${{ github.sha }}'), 'the Phase 249 evidence commit is github.sha');
  // The conclusions come from the gated job results — honest, not fabricated.
  assert(jobBlock!.includes('PHASE248_CONCLUSION: ${{ needs.release-candidate.result }}'), 'Phase 248 success comes from the release-candidate job result');
  assert(jobBlock!.includes('PHASE249_CONCLUSION: ${{ needs.lifecycle.result }}'), 'Phase 249 success comes from the lifecycle job result');
});

test('publish REQUIRES the rehearsal gate — this fails against the pre-fix graph', () => {
  const wf = read('.github/workflows/runtime-image.yml');
  const publishBlock = jobBlockOf(wf, 'publish');
  assert(publishBlock !== null, 'a publish job exists');
  const needsLine = publishBlock!.split('\n').find((l) => l.trim().startsWith('needs:'));
  assert(needsLine !== undefined, 'the publish job declares a needs list');
  // The exact defect this remediation closed: without rehearsal in publish.needs, publish could run and
  // succeed while the final rehearsal blocked. The pre-fix list omitted rehearsal, so this assertion fails there.
  assert(/\brehearsal\b/.test(needsLine!), 'publish depends on the rehearsal gate');
  for (const gate of ['suites', 'image', 'bundle', 'release-candidate', 'lifecycle', 'rehearsal']) {
    assert(new RegExp(`\\b${gate}\\b`).test(needsLine!), `publish still depends on ${gate}`);
  }
  // No cycle: the rehearsal job must NOT depend on publish.
  const rehearsalBlock = jobBlockOf(wf, 'rehearsal');
  const rehearsalNeeds = rehearsalBlock!.split('\n').find((l) => l.trim().startsWith('needs:')) ?? '';
  assert(!/\bpublish\b/.test(rehearsalNeeds), 'the rehearsal does not depend on publish — no circular dependency');
});

// ---------------------------------------------------------------------------------------------------------
// The event-aware CI gate. On a PR the release tag intentionally does not exist, so the rehearsal is honestly
// NOT_RUN — and that must PASS CI without ever being faked into HANDOFF_READY. On an event that would actually
// publish, only HANDOFF_READY passes. The SAME NOT_RUN that passes on a PR must FAIL on a publish-reaching run.
// ---------------------------------------------------------------------------------------------------------

function reportView(
  outcome: RehearsalReportView['outcome'],
  gates: ReadonlyArray<{ id: string; status: RehearsalGate['status'] }>,
  candidateCommit: string | null = COMMIT,
): RehearsalReportView {
  return { outcome, gates, candidate: { candidateCommit } };
}
const g = (id: string, status: RehearsalGate['status']): { id: string; status: RehearsalGate['status'] } => ({ id, status });

// The exact composition ops:release-rehearsal produces on a clean CI PR checkout: every gate passes except the
// Phase 250 readiness gate, which is NOT_RUN solely because the release tag is not present locally.
const NOTRUN_ABSENT_TAG = reportView('NOT_RUN', [
  g('candidate-assembled', 'PASS'), g(TAG_DEPENDENT_READINESS_GATE, 'NOT_RUN'), g('offline-integrity', 'PASS'),
  g('browser-acceptance-evidence', 'PASS'), g('lifecycle-acceptance-evidence', 'PASS'),
  g('install-documentation', 'PASS'), g('command-paths', 'PASS'),
]);
const READY_REPORT = reportView('HANDOFF_READY', [g(TAG_DEPENDENT_READINESS_GATE, 'PASS'), g('browser-acceptance-evidence', 'PASS')]);
const NOTRUN_NO_GIT = reportView('NOT_RUN', [g(TAG_DEPENDENT_READINESS_GATE, 'NOT_RUN')], null);
const NOTRUN_MISSING_CI = reportView('NOT_RUN', [g(TAG_DEPENDENT_READINESS_GATE, 'PASS'), g('browser-acceptance-evidence', 'NOT_RUN')]);
const NOTRUN_TAG_AND_CI = reportView('NOT_RUN', [g(TAG_DEPENDENT_READINESS_GATE, 'NOT_RUN'), g('browser-acceptance-evidence', 'NOT_RUN')]);
const BLOCKED_REPORT = reportView('BLOCKED', [g(TAG_DEPENDENT_READINESS_GATE, 'BLOCK')]);
const INVALID_REPORT = reportView('INVALID', [g('offline-integrity', 'INVALID')]);

test('on a non-publishing validation event, NOT_RUN passes ONLY when it is solely the absent release tag', () => {
  const v = { publishReaching: false };
  assert(interpretRehearsalGate(READY_REPORT, v).pass, 'HANDOFF_READY passes');
  assert(interpretRehearsalGate(NOTRUN_ABSENT_TAG, v).pass, 'NOT_RUN from the absent tag alone passes on a PR');
  assertEq(interpretRehearsalGate(NOTRUN_ABSENT_TAG, v).code, 0, 'and its code is 0');
  // Every other NOT_RUN shape, and every real problem, still fails — a skip is never silently a pass.
  assert(!interpretRehearsalGate(NOTRUN_NO_GIT, v).pass, 'NOT_RUN with no Git (no candidate commit) fails');
  assert(!interpretRehearsalGate(NOTRUN_MISSING_CI, v).pass, 'NOT_RUN from missing CI acceptance evidence fails');
  assert(!interpretRehearsalGate(NOTRUN_TAG_AND_CI, v).pass, 'NOT_RUN from the tag AND missing evidence fails');
  assert(!interpretRehearsalGate(BLOCKED_REPORT, v).pass, 'BLOCKED always fails');
  assert(!interpretRehearsalGate(INVALID_REPORT, v).pass, 'INVALID always fails');
});

test('on a publish-reaching event, ONLY HANDOFF_READY passes — the same PR-passing NOT_RUN now fails', () => {
  const p = { publishReaching: true };
  assert(interpretRehearsalGate(READY_REPORT, p).pass, 'HANDOFF_READY passes and may reach publish');
  // The adversarial crux: the exact NOT_RUN report that PASSES on a PR must FAIL when the event would publish.
  const notRun = interpretRehearsalGate(NOTRUN_ABSENT_TAG, p);
  assert(!notRun.pass, 'the absent-tag NOT_RUN does NOT pass a publish-reaching event');
  assertEq(notRun.code, 32, 'and it exits with the NOT_RUN code, so publish is prevented');
  assert(!interpretRehearsalGate(NOTRUN_MISSING_CI, p).pass, 'a missing-evidence NOT_RUN fails');
  assert(!interpretRehearsalGate(BLOCKED_REPORT, p).pass, 'BLOCKED fails and prevents publish');
  assertEq(interpretRehearsalGate(BLOCKED_REPORT, p).code, 30, 'with the BLOCKED code');
  assert(!interpretRehearsalGate(INVALID_REPORT, p).pass, 'INVALID fails and prevents publish');
  assertEq(interpretRehearsalGate(INVALID_REPORT, p).code, 31, 'with the INVALID code');
});

test('the gate CLI reads the packet and the event context, and agrees with the pure decision', () => {
  const clear = {
    GITHUB_EVENT_NAME: '', GITHUB_REF: '', RELEASE_TAG_NAME: '', RELEASE_DRAFT: '',
    RELEASE_PUBLISH_INPUT: '', GITHUB_REPOSITORY: '', GITHUB_REPOSITORY_OWNER: '',
  };
  const pr = { ...clear, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/20/merge' };
  const release = {
    ...clear, GITHUB_EVENT_NAME: 'release', RELEASE_TAG_NAME: RELEASE_IMAGE_TAG,
    GITHUB_REF: `refs/tags/${RELEASE_IMAGE_TAG}`, GITHUB_REPOSITORY: RELEASE_REPOSITORY, GITHUB_REPOSITORY_OWNER: RELEASE_REPOSITORY_OWNER,
  };
  const dispatch = {
    ...clear, GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_PUBLISH_INPUT: 'true',
    GITHUB_REF: `refs/tags/${RELEASE_IMAGE_TAG}`, GITHUB_REPOSITORY: RELEASE_REPOSITORY, GITHUB_REPOSITORY_OWNER: RELEASE_REPOSITORY_OWNER,
  };

  const ws = mkdtempSync(join(tmpdir(), 'phase252-gate-'));
  const runGate = (view: RehearsalReportView | null, env: Record<string, string>, name: string): { status: number | null; out: string } => {
    const reportPath = view === null ? join(ws, 'absent.json') : (writeFileSync(join(ws, name), JSON.stringify(view)), join(ws, name));
    const run = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/ops/release-rehearsal-gate-cli.ts'), '--report', reportPath],
      { cwd: root, encoding: 'utf8', timeout: 300000, env: { ...process.env, ...env } });
    return { status: run.status ?? -1, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
  };
  try {
    // A PR: the absent-tag NOT_RUN passes; a real problem does not.
    assertEq(runGate(NOTRUN_ABSENT_TAG, pr, 'notrun.json').status, 0, 'PR + absent-tag NOT_RUN exits 0');
    assertEq(runGate(BLOCKED_REPORT, pr, 'blocked.json').status, 30, 'PR + BLOCKED fails');
    assertEq(runGate(NOTRUN_MISSING_CI, pr, 'missingci.json').status, 32, 'PR + missing-evidence NOT_RUN fails');

    // A release or a deliberate version-tag dispatch: the SAME NOT_RUN report now fails; only READY passes.
    assertEq(runGate(NOTRUN_ABSENT_TAG, release, 'notrun.json').status, 32, 'release + absent-tag NOT_RUN fails (prevents publish)');
    assertEq(runGate(NOTRUN_ABSENT_TAG, dispatch, 'notrun.json').status, 32, 'version-tag dispatch + NOT_RUN fails');
    assertEq(runGate(READY_REPORT, release, 'ready.json').status, 0, 'release + HANDOFF_READY passes');

    // Fail closed: a missing or unreadable packet is never a pass, on any event.
    assertEq(runGate(null, pr, 'absent').status, REHEARSAL_GATE_UNREADABLE_EXIT, 'a missing packet fails closed on a PR');
    assertEq(runGate(null, release, 'absent').status, REHEARSAL_GATE_UNREADABLE_EXIT, 'a missing packet fails closed on a release');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('the CI rehearsal job runs unconditionally, always uploads the packet, and gates by event', () => {
  const wf = read('.github/workflows/runtime-image.yml');
  const jobBlock = jobBlockOf(wf, 'rehearsal');
  assert(jobBlock !== null, 'a rehearsal job exists');
  // The rehearsal itself never fails the job on its own outcome code; the gate step decides.
  assert(/ops:release-rehearsal .*\|\| true/.test(jobBlock!), 'the rehearsal step does not fail the job on its outcome code');
  // The handoff packet is uploaded on every outcome.
  assert(/\n {8}if: always\(\)/.test(jobBlock!), 'the handoff upload runs on if: always(), so every outcome keeps its packet');
  // The event-aware gate runs as a STEP (not a job if:), so the job still runs unconditionally on every event.
  assert(jobBlock!.includes('ops:release-rehearsal-gate'), 'the event-aware gate step runs');
  assert(!/\n {4}if:/.test(jobBlock!), 'the rehearsal job carries no job-level if: — it can never be skipped');
  // The gate is given the same event context the publish release-ref gate reads, so the two cannot disagree.
  for (const envVar of ['GITHUB_EVENT_NAME', 'RELEASE_TAG_NAME', 'RELEASE_PUBLISH_INPUT', 'GITHUB_REPOSITORY']) {
    assert(jobBlock!.includes(envVar), `the gate step is given ${envVar}`);
  }
  // Still no write permission and no publish capability in the rehearsal job.
  assert(!/write/.test(jobBlock!), 'the rehearsal job still grants no write permission');
  assert(!/docker\/login-action|build-push-action|gh release upload|docker push/.test(jobBlock!), 'and still cannot publish');

  // The gate CLI is wired as an ops script, and publish is unchanged: it still requires the rehearsal gate and
  // is still gated to a release or a deliberate dispatch, so it can never run on a pull request.
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:release-rehearsal-gate'], 'tsx src/ops/release-rehearsal-gate-cli.ts', 'the gate ops script is wired');
  const publishBlock = jobBlockOf(wf, 'publish');
  assert(publishBlock !== null, 'a publish job exists');
  assert(/needs:.*\brehearsal\b/.test(publishBlock!.split('\n').find((l) => l.trim().startsWith('needs:')) ?? ''),
    'publish still depends on the rehearsal gate');
  const publishIf = publishBlock!.split('\n').find((l) => l.trim().startsWith('if:')) ?? '';
  assert(!/pull_request/.test(publishIf), 'publish never runs on a pull request');
  assert(/event_name == 'release'/.test(publishIf) && /workflow_dispatch/.test(publishIf), 'publish runs only on a release or a deliberate dispatch');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
