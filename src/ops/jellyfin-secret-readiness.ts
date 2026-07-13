import { statSync } from 'node:fs';
import { resolveVar, type Env } from '../config/env.js';

export interface JellyfinSecretReadinessFinding {
  readonly level: 'pass' | 'fail';
  readonly code: string;
  readonly detail: string;
}

export interface JellyfinSecretReadinessReport {
  readonly report: 'phase-212-jellyfin-secret-readiness';
  readonly version: 1;
  readonly ok: boolean;
  readonly redactionSafe: true;
  readonly status: 'JELLYFIN_SECRET_READY' | 'JELLYFIN_SECRET_NOT_READY';
  readonly secretValueEchoed: false;
  readonly secretPathEchoed: false;
  readonly sourcePreflight: 'phase-210-jellyfin-live-evidence-capture-preflight';
  readonly unlocks: 'phase-211-jellyfin-live-evidence-capture';
  readonly summary: {
    readonly pass: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly JellyfinSecretReadinessFinding[];
}

function pass(code: string, detail: string): JellyfinSecretReadinessFinding {
  return { level: 'pass', code, detail };
}

function fail(code: string, detail: string): JellyfinSecretReadinessFinding {
  return { level: 'fail', code, detail };
}

function modeIsRestrictive(mode: number): boolean {
  return ((mode & 0o777) & 0o077) === 0;
}

export function checkJellyfinSecretReadiness(env: Env = process.env): JellyfinSecretReadinessReport {
  const findings: JellyfinSecretReadinessFinding[] = [];

  if (env.JELLYFIN_API_KEY !== undefined) {
    findings.push(fail('DIRECT_SECRET_ENV_SET', 'JELLYFIN_API_KEY must not be set; use JELLYFIN_API_KEY_FILE'));
  } else {
    findings.push(pass('DIRECT_SECRET_ENV_ABSENT', 'direct API key environment variable is absent'));
  }

  if (!env.JELLYFIN_API_KEY_FILE || env.JELLYFIN_API_KEY_FILE.trim() === '') {
    findings.push(fail('SECRET_FILE_ENV_MISSING', 'JELLYFIN_API_KEY_FILE is required'));
  } else {
    findings.push(pass('SECRET_FILE_ENV_PRESENT', 'JELLYFIN_API_KEY_FILE is present'));
  }

  const resolved = resolveVar(env, 'JELLYFIN_API_KEY');
  if (resolved.problem) {
    findings.push(fail('SECRET_FILE_UNREADABLE_OR_EMPTY', resolved.problem));
  } else if (resolved.value && resolved.value.trim().length > 0) {
    findings.push(pass('SECRET_FILE_READABLE_NONEMPTY', 'secret file is readable and non-empty'));
  } else if (env.JELLYFIN_API_KEY_FILE) {
    findings.push(fail('SECRET_FILE_EMPTY', 'secret file did not produce a non-empty value'));
  }

  if (env.JELLYFIN_API_KEY_FILE && env.JELLYFIN_API_KEY_FILE.trim() !== '') {
    try {
      const stat = statSync(env.JELLYFIN_API_KEY_FILE);
      if (stat.isFile()) findings.push(pass('SECRET_PATH_IS_FILE', 'secret path is a regular file'));
      else findings.push(fail('SECRET_PATH_NOT_FILE', 'secret path is not a regular file'));
      if (process.platform === 'win32') findings.push(pass('SECRET_FILE_MODE_PLATFORM_LIMITED', 'secret file mode is not authoritative on this platform'));
      else if (modeIsRestrictive(stat.mode)) findings.push(pass('SECRET_FILE_MODE_RESTRICTIVE', 'secret file mode is owner-only'));
      else findings.push(fail('SECRET_FILE_MODE_TOO_OPEN', 'secret file mode allows group or other access'));
    } catch {
      findings.push(fail('SECRET_FILE_STAT_FAILED', 'secret file metadata could not be read'));
    }
  }

  const failCount = findings.filter((finding) => finding.level === 'fail').length;
  return {
    report: 'phase-212-jellyfin-secret-readiness',
    version: 1,
    ok: failCount === 0,
    redactionSafe: true,
    status: failCount === 0 ? 'JELLYFIN_SECRET_READY' : 'JELLYFIN_SECRET_NOT_READY',
    secretValueEchoed: false,
    secretPathEchoed: false,
    sourcePreflight: 'phase-210-jellyfin-live-evidence-capture-preflight',
    unlocks: 'phase-211-jellyfin-live-evidence-capture',
    summary: {
      pass: findings.length - failCount,
      fail: failCount,
      total: findings.length,
    },
    findings,
  };
}
