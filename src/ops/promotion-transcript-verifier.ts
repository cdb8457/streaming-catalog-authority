import { createHash } from 'node:crypto';

// Local, non-live review-transcript verifier (v2). It binds a review transcript to the exact expected test
// commands and their exit semantics (a command "passed" iff its failed count is 0), confirms the reviewed
// commit equals the supplied head, and records the fixed full-`npm test` caveat (the full aggregate is not
// run by the local gate). It reads parsed JSON only; it performs no promotion, never touches the real
// Movies root, never contacts Jellyfin, and authorizes nothing live.

export interface TranscriptVerifierInput {
  readonly transcript?: unknown;
  readonly head?: unknown;
  readonly expectedCommands?: unknown;
}

export const FULL_NPM_TEST_CAVEAT =
  'The full `npm test` aggregate (legacy / live / CRLF-sensitive / embedded-Postgres / live-Jellyfin suites) is NOT run by the local gate and is out of scope for this transcript; only the bound commands were exercised.';

export interface CommandResult { readonly command: string; readonly passed: number; readonly failed: number; readonly exitOk: boolean; }
export interface VerifierCheck { readonly check: string; readonly ok: boolean; }

export interface TranscriptVerification {
  readonly report: 'phase-230-promotion-transcript-verification';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'TRANSCRIPT_VERIFIED' | 'TRANSCRIPT_UNVERIFIED';
  readonly head: string | null;
  readonly commandResults: readonly CommandResult[];
  readonly fullNpmTestCaveat: string;
  readonly checks: readonly VerifierCheck[];
  readonly blockers: readonly string[];
  readonly verificationDigest: string;
}

export function buildTranscriptVerification(input: TranscriptVerifierInput): TranscriptVerification {
  const blockers: string[] = [];
  const checks: VerifierCheck[] = [];
  let head: string | null = asSha40(input.head) ?? null;
  let commandResults: CommandResult[] = [];

  const expected = Array.isArray(input.expectedCommands)
    ? input.expectedCommands.filter((c): c is string => typeof c === 'string' && pathFreeString(c) !== null)
    : [];
  const expectedOk = expected.length > 0 && (!Array.isArray(input.expectedCommands) || input.expectedCommands.length === expected.length);
  if (!expectedOk) blockers.push('EXPECTED_COMMANDS_MISSING');
  checks.push({ check: 'expected-commands-well-formed', ok: expectedOk });

  const tr = input.transcript;
  if (tr === undefined) { blockers.push('TRANSCRIPT_MISSING'); checks.push({ check: 'transcript-present', ok: false }); }
  else {
    const o = asObject(tr);
    if (o.report !== 'phase-230-promotion-review-transcript') { blockers.push('TRANSCRIPT_INVALID'); checks.push({ check: 'transcript-present', ok: false }); }
    else {
      checks.push({ check: 'transcript-present', ok: true });
      const clean = o.verdict === 'REVIEW_CLEAN';
      if (!clean) blockers.push('TRANSCRIPT_NOT_CLEAN');
      checks.push({ check: 'transcript-clean', ok: clean });

      const reviewed = asSha40(o.reviewedCommit) ?? null;
      const headMatch = reviewed !== null && head !== null && reviewed === head;
      if (!headMatch) blockers.push('HEAD_MISMATCH');
      checks.push({ check: 'reviewed-commit=head', ok: headMatch });

      commandResults = normalizeResults(o.testResults);
      const byCommand = new Map(commandResults.map((r) => [r.command, r]));
      let commandMissing = false;
      let exitNonZero = false;
      for (const cmd of expected) {
        const r = byCommand.get(cmd);
        if (r === undefined) commandMissing = true;
        else if (!r.exitOk) exitNonZero = true;
      }
      if (expectedOk && commandMissing) blockers.push('COMMAND_MISSING');
      if (exitNonZero) blockers.push('TEST_EXIT_NONZERO');
      checks.push({ check: 'expected-commands-bound', ok: expectedOk && !commandMissing });
      checks.push({ check: 'exit-codes-clean', ok: !exitNonZero });
    }
  }

  const overall: TranscriptVerification['overall'] = blockers.length === 0 ? 'TRANSCRIPT_VERIFIED' : 'TRANSCRIPT_UNVERIFIED';
  const withoutDigest: Omit<TranscriptVerification, 'verificationDigest'> = {
    report: 'phase-230-promotion-transcript-verification',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    head,
    commandResults,
    fullNpmTestCaveat: FULL_NPM_TEST_CAVEAT,
    checks,
    blockers: [...new Set(blockers)],
  };
  return { ...withoutDigest, verificationDigest: digest('phase-230-transcript-verifier', JSON.stringify(withoutDigest)) };
}

// A test result is well-formed only with a path-free command and non-negative integer counts; exitOk means
// the command reported zero failures (exit 0).
function normalizeResults(value: unknown): CommandResult[] {
  if (!Array.isArray(value)) return [];
  const out: CommandResult[] = [];
  for (const r of value) {
    const o = asObject(r);
    const command = pathFreeString(o.command);
    const passed = isNonNegInt(o.passed) ? o.passed as number : -1;
    const failed = isNonNegInt(o.failed) ? o.failed as number : -1;
    if (command === null || passed < 0 || failed < 0) continue;
    out.push({ command, passed, failed, exitOk: failed === 0 });
  }
  return out;
}
function isNonNegInt(v: unknown): boolean { return typeof v === 'number' && Number.isInteger(v) && v >= 0; }
function pathFreeString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value)) return null;
  return value;
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha40(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
