import { readFileSync, statSync } from 'node:fs';

export const OPERATOR_UI_EVIDENCE_REVIEW_REPORT = 'phase-152-operator-ui-evidence-review';
export const OPERATOR_UI_EVIDENCE_REVIEW_DEFAULT_MAX_AGE_HOURS = 24;

export interface OperatorUiEvidenceReviewInput {
  readonly files: readonly string[];
  readonly maxAgeHours?: number;
  readonly nowMs?: number;
}

export interface OperatorUiEvidenceReviewFileResult {
  readonly file: string;
  readonly state: 'pass' | 'fail';
  readonly ageHours?: number;
  readonly checks: readonly OperatorUiEvidenceReviewCheck[];
}

export interface OperatorUiEvidenceReviewCheck {
  readonly name: 'json' | 'schema' | 'recent' | 'passing';
  readonly state: 'pass' | 'fail';
  readonly detail: string;
}

export interface OperatorUiEvidenceReviewReport {
  readonly report: typeof OPERATOR_UI_EVIDENCE_REVIEW_REPORT;
  readonly ok: boolean;
  readonly maxAgeHours: number;
  readonly reviewed: number;
  readonly passed: number;
  readonly failed: number;
  readonly files: readonly OperatorUiEvidenceReviewFileResult[];
}

export function reviewOperatorUiEvidence(input: OperatorUiEvidenceReviewInput): OperatorUiEvidenceReviewReport {
  const maxAgeHours = input.maxAgeHours ?? OPERATOR_UI_EVIDENCE_REVIEW_DEFAULT_MAX_AGE_HOURS;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('maxAgeHours must be positive.');
  if (input.files.length === 0) throw new Error('At least one evidence file is required.');
  const nowMs = input.nowMs ?? Date.now();
  const files = input.files.map((file) => reviewFile(file, maxAgeHours, nowMs));
  const passed = files.filter((file) => file.state === 'pass').length;
  const failed = files.length - passed;
  return {
    report: OPERATOR_UI_EVIDENCE_REVIEW_REPORT,
    ok: failed === 0,
    maxAgeHours,
    reviewed: files.length,
    passed,
    failed,
    files,
  };
}

function reviewFile(file: string, maxAgeHours: number, nowMs: number): OperatorUiEvidenceReviewFileResult {
  const checks: OperatorUiEvidenceReviewCheck[] = [];
  let parsed: unknown;
  let ageHours: number | undefined;

  try {
    const stat = statSync(file);
    ageHours = Math.max(0, (nowMs - stat.mtimeMs) / 3_600_000);
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    checks.push({ name: 'json', state: 'pass', detail: 'valid JSON' });
  } catch {
    checks.push({ name: 'json', state: 'fail', detail: 'file is missing, unreadable, or invalid JSON' });
  }

  if (ageHours === undefined) {
    checks.push({ name: 'recent', state: 'fail', detail: 'file timestamp unavailable' });
  } else if (ageHours <= maxAgeHours) {
    checks.push({ name: 'recent', state: 'pass', detail: `age ${ageHours.toFixed(2)}h <= ${maxAgeHours}h` });
  } else {
    checks.push({ name: 'recent', state: 'fail', detail: `age ${ageHours.toFixed(2)}h > ${maxAgeHours}h` });
  }

  if (isSchemaComplete(parsed)) {
    checks.push({ name: 'schema', state: 'pass', detail: 'required live-check fields present' });
  } else {
    checks.push({ name: 'schema', state: 'fail', detail: 'missing required live-check fields' });
  }

  if (isPassingEvidence(parsed)) {
    checks.push({ name: 'passing', state: 'pass', detail: 'report ok=true and all check states pass' });
  } else {
    checks.push({ name: 'passing', state: 'fail', detail: 'report is not passing or contains failing checks' });
  }

  return {
    file,
    state: checks.every((check) => check.state === 'pass') ? 'pass' : 'fail',
    ...(ageHours === undefined ? {} : { ageHours: Number(ageHours.toFixed(4)) }),
    checks,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchemaComplete(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.report !== 'phase-150-operator-ui-live-check') return false;
  if (typeof value.baseUrl !== 'string' || typeof value.ok !== 'boolean') return false;
  if (!Array.isArray(value.checks) || value.checks.length !== 4) return false;
  if (!isRecord(value.statusSummary) || !isRecord(value.logSummary)) return false;
  for (const key of ['ok', 'pass', 'warn', 'fail', 'total', 'needsAttentionCount']) {
    if (!(key in value.statusSummary)) return false;
  }
  if (typeof value.logSummary.entries !== 'number') return false;
  return value.checks.every((check) => {
    if (!isRecord(check)) return false;
    return typeof check.name === 'string'
      && (check.state === 'pass' || check.state === 'fail')
      && typeof check.statusCode === 'number'
      && typeof check.detail === 'string';
  });
}

function isPassingEvidence(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.checks)) return false;
  if (isRecord(value.statusSummary) && value.statusSummary.ok !== true) return false;
  return value.checks.every((check) => isRecord(check) && check.state === 'pass');
}
