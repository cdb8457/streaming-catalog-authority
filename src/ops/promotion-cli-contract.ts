import { createHash } from 'node:crypto';

// Local, non-live CLI contract snapshot guard. Every Phase 230 local reporting CLI must print a single
// redaction-safe JSON capture to stdout: a `report` id ending in `-capture`, a `redactionSafe: true` flag,
// at least one sha256 `*Digest` key, and NO path-like values anywhere. This tool verifies a captured
// stdout object against that universal contract and derives a stable top-level key signature so drift is
// visible. It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never
// contacts Jellyfin, and authorizes nothing live.

// Declared stdout key snapshots (unsorted) for the AE-AK aggregator/verifier CLIs. The guard's test spawns
// each and asserts its live capture matches the sorted signature here, so any drift is caught.
export const CONTRACT_SIGNATURES: Readonly<Record<string, readonly string[]>> = {
  'promotion-consistency-matrix': ['report', 'overall', 'authorization', 'redactionSafe', 'edges', 'mismatches', 'incomplete', 'matrixDigest'],
  'promotion-self-digest-verifier': ['report', 'overall', 'authorization', 'redactionSafe', 'count', 'results', 'mismatches', 'unrecognized', 'verifierDigest'],
  'promotion-cli-contract': ['report', 'overall', 'authorization', 'redactionSafe', 'results', 'violations', 'contractDigest'],
  'promotion-determinism': ['report', 'overall', 'authorization', 'redactionSafe', 'results', 'nonDeterministic', 'determinismDigest'],
  'promotion-blocker-taxonomy': ['report', 'overall', 'authorization', 'redactionSafe', 'count', 'categories', 'problems', 'taxonomyDigest'],
  'promotion-final-summary': ['report', 'overall', 'authorization', 'redactionSafe', 'reviewedCommit', 'testResults', 'testsPassed', 'testsFailed', 'checks', 'blockers', 'summaryDigest'],
  'promotion-closure-hygiene': ['report', 'overall', 'authorization', 'redactionSafe', 'checks', 'problems', 'hygieneDigest'],
};

// The CLIs whose exact signature the guard snapshots (and dynamically verifies).
export const CONTRACTED_CLIS: readonly string[] = Object.keys(CONTRACT_SIGNATURES);

export function signatureOf(keys: readonly string[]): string {
  return [...keys].filter((k) => k !== 'outputWritten').sort().join(',');
}

export interface CliContractResult {
  readonly ok: boolean;
  readonly keySignature: string;
  readonly problems: readonly string[];
}

export interface CliContractEntry {
  readonly name: string;
  readonly ok: boolean;
  readonly keySignature: string;
  readonly problems: readonly string[];
}

export interface CliContractReport {
  readonly report: 'phase-230-promotion-cli-contract';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'CONTRACT_OK' | 'CONTRACT_VIOLATION' | 'NO_CAPTURES';
  readonly results: readonly CliContractEntry[];
  readonly violations: readonly string[];
  readonly contractDigest: string;
}

// One capture's compliance with the universal CLI-output contract. `outputWritten` is excluded from the
// key signature so a run with `--out` and a run without it produce the same signature.
export function verifyCliContract(capture: unknown): CliContractResult {
  const problems: string[] = [];
  if (!isPlainObject(capture)) return { ok: false, keySignature: '', problems: ['NOT_AN_OBJECT'] };

  const report = capture.report;
  if (typeof report !== 'string' || !report.endsWith('-capture')) problems.push('REPORT_ID_INVALID');
  if (capture.redactionSafe !== true) problems.push('REDACTION_FLAG_MISSING');
  const hasDigest = Object.keys(capture).some((k) => /Digest$/.test(k) && isSha256(capture[k]));
  if (!hasDigest) problems.push('DIGEST_MISSING');
  if (hasPathLeak(capture)) problems.push('RAW_PATH_LEAK');

  const keySignature = Object.keys(capture).filter((k) => k !== 'outputWritten').sort().join(',');
  return { ok: problems.length === 0, keySignature, problems };
}

export function buildCliContractReport(captures: readonly unknown[]): CliContractReport {
  const results: CliContractEntry[] = captures.map((c) => {
    const name = isPlainObject(c) && typeof c.report === 'string' ? c.report : '<unknown>';
    const r = verifyCliContract(c);
    return { name, ok: r.ok, keySignature: r.keySignature, problems: r.problems };
  });
  const violations = results.filter((r) => !r.ok).map((r) => r.name);
  const overall: CliContractReport['overall'] =
    captures.length === 0 ? 'NO_CAPTURES' : violations.length > 0 ? 'CONTRACT_VIOLATION' : 'CONTRACT_OK';
  const withoutDigest: Omit<CliContractReport, 'contractDigest'> = {
    report: 'phase-230-promotion-cli-contract',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    results,
    violations,
  };
  return { ...withoutDigest, contractDigest: digest('phase-230-cli-contract', JSON.stringify(withoutDigest)) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isSha256(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}
function looksLikePath(s: string): boolean {
  return /^\//.test(s) || /[A-Za-z]:[\\/]/.test(s) || /\/mnt\//.test(s) || /\\mnt\\/.test(s)
    || s.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(s);
}
function hasPathLeak(value: unknown): boolean {
  if (typeof value === 'string') return looksLikePath(value);
  if (Array.isArray(value)) return value.some(hasPathLeak);
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasPathLeak);
  return false;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
