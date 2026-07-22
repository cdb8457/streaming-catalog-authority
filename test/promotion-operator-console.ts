import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorConsole,
  CONSOLE_ARTIFACT_FILENAMES,
  CONSOLE_BOUNDARY,
  CONSOLE_DISCLAIMERS,
  CONSOLE_PHASES,
  type ArtifactStatus,
  type OperatorConsoleReport,
} from '../src/ops/promotion-operator-console.js';
import { AUDIT_PHASE_REPORT_IDS } from '../src/ops/promotion-audit-closure-packet.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';
import {
  buildRealP227AChain,
  buildSyntheticChain,
  MINIMAL_MP4_FIXTURE,
  PARTICIPANT_DIGESTS,
  PARTICIPANT_TIMESTAMPS,
  REAL_APPROVAL_ID,
  REAL_ITEM_ID,
  reseal,
  type Rec,
  type Reports,
} from './helpers/promotion-chain-kit.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`); }

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../src/ops/promotion-operator-console-cli.ts', import.meta.url));
const SYNTHETIC_APPROVAL_ID = 'chain-kit-synthetic';
const SYNTHETIC_ITEM_ID = '0a40074065d91a75ad41f33fc212e917';

// A directory name carrying a marker no output may ever contain: the console never echoes where it read from.
function workspace(): string { return mkdtempSync(join(tmpdir(), 'CONSOLEMARKER-')); }

function bundle(reports: Reports): OperatorConsoleReport {
  return buildOperatorConsole({ mode: 'BUNDLE', bundle: reports });
}
function prefixOf(reports: Reports, upTo: number): Reports {
  const out: Reports = {};
  for (const p of CONSOLE_PHASES) { if (p <= upTo && reports[String(p)] !== undefined) out[String(p)] = reports[String(p)]!; }
  return out;
}
function statusOf(c: OperatorConsoleReport, phase: number): ArtifactStatus {
  return c.artifacts.find((a) => a.phase === phase)!.status;
}
// Write a chain into a directory under its canonical (0) or short (1) accepted filename.
function layout(dir: string, reports: Reports, which: 0 | 1 = 0): void {
  mkdirSync(dir, { recursive: true });
  for (const phase of CONSOLE_PHASES) {
    const value = reports[String(phase)];
    if (value === undefined) continue;
    writeFileSync(join(dir, CONSOLE_ARTIFACT_FILENAMES[phase]![which]!), `${JSON.stringify(value, null, 2)}\n`);
  }
}
function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: projectRoot, encoding: 'utf8' });
  assert(r.error === undefined, `spawn ok: ${r.error?.message ?? ''}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
// Every string in the intake that must never surface anywhere in the console's output.
function assertNoEcho(text: string, where: string): void {
  for (const marker of ['CONSOLEMARKER', '/mnt/', '\\mnt\\', 'catalog-authority-test-library', SYNTHETIC_APPROVAL_ID, SYNTHETIC_ITEM_ID, REAL_ITEM_ID, REAL_APPROVAL_ID]) {
    assert(!text.includes(marker), `${where}: leaked ${marker}`);
  }
  for (const d of PARTICIPANT_DIGESTS) assert(!text.includes(d), `${where}: leaked a participant identity`);
  for (const t of PARTICIPANT_TIMESTAMPS) assert(!text.includes(t), `${where}: leaked a timestamp`);
}

console.log('Running Phase 242 operator console suite:\n');

await test('a complete chain reports AUDIT_CLOSED in one command -- and the console still creates nothing', () => {
  const root = workspace();
  try {
    const c = bundle(buildSyntheticChain(root));
    assertEq(c.overall, 'AUDIT_CLOSED', `closed (${c.blockerCodes.join(',')})`);
    assertEq(c.auditOutcome, 'AUDIT_CLOSED', 'the audit agrees');
    assertEq(c.outcomeMatchesAudit, true, 'the console never diverges from a sound audit');
    assertEq(c.blockers.length, 0, 'no blockers');
    assertEq(c.presentCount, 10, 'all ten artifacts present');
    assertEq(c.absentCount, 0, 'nothing absent');
    assertEq(c.terminalPhase, 240, 'terminal phase 240');
    assertEq(c.nextRequiredPhase, null, 'nothing further required');
    assertEq(c.missingPhases.length, 0, 'nothing missing');
    assertEq(c.nonTerminalPhases.length, 0, 'every phase terminal');
    assertEq(c.intakeSound, true, 'intake sound');
    assertEq(c.audit.auditClosed, true, 'the embedded audit is carried whole');
    assertEq(c.audit.proofLimits.length, 11, 'the proof-limit matrix travels inside the console report');
    // It creates nothing, decides nothing, and infers nothing.
    assertEq(c.approvalCreatedByThisTool, false, 'created no approval');
    assertEq(c.executionPerformedByThisTool, false, 'performed no execution');
    assertEq(c.observationCapturedByThisTool, false, 'captured no observation');
    assertEq(c.custodyHeldByThisTool, false, 'held no custody');
    assertEq(c.archivedByThisTool, false, 'archived nothing');
    assertEq(c.judgmentFormedByThisTool, false, 'formed no judgment');
    assertEq(c.humanDecisionInferredByThisTool, false, 'inferred no human decision');
    assertEq(c.promotionRunByThisTool, false, 'ran no promotion');
    assertEq(c.selfAuthorized, false, 'never self-authorized');
    assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'the console report self-verifies');
    // AUDIT_CLOSED never overstates itself, in the summary or in the steps.
    const text = c.summary.join('\n');
    assert(text.includes('NOT that the promotion happened'), 'the summary states the honest limit of AUDIT_CLOSED');
    assert(c.nextSteps.some((s) => s.includes('does NOT mean the promotion happened')), 'the steps restate it too');
    assertNoEcho(JSON.stringify(c), 'closed report');
    assertNoEcho(text, 'closed summary');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('every clean prefix is AUDIT_OPEN with zero blockers, and names the next phase a human must produce', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);
    for (const upTo of [231, 232, 233, 234, 235, 236, 237, 238, 239]) {
      const c = bundle(prefixOf(reports, upTo));
      assertEq(c.overall, 'AUDIT_OPEN', `prefix to ${upTo} is open (${c.blockerCodes.join(',')})`);
      assertEq(c.blockers.length, 0, `a chain that stops at ${upTo} is not a defect`);
      assertEq(c.terminalPhase, upTo, `terminal phase ${upTo}`);
      assertEq(c.nextRequiredPhase, upTo + 1, `next required phase ${upTo + 1}`);
      assertEq(c.missingPhases[0], upTo + 1, 'the first missing phase leads');
      assertEq(c.presentCount, upTo - 230, 'present count tracks the prefix');
      assert(c.nextSteps.some((s) => s.startsWith(`The next artifact this chain needs is Phase ${upTo + 1}.`)), `the steps name Phase ${upTo + 1}`);
      assert(c.summary.join('\n').includes('honestly unfinished'), 'the summary says an open chain is normal');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('with no intake at all there is nothing to audit, and the console says how to give it one', () => {
  const c = buildOperatorConsole({});
  assertEq(c.overall, 'NOT_ELIGIBLE', 'nothing to audit');
  assertEq(c.intakeMode, 'NONE', 'no intake mode');
  assertEq(c.terminalPhase, null, 'no terminal phase');
  assertEq(c.nextRequiredPhase, 231, 'the anchor is what is required first');
  assert(c.blockerCodes.includes('CONSOLE_NO_INPUT'), 'CONSOLE_NO_INPUT reported');
  assert(c.blockerCodes.includes('AUDIT_NO_REPORTS_SUPPLIED'), 'the audit agrees there is nothing to audit');
  assertEq(c.presentCount, 0, 'nothing present');
  assertEq(c.absentCount, 10, 'everything absent');
  assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'even the empty report self-verifies');
});

// The whole point of the phase: these four are NOT the same thing, and only one of them is normal.
await test('ABSENT, MALFORMED, MISFILED and DUPLICATE are told apart -- only ABSENT is not a defect', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);

    const absent = bundle(prefixOf(reports, 234));
    assertEq(statusOf(absent, 235), 'ABSENT', 'an unwritten phase is ABSENT');
    assertEq(absent.overall, 'AUDIT_OPEN', 'and absence is never a defect');
    assertEq(absent.blockers.length, 0, 'absence raises no blocker');

    for (const junk of ['not-a-report', 42, null, true, {}, { report: 'phase-999-invented' }, { report: 231 }]) {
      const c = bundle({ ...prefixOf(reports, 234), 235: junk as Rec });
      assertEq(statusOf(c, 235), 'MALFORMED', `${JSON.stringify(junk)} is MALFORMED`);
      assertEq(c.overall, 'AUDIT_INVALID', 'a malformed artifact is a defect, not an absence');
      assert(c.blockerCodes.includes('CONSOLE_PHASE_235_ARTIFACT_MALFORMED'), 'CONSOLE_PHASE_235_ARTIFACT_MALFORMED reported');
      assertEq(c.malformedCount, 1, 'counted as malformed');
      assertEq(c.absentCount, 5, 'and NOT counted as absent');
    }

    // A genuine chain report in the wrong slot is a filing mistake, and says so.
    const misfiled = bundle({ ...prefixOf(reports, 234), 235: reports['236']! });
    assertEq(statusOf(misfiled, 235), 'MISFILED', 'a genuine report in the wrong slot is MISFILED');
    assertEq(misfiled.overall, 'AUDIT_INVALID', 'misfiling is a defect');
    assert(misfiled.blockerCodes.includes('CONSOLE_PHASE_235_ARTIFACT_MISFILED'), 'CONSOLE_PHASE_235_ARTIFACT_MISFILED reported');
    assert(misfiled.blockers.some((b) => b.humanAction.includes('Refile it under its own phase')), 'and the fix is to refile it');
    assertEq(misfiled.malformedCount, 0, 'misfiled is not malformed');

    // Two artifacts for one phase: the console will not pick one.
    const dup = bundle({ ...prefixOf(reports, 234), 235: [reports['235']!, reports['235']!] as unknown as Rec });
    assertEq(statusOf(dup, 235), 'DUPLICATE', 'two artifacts for one phase is DUPLICATE');
    assertEq(dup.overall, 'AUDIT_INVALID', 'a duplicate is a defect');
    assert(dup.blockerCodes.includes('CONSOLE_PHASE_235_ARTIFACT_DUPLICATE'), 'CONSOLE_PHASE_235_ARTIFACT_DUPLICATE reported');
    assert(dup.blockers.some((b) => b.meaning.includes('will not guess')), 'and it refuses to guess which is authoritative');
    assertEq(dup.presentCount, 4, 'a duplicated phase is never counted as present');

    // A one-element array is not a duplicate -- it is a shape no artifact has.
    const single = bundle({ ...prefixOf(reports, 234), 235: [reports['235']!] as unknown as Rec });
    assertEq(statusOf(single, 235), 'MALFORMED', 'a one-element array is malformed, not a duplicate');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('NOT_ELIGIBLE keeps its precedence: a defective anchor is never reported as merely invalid', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);
    const c = bundle({ ...reports, 231: { report: 'phase-231-promotion-execution-authorization-lookalike' } as Rec });
    assertEq(c.overall, 'NOT_ELIGIBLE', 'no anchor, nothing to audit against');
    assertEq(statusOf(c, 231), 'MALFORMED', 'the anchor slot holds something that is not the gate');
    assert(c.blockerCodes.includes('CONSOLE_PHASE_231_ARTIFACT_MALFORMED'), 'the intake defect is still reported');
    assert(c.blockerCodes.includes('AUDIT_ANCHOR_MISSING'), 'and so is the missing anchor');
    assertEq(c.nextRequiredPhase, 231, 'the anchor is what is needed first');

    // A tampered anchor that no longer recomputes is likewise no anchor at all.
    const tampered = JSON.parse(JSON.stringify(reports['231']!)) as Rec;
    tampered.injectedClaim = 'not-the-gate-that-was-audited';
    const t = bundle({ ...reports, 231: tampered });
    assertEq(t.overall, 'NOT_ELIGIBLE', 'a non-recomputing anchor is no anchor');
    assert(t.blockerCodes.includes('AUDIT_PHASE_231_DIGEST_MISMATCH'), 'the digest mismatch is reported');
    assert(t.blockers.some((b) => b.humanAction.includes('Re-sealing the altered copy')), 'and re-sealing is named as the non-fix it is');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The console is offline by construction. Anything in the intake it cannot recognise as a chain artifact gets
// the strict Phase 240 location/live-surface screen.
await test('adversarial: live, network and location-bearing payloads fail closed and are never echoed', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);
    const hostile: readonly unknown[] = [
      { endpoint: 'https://jellyfin.example.com:8096/emby/Items' },
      { host: '192.168.1.44' },
      { share: '\\\\tower\\media\\Movies' },
      { drive: 'C:\\Users\\operator\\artifacts' },
      { bucket: 'promotion-evidence-bucket' },
      { url: 's3://evidence/phase-235.json' },
      { where: '/mnt/user/media/Movies/Thing (2026)/thing.mp4' },
    ];
    for (const payload of hostile) {
      const c = bundle({ ...prefixOf(reports, 234), 235: payload as Rec });
      assertEq(c.overall, 'AUDIT_INVALID', `a live/location payload fails closed: ${JSON.stringify(payload)}`);
      assert(c.blockerCodes.includes('CONSOLE_LIVE_DATA_PRESENT'), `CONSOLE_LIVE_DATA_PRESENT for ${JSON.stringify(payload)}`);
      assert(c.blockers.some((b) => b.humanAction.includes('opens no connection')), 'and the console says it is offline by construction');
      const json = JSON.stringify(c);
      for (const leak of ['jellyfin.example.com', '192.168.1.44', 'tower', 'promotion-evidence-bucket', 's3://', '/mnt/']) {
        assert(!json.includes(leak), `the hostile payload is never echoed: ${leak}`);
      }
    }
    // And an unknown bundle key is refused without being read or named.
    const u = bundle({ ...prefixOf(reports, 232), 'phase-241-audit': { report: 'phase-241-promotion-audit-closure-packet' } as Rec, '../../etc/passwd': 'x' as unknown as Rec });
    assertEq(u.unknownKeyCount, 2, 'both unknown keys counted');
    assert(u.blockerCodes.includes('CONSOLE_UNKNOWN_ARTIFACT_KEY'), 'CONSOLE_UNKNOWN_ARTIFACT_KEY reported');
    assertEq(u.overall, 'AUDIT_INVALID', 'a bundle carrying keys it cannot name fails closed');
    assert(!JSON.stringify(u).includes('passwd'), 'and the key itself is never echoed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The strict screen must NOT fire on genuine artifacts: their own boundary prose legitimately names the live
// surfaces they avoid. A false positive here would make every real chain unauditable.
await test('a genuine chain is never mistaken for live data, however much boundary prose it carries', () => {
  const root = workspace();
  try {
    const c = bundle(buildSyntheticChain(root));
    assert(!c.blockerCodes.includes('CONSOLE_LIVE_DATA_PRESENT'), 'no false positive on genuine artifacts');
    assert(!c.blockerCodes.includes('CONSOLE_RAW_PATH_PRESENT'), 'no false raw-path positive either');
    assert(JSON.stringify(c.audit.boundary).includes('Jellyfin'), 'precondition: the artifacts really do name the live surfaces they avoid');
    const real = bundle(buildRealP227AChain());
    assert(real.blockers.length === 0, 'and none on the real chain either');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('adversarial: a raw path smuggled into a chain-shaped artifact the audit never sees is still caught', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);
    // Misfiled, so the Phase 241 audit never receives it -- the console screens it instead.
    const smuggled = reseal(236, reports['236']!, (o) => { o.injected = '/mnt/user/media/Movies/leak.mp4'; });
    const c = bundle({ ...prefixOf(reports, 234), 235: smuggled });
    assertEq(statusOf(c, 235), 'MISFILED', 'it is a genuine chain report, in the wrong slot');
    assert(c.blockerCodes.includes('CONSOLE_RAW_PATH_PRESENT'), 'CONSOLE_RAW_PATH_PRESENT reported');
    assertEq(c.overall, 'AUDIT_INVALID', 'and it fails closed');
    assert(!JSON.stringify(c).includes('/mnt/'), 'the smuggled path is never echoed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A forged report and an unfinished one must never read alike -- that is the distinction the whole chain
// exists to preserve, and the console has to carry it through in words.
await test('adversarial: a forged headline is explained as a forgery, never as an unfinished phase', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);
    const forged = reseal(234, reports['234']!, (o) => { o.dispositionAccepted = false; });
    const c = bundle(reports as Reports);
    assertEq(c.overall, 'AUDIT_CLOSED', 'precondition: the genuine chain is closed');
    const f = bundle({ ...reports, 234: forged });
    assertEq(f.overall, 'AUDIT_INVALID', 'a body that denies its own headline is invalid');
    assert(f.blockerCodes.includes('AUDIT_PHASE_234_STATE_CONTRADICTS_HEADLINE'), 'the contradiction is reported');
    const blocker = f.blockers.find((b) => b.code === 'AUDIT_PHASE_234_STATE_CONTRADICTS_HEADLINE')!;
    assertEq(blocker.phase, 234, 'attributed to its phase');
    assert(blocker.meaning.includes('cannot happen in a genuine report'), 'explained as impossible in a genuine report');
    assert(blocker.humanAction.includes('Treat this artifact as forged'), 'and the action is to treat it as forged');
    assert(!f.summary.join('\n').includes('honestly unfinished'), 'an invalid chain is never described as unfinished');
    assert(f.nextSteps[0]!.startsWith('Stop and resolve every blocker'), 'the first step is to stop');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('every blocker the chain can raise carries fixed, value-free text -- none falls back to the generic', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);
    const wrong = 'b'.repeat(64);
    const scenarios: Array<[string, Reports]> = [
      ['hole', (() => { const h = { ...reports }; delete h['236']; return h; })()],
      ['broken link', { ...reports, 234: reseal(234, reports['234']!, (o) => { (o.boundDigests as Rec)['observation-record'] = wrong; }) }],
      ['foreign operation', { ...reports, 237: reseal(237, reports['237']!, (o) => { (o.boundDigests as Rec).itemDigest = wrong; }) }],
      ['action claimed', { ...reports, 233: reseal(233, reports['233']!, (o) => { o.capturedByThisTool = true; }) }],
      ['findings present', { ...reports, 239: reseal(239, reports['239']!, (o) => { o.blockers = ['SOMETHING']; }) }],
      ['constant invalid', { ...reports, 240: reseal(240, reports['240']!, (o) => { o.redactionSafe = 'yes'; }) }],
      ['contradiction', { ...reports, 235: reseal(235, reports['235']!, (o) => { o.operationClosed = false; }) }],
      ['digest mismatch', { ...reports, 238: { ...reports['238']!, injected: true } }],
      ['malformed', { ...reports, 240: 'nope' as unknown as Rec }],
      ['misfiled', { ...reports, 240: reports['239']! }],
      ['duplicate', { ...reports, 240: [reports['240']!, reports['240']!] as unknown as Rec }],
    ];
    const seen = new Set<string>();
    for (const [label, r] of scenarios) {
      const c = bundle(r);
      assert(c.blockers.length > 0, `${label}: raises at least one blocker`);
      for (const b of c.blockers) {
        seen.add(b.code);
        assert(!b.meaning.startsWith('The Phase 241 audit reported a check this console has no fixed text for'),
          `${label}: ${b.code} has no fixed text`);
        assert(b.meaning.length > 0 && b.humanAction.length > 0, `${label}: ${b.code} explained and actionable`);
        assert(!JSON.stringify(b).includes(wrong), `${label}: ${b.code} never carries a value`);
      }
      assertNoEcho(JSON.stringify(c), `${label} report`);
    }
    assert(seen.size >= 10, `a broad blocker surface is exercised (saw ${seen.size})`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('a complete but non-terminal chain is open, blocker-free, and explains what is holding it open', () => {
  const root = workspace();
  try {
    const c = bundle(buildSyntheticChain(root, { inventoryReports: false }));
    assertEq(c.overall, 'AUDIT_OPEN', `open (${c.blockerCodes.join(',')})`);
    assertEq(c.blockers.length, 0, 'a genuine non-terminal phase is not a defect');
    assertEq(c.presentCount, 10, 'every artifact is present');
    assertEq(c.missingPhases.length, 0, 'nothing is missing');
    assertEq(c.nextRequiredPhase, 240, 'the unfinished phase is what is needed next, not a later artifact');
    assertEq(c.nonTerminalPhases.join(','), '240', 'Phase 240 is what holds it open');
    assert(c.nextSteps.some((s) => s.includes('Phase 240 is present and genuine but NOT in its terminal state')), 'and the steps say exactly that');
    assert(c.nextSteps.some((s) => s.includes('STRUCTURAL_ONLY')), 'naming the state it is stuck in');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('directory intake: caller-declared statuses are honoured, and an unknown one fails closed', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);
    const artifacts: Record<string, unknown> = {
      231: { status: 'PRESENT', report: reports['231']! },
      232: { status: 'PRESENT', report: reports['232']! },
      233: { status: 'DUPLICATE' },
      234: { status: 'MALFORMED' },
      235: { status: 'ABSENT' },
      236: { status: 'SOMETHING_ELSE' },
      237: {},
    };
    const c = buildOperatorConsole({ mode: 'DIRECTORY', artifacts, unknownFilesIgnored: 4 });
    assertEq(c.intakeMode, 'DIRECTORY', 'directory intake');
    assertEq(statusOf(c, 233), 'DUPLICATE', 'duplicate honoured');
    assertEq(statusOf(c, 234), 'MALFORMED', 'malformed honoured');
    assertEq(statusOf(c, 235), 'ABSENT', 'absent honoured');
    assertEq(statusOf(c, 236), 'MALFORMED', 'an unknown status fails closed to MALFORMED');
    assertEq(statusOf(c, 237), 'MALFORMED', 'a status-less intake entry fails closed too');
    assertEq(statusOf(c, 238), 'ABSENT', 'an entry that was never mentioned is simply absent');
    assertEq(c.unknownFilesIgnored, 4, 'ignored entries are counted');
    assert(c.summary.join('\n').includes('ignored, unread and never echoed: 4'), 'and reported as counted, not named');

    // A caller claiming PRESENT is never believed on its own: the body is always re-checked here.
    const lying = buildOperatorConsole({ mode: 'DIRECTORY', artifacts: { 231: { status: 'PRESENT', report: { report: 'phase-231-promotion-execution-authorization' } } } });
    assertEq(statusOf(lying, 231), 'PRESENT', 'the slot matches its report id');
    assertEq(lying.overall, 'NOT_ELIGIBLE', 'but a body that cannot recompute is still no anchor');
    const swapped = buildOperatorConsole({ mode: 'DIRECTORY', artifacts: { 231: { status: 'PRESENT', report: reports['232']! } } });
    assertEq(statusOf(swapped, 231), 'MISFILED', 'a claimed-PRESENT artifact of the wrong phase is caught here, not trusted');
    assertEq(c.unknownFilesIgnored, 4, 'counts are unaffected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a cyclic or deeply nested intake terminates instead of hanging or overflowing', () => {
  const cyclic: Record<string, unknown> = { report: 'not-a-chain-report' };
  cyclic.self = cyclic;
  let deep: unknown = 'leaf';
  for (let i = 0; i < 20000; i++) deep = [deep];
  const c = buildOperatorConsole({ mode: 'BUNDLE', bundle: { 231: cyclic, 232: deep } as Record<string, unknown> });
  assertEq(c.overall, 'NOT_ELIGIBLE', 'no anchor in either');
  assertEq(statusOf(c, 231), 'MALFORMED', 'the cyclic value is malformed');
  assertEq(statusOf(c, 232), 'MALFORMED', 'a one-element array chain is malformed');
  assertEq(verifySelfDigests([c]).overall, 'ALL_VERIFIED', 'and the report is still well-formed');
});

await test('the console is deterministic: identical intake, identical digest; any change moves it', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);
    assertEq(bundle(reports).consoleDigest, bundle(reports).consoleDigest, 'same intake, same digest');
    assert(bundle(reports).consoleDigest !== bundle(prefixOf(reports, 239)).consoleDigest, 'a different intake moves the digest');
    // Key order in the bundle is not a fact about the chain.
    const reversed: Reports = {};
    for (const p of [...CONSOLE_PHASES].reverse()) reversed[String(p)] = reports[String(p)]!;
    assertEq(bundle(reversed).consoleDigest, bundle(reports).consoleDigest, 'bundle key order does not change the verdict');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the filename allowlist cannot drift from what the audit checks, and can never escape a directory', () => {
  for (const phase of CONSOLE_PHASES) {
    const names = CONSOLE_ARTIFACT_FILENAMES[phase]!;
    assertEq(names.length, 2, `phase ${phase} accepts exactly two names`);
    assertEq(names[0], `${AUDIT_PHASE_REPORT_IDS[phase]!}.json`, `phase ${phase} canonical name is its report id`);
    assertEq(names[1], `phase-${phase}.json`, `phase ${phase} short name`);
    for (const n of names) {
      assert(!n.includes('/') && !n.includes('\\') && !n.includes('..'), `phase ${phase}: ${n} is a bare filename`);
    }
  }
  const all = CONSOLE_PHASES.flatMap((p) => CONSOLE_ARTIFACT_FILENAMES[p]!);
  assertEq(new Set(all).size, all.length, 'no filename is accepted for two phases');
});

test('the boundary and disclaimers state what the console will not do, and are carried in every report', () => {
  const c = buildOperatorConsole({});
  assertEq(c.boundary, CONSOLE_BOUNDARY, 'the boundary travels with the report');
  assertEq(c.disclaimers.length, CONSOLE_DISCLAIMERS.length, 'so do the disclaimers');
  for (const phrase of ['No promotion launcher run', 'no real Movies library read or write', 'no live Jellyfin call', 'no secret approval-file read', 'no network access', 'no merge, tag or push', 'no self-authorization']) {
    assert(c.boundary.includes(phrase), `the boundary names: ${phrase}`);
  }
  assert(c.disclaimers.some((d) => d.includes('adds no evidence semantics')), 'it claims no new semantics');
  assert(c.disclaimers.some((d) => d.includes('FIXED lookup')), 'and that its guidance is a fixed lookup');
  assertEq(verifySelfDigests([c]).results[0]!.recognized, true, 'the report id is registered with the self-digest verifier');
});

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

await test('CLI: one command over a directory of artifacts, and never a path or value in its output', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);
    const dir = join(root, 'artifacts');
    layout(dir, reports);
    // A directory legitimately holds other things. They are counted, never read, never named.
    writeFileSync(join(dir, 'operator-notes.txt'), 'not an artifact');
    mkdirSync(join(dir, 'old'), { recursive: true });
    const outPath = join(root, 'out', 'console.json');

    const ok = run(['--dir', dir, '--out', outPath]);
    assertEq(ok.status, 0, `AUDIT_CLOSED exits 0 (stderr: ${ok.stderr})`);
    assert(ok.stdout.includes('outcome:              AUDIT_CLOSED'), 'the human summary leads with the outcome');
    assert(ok.stdout.includes('next steps:'), 'and carries next steps');
    assert(ok.stdout.includes('ignored, unread and never echoed: 2'), 'the two non-allowlisted entries are counted');
    assertNoEcho(ok.stdout, 'stdout');
    assertNoEcho(ok.stderr, 'stderr');
    assert(existsSync(outPath), 'the report is written');
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as OperatorConsoleReport;
    assertEq(written.report, 'phase-242-promotion-operator-console', 'written report id');
    assertEq(written.overall, 'AUDIT_CLOSED', 'written verdict');
    assertEq(verifySelfDigests([written]).overall, 'ALL_VERIFIED', 'the written report self-verifies');
    assertNoEcho(JSON.stringify(written), 'written report');

    // The short filenames are accepted too, and reach the same verdict.
    const shortDir = join(root, 'short');
    layout(shortDir, reports, 1);
    const s = run(['--dir', shortDir, '--json']);
    assertEq(s.status, 0, 'short filenames reach the same verdict');
    const shortReport = JSON.parse(s.stdout) as OperatorConsoleReport;
    assertEq(shortReport.audit.auditDigest, written.audit.auditDigest, 'and audit the identical chain');
    assertEq(shortReport.unknownFilesIgnored, 0, 'this directory holds nothing else');
    // The console digests differ only because the intakes differ: one directory holds two unrelated entries.
    assert(shortReport.consoleDigest !== written.consoleDigest, 'the console digest covers the whole intake, ignored entries included');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI: discovery is allowlisted -- a duplicate fails closed and an unreadable artifact is a defect', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);

    // The same phase under both accepted names: the console will not choose.
    const dupDir = join(root, 'dup');
    layout(dupDir, reports);
    writeFileSync(join(dupDir, CONSOLE_ARTIFACT_FILENAMES[235]![1]!), JSON.stringify(reports['235']!));
    const d = run(['--dir', dupDir]);
    assertEq(d.status, 1, 'a duplicate exits AUDIT_INVALID 1');
    assert(d.stdout.includes('CONSOLE_PHASE_235_ARTIFACT_DUPLICATE'), 'and names the duplicated phase');
    assertNoEcho(d.stdout, 'duplicate stdout');

    // A file that is not JSON is MALFORMED -- emphatically not absent.
    const badDir = join(root, 'bad');
    layout(badDir, prefixOf(reports, 234));
    writeFileSync(join(badDir, CONSOLE_ARTIFACT_FILENAMES[235]![0]!), '{ truncated');
    const b = run(['--dir', badDir]);
    assertEq(b.status, 1, 'an unreadable artifact exits AUDIT_INVALID 1');
    assert(b.stdout.includes('CONSOLE_PHASE_235_ARTIFACT_MALFORMED'), 'reported as malformed');
    assert(b.stdout.includes('235  MALFORMED'), 'and shown per phase');
    assertNoEcho(b.stdout, 'malformed stdout');

    // An empty directory: nothing to audit, and it says so rather than pretending.
    const emptyDir = join(root, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const e = run(['--dir', emptyDir]);
    assertEq(e.status, 5, 'an empty directory exits NOT_ELIGIBLE 5');
    assert(e.stdout.includes('AUDIT_NO_REPORTS_SUPPLIED'), 'because there is nothing to audit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('CLI: the exit-code contract, the help text, and the output switches', () => {
  const root = workspace();
  try {
    const reports = buildSyntheticChain(root);
    const dir = join(root, 'full'); layout(dir, reports);
    const openDir = join(root, 'open'); layout(openDir, prefixOf(reports, 236));
    const bundlePath = join(root, 'bundle.json');
    writeFileSync(bundlePath, JSON.stringify(reports));

    assertEq(run(['--dir', dir]).status, 0, '0 = AUDIT_CLOSED');
    assertEq(run(['--dir', openDir]).status, 3, '3 = AUDIT_OPEN');
    assertEq(run(['--bundle', bundlePath]).status, 0, 'a bundle reaches the same verdict');

    // Usage errors are exit 2 and never echo the offending path.
    const missing = run(['--dir', join(root, 'no-such-CONSOLEMARKER-dir')]);
    assertEq(missing.status, 2, 'a missing directory exits 2');
    assertNoEcho(missing.stderr, 'missing-directory stderr');
    const badBundle = run(['--bundle', join(root, 'no-such.json')]);
    assertEq(badBundle.status, 2, 'a missing bundle exits 2');
    assertNoEcho(badBundle.stderr, 'missing-bundle stderr');
    assertEq(run(['--dir', dir, '--bundle', bundlePath]).status, 2, 'two intakes is a usage error');
    assertEq(run(['--out', join(root, 'x.json')]).status, 2, 'no intake is a usage error');
    assertEq(run([]).status, 2, 'no arguments at all is a usage error');

    const help = run(['--help']);
    assertEq(help.status, 0, '--help exits 0');
    for (const phase of CONSOLE_PHASES) {
      for (const name of CONSOLE_ARTIFACT_FILENAMES[phase]!) assert(help.stdout.includes(name), `--help lists ${name}`);
    }
    for (const phrase of ['Exit 0 = AUDIT_CLOSED', 'CREATES nothing', 'ABSENT, MALFORMED, MISFILED and DUPLICATE', 'never advice about whether the promotion should']) {
      assert(help.stdout.includes(phrase), `--help states: ${phrase}`);
    }

    const json = run(['--dir', dir, '--json']);
    assertEq(json.status, 0, '--json keeps the exit contract');
    const parsed = JSON.parse(json.stdout) as OperatorConsoleReport;
    assertEq(parsed.overall, 'AUDIT_CLOSED', '--json prints the full report');
    assertEq(verifySelfDigests([parsed]).overall, 'ALL_VERIFIED', 'which self-verifies');

    const quiet = run(['--dir', dir, '--quiet']);
    assertEq(quiet.status, 0, '--quiet keeps the exit contract');
    assertEq(quiet.stdout, '', '--quiet prints nothing at all');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// The real operation, end to end. This is the case the phase exists for: an operator points the console at
// what actually exists for P227-A and gets an honest answer without having to interpret anything.
// ---------------------------------------------------------------------------------------------------------

await test('end to end: the ACTUAL P227-A chain reads as honestly open and NEVER as closed or eligible', () => {
  const root = workspace();
  try {
    const dir = join(root, 'p227a');
    layout(dir, buildRealP227AChain());
    const r = run(['--dir', dir, '--json']);
    assertEq(r.status, 3, 'the real chain exits AUDIT_OPEN 3');
    const c = JSON.parse(r.stdout) as OperatorConsoleReport;

    assertEq(c.overall, 'AUDIT_OPEN', 'consistent as far as it goes');
    assertEq(c.auditOutcome, 'AUDIT_OPEN', 'and the audit agrees');
    assertEq(c.blockers.length, 0, 'stopping at 232 is not a defect -- no human approved the run');
    assertEq(c.terminalPhase, 232, 'the real chain reaches Phase 232');
    assertEq(c.presentCount, 2, 'only two artifacts exist for the real operation');
    assertEq(c.absentCount, 8, 'the other eight are absent, not defective');
    assertEq(c.malformedCount + c.misfiledCount + c.duplicateCount, 0, 'nothing is wrong with what does exist');
    // THE CASE THAT MATTERS. The real Phase 232 record exists and is genuine, but nobody has decided it. The
    // outstanding step is therefore that decision -- NOT Phase 233, which cannot exist until someone makes it.
    // Pointing an operator at Phase 233 here would be telling them to record an observation of a run nobody
    // authorized, which is the exact confusion this phase exists to remove.
    assertEq(c.nextRequiredPhase, 232, 'the outstanding step is the undecided Phase 232, not the next absent phase');
    assertEq(c.nonTerminalPhases.join(','), '232', 'Phase 232 is present and unfinished');
    assertEq(c.missingPhases.join(','), '233,234,235,236,237,238,239,240', 'and the rest are simply not there');

    // It is NOT closed, NOT complete, and never says otherwise.
    assertEq(c.audit.auditClosed, false, 'the real audit is NOT closed');
    assertEq(c.audit.chainComplete, false, 'the real chain is NOT complete');
    assertEq(c.audit.identityAnchored, true, 'but the real operation identity IS anchored');
    assertEq(c.audit.phases.find((p) => p.phase === 232)!.semanticallySound, true, 'the real Phase 232 record is genuinely sound');
    assertEq(c.audit.phases.find((p) => p.phase === 232)!.terminal, false, 'and genuinely undecided');

    // The summary has to say all that in words a person can act on without interpreting a status code.
    const text = c.summary.join('\n');
    assert(text.includes('honestly unfinished'), 'the summary says the chain is honestly unfinished');
    assert(text.includes('This is normal, not a defect'), 'and that this is normal');
    assert(text.includes('blockers:             none'), 'with no blockers');
    assert(!text.includes('AUDIT_CLOSED'), 'and never puts the word AUDIT_CLOSED in front of an operator here');

    assert(text.includes('next required phase:  232  (present, but not finished)'), 'the summary marks it as unfinished, not missing');

    // The next step must describe the decision without making, recommending or inferring it -- and must leave
    // DECLINE standing as a complete outcome, because a console that only describes the approving path is
    // recommending one.
    const step = c.nextSteps.find((s) => s.startsWith('Phase 232 is present and genuine but NOT in its terminal state'))!;
    assert(step !== undefined, 'the next step is the Phase 232 decision');
    assert(step.includes('APPROVE or DECLINE'), 'it names both directions of the decision');
    assert(step.includes('does not make, infer or recommend that decision'), 'and the console does none of it');
    assert(step.includes('DECLINE is a complete and valid outcome'), 'declining ends the chain honestly');
    assert(!c.nextSteps.some((s) => s.includes('Phase 233 records what a human OBSERVED')), 'and nobody is sent past the outstanding decision');
    assertEq(c.humanDecisionInferredByThisTool, false, 'no human decision is inferred');
    assertEq(c.promotionRunByThisTool, false, 'no promotion is run');
    assertNoEcho(r.stdout, 'real-chain stdout');
    assertNoEcho(JSON.stringify(c), 'real-chain report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('end to end: the real chain cannot be talked into closing by bolting on a finished-looking tail', () => {
  const root = workspace();
  try {
    const real = buildRealP227AChain();
    const synthetic = buildSyntheticChain(root, {
      itemId: '55555555555555555555555555555555', approvalId: 'chain-kit-tail',
      body: Buffer.concat([MINIMAL_MP4_FIXTURE, Buffer.from('-tail')]),
    });
    const grafted: Reports = { ...real };
    for (const phase of [233, 234, 235, 236, 237, 238, 239, 240]) grafted[String(phase)] = synthetic[String(phase)]!;
    const dir = join(root, 'grafted');
    layout(dir, grafted);

    const r = run(['--dir', dir, '--json']);
    assertEq(r.status, 1, 'a grafted tail exits AUDIT_INVALID 1');
    const c = JSON.parse(r.stdout) as OperatorConsoleReport;
    assertEq(c.overall, 'AUDIT_INVALID', 'a grafted tail is not an auditable chain');
    assertEq(c.audit.auditClosed, false, 'the real P227-A audit is NOT closed');
    assert(c.blockerCodes.includes('AUDIT_PHASE_233_OPERATION_IDENTITY_MISMATCH'), 'the tail is a different operation');
    assert(c.blockerCodes.includes('AUDIT_PHASE_233_LINK_NOT_REDERIVED'), 'and it does not link to the real authorization');
    assertEq(Object.keys(c.audit.operationDigests).length, 0, 'no operation digests are published');
    assert(c.nextSteps.some((s) => s.includes('Reports from two operations are not one chain')), 'and the console says so plainly');
    assert(c.nextSteps.some((s) => s.includes('Never delete or archive an artifact to clear a blocker')), 'while never suggesting destruction as a fix');
    assertNoEcho(r.stdout, 'grafted stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
