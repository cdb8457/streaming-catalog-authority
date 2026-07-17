import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTranscriptVerification } from '../src/ops/promotion-transcript-verifier.js';
import { buildReviewTranscript } from '../src/ops/promotion-review-transcript.js';
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
const HEAD = 'da4bb856fd666ca5cc5959715ef4d8b3ab11dac6';
const COMMANDS = ['npm run test:phase230-local', 'npm run typecheck'];
function cleanTranscript(results: Array<{ command: string; passed: number; failed: number }>, commit = HEAD) {
  return buildReviewTranscript({ reviewedCommit: commit, testResults: results });
}

console.log('Running Phase 230 transcript verifier suite:\n');

test('TRANSCRIPT_VERIFIED when reviewed commit == head and every expected command exits 0', () => {
  const transcript = cleanTranscript([{ command: COMMANDS[0]!, passed: 50, failed: 0 }, { command: COMMANDS[1]!, passed: 1, failed: 0 }]);
  const v = buildTranscriptVerification({ transcript, head: HEAD, expectedCommands: COMMANDS });
  assertEq(v.overall, 'TRANSCRIPT_VERIFIED', `verified (blockers: ${v.blockers.join(',')})`);
  assertEq(v.authorization, 'NONE', 'authorizes nothing');
  assertEq(v.head, HEAD, 'head recorded');
  assert(v.checks.every((c) => c.ok), 'every check ok');
  assert(v.commandResults.length === 2 && v.commandResults.every((r) => r.exitOk), 'both commands exit 0');
  assert(/full .npm test. aggregate/i.test(v.fullNpmTestCaveat), 'full npm-test caveat recorded');
  assertEq(verifySelfDigests([v]).overall, 'ALL_VERIFIED', 'report self-verifies');
  assert(/^[0-9a-f]{64}$/.test(v.verificationDigest), 'verification digest present');
});

test('UNVERIFIED when the reviewed commit does not equal head', () => {
  const transcript = cleanTranscript([{ command: COMMANDS[0]!, passed: 5, failed: 0 }, { command: COMMANDS[1]!, passed: 1, failed: 0 }], 'a1b2c3d4e5f6071829304152637485960a1b2c3d');
  const v = buildTranscriptVerification({ transcript, head: HEAD, expectedCommands: COMMANDS });
  assertEq(v.overall, 'TRANSCRIPT_UNVERIFIED', 'unverified');
  assert(v.blockers.includes('HEAD_MISMATCH'), 'head-mismatch blocker');
});

test('UNVERIFIED on a missing expected command or a non-zero exit', () => {
  const missing = buildTranscriptVerification({ transcript: cleanTranscript([{ command: COMMANDS[0]!, passed: 5, failed: 0 }]), head: HEAD, expectedCommands: COMMANDS });
  assert(missing.blockers.includes('COMMAND_MISSING'), 'missing expected command blocked');
  const failedRun = buildTranscriptVerification({ transcript: cleanTranscript([{ command: COMMANDS[0]!, passed: 4, failed: 1 }, { command: COMMANDS[1]!, passed: 1, failed: 0 }]), head: HEAD, expectedCommands: COMMANDS });
  assert(failedRun.blockers.includes('TEST_EXIT_NONZERO'), 'non-zero exit blocked');
});

test('UNVERIFIED and redaction-safe on empty input (no expected commands)', () => {
  const v = buildTranscriptVerification({});
  assertEq(v.overall, 'TRANSCRIPT_UNVERIFIED', 'unverified');
  assert(v.blockers.includes('TRANSCRIPT_MISSING') && v.blockers.includes('EXPECTED_COMMANDS_MISSING'), 'missing blockers');
  assert(v.redactionSafe === true && !JSON.stringify(v).includes('/mnt/'), 'redaction-safe');
});

await test('CLI verifies the transcript and never echoes raw paths to stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-transverify-'));
  try {
    const transcript = cleanTranscript([{ command: COMMANDS[0]!, passed: 50, failed: 0 }, { command: COMMANDS[1]!, passed: 1, failed: 0 }]);
    const trFile = join(root, 'tr.json'); writeFileSync(trFile, JSON.stringify(transcript));
    const outPath = join(root, 'catalog-authority-test-library', 'TVMARKER-out', 'verification.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-transcript-verifier-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--transcript', trFile, '--head', HEAD, '--command', COMMANDS[0]!, '--command', COMMANDS[1]!, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `VERIFIED exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'verification file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'TRANSCRIPT_VERIFIED', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('TVMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
