import { readFileSync } from 'node:fs';

export type CutoverDoctorCheckpointStatus = 'healthy' | 'unhealthy' | 'parse-error';

export interface CutoverDoctorCheckpointResult {
  readonly status: CutoverDoctorCheckpointStatus;
  readonly retryable: boolean;
  readonly ok: boolean;
  readonly reportVersion?: number;
  readonly pass?: number;
  readonly warn?: number;
  readonly fail?: number;
  readonly total?: number;
  readonly reason?: string;
}

interface DoctorCheck {
  readonly name: unknown;
  readonly state: unknown;
  readonly detail: unknown;
}

interface DoctorReport {
  readonly reportVersion: 1;
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

function isDoctorReport(value: unknown): value is DoctorReport {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as DoctorReport;
  return candidate.reportVersion === 1
    && typeof candidate.ok === 'boolean'
    && Array.isArray(candidate.checks)
    && candidate.checks.every((check: unknown) => {
      const c = check as DoctorCheck;
      return c !== null
        && typeof c === 'object'
        && typeof c.name === 'string'
        && ['pass', 'warn', 'fail'].includes(String(c.state))
        && typeof c.detail === 'string';
    });
}

export function parseCutoverDoctorCheckpoint(raw: string, exitCode = 0): CutoverDoctorCheckpointResult {
  const candidates = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));

  for (let index = candidates.length - 1; index >= 0; index--) {
    try {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      const parsed = JSON.parse(candidate) as unknown;
      if (!isDoctorReport(parsed)) continue;
      const fail = parsed.checks.filter((check: DoctorCheck) => check.state === 'fail').length;
      const warn = parsed.checks.filter((check: DoctorCheck) => check.state === 'warn').length;
      const pass = parsed.checks.filter((check: DoctorCheck) => check.state === 'pass').length;
      const total = parsed.checks.length;
      if (exitCode !== 0 && parsed.ok === true) {
        return {
          status: 'parse-error',
          retryable: true,
          ok: false,
          reportVersion: 1,
          pass,
          warn,
          fail,
          total,
          reason: 'doctor JSON reports healthy but command exit code was nonzero',
        };
      }
      if (parsed.ok === true && fail === 0) {
        return { status: 'healthy', retryable: false, ok: true, reportVersion: 1, pass, warn, fail, total };
      }
      return {
        status: 'unhealthy',
        retryable: false,
        ok: false,
        reportVersion: 1,
        pass,
        warn,
        fail,
        total,
        reason: 'doctor JSON reported unhealthy or included fail checks',
      };
    } catch {
      continue;
    }
  }

  return {
    status: 'parse-error',
    retryable: true,
    ok: false,
    reason: 'no valid doctor JSON object with reportVersion=1, ok, and checks[] was found',
  };
}

export function parseCutoverDoctorCheckpointFile(path: string, exitCode = 0): CutoverDoctorCheckpointResult {
  return parseCutoverDoctorCheckpoint(readFileSync(path, 'utf8'), exitCode);
}
