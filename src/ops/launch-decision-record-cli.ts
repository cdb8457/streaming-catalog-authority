import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildLaunchDecisionRecordInputErrorReport,
  buildLaunchDecisionRecordReport,
  formatLaunchDecisionRecordJson,
  formatLaunchDecisionRecordText,
  launchDecisionRecordHasFailures,
  parseLaunchDecisionRecordJson,
  type LaunchDecisionRecordInputErrorCode,
} from './launch-decision-record.js';

const MAX_RECORD_BYTES = 64 * 1024;

type RecordFileReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: LaunchDecisionRecordInputErrorCode };

/**
 * Phase 85 - launch decision record preflight.
 *
 * LOCAL REVIEW PREP ONLY. Reads one explicit operator-supplied decision JSON file and emits fixed,
 * redaction-safe readiness labels. It does not scan evidence folders, echo values or paths, read
 * credentials/env/DB, contact live services, execute commands, close O4/O5, or approve launch.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:launch-decision-record -- <decision-record.json> [--json]');
    return 0;
  }

  const normalized = args.filter((arg) => arg !== '--');
  const asJson = normalized.includes('--json');
  const unsupported = normalized.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const paths = normalized.filter((arg) => !arg.startsWith('-'));
  if (unsupported.length > 0 || paths.length > 1) {
    console.error('usage: ops:launch-decision-record -- <decision-record.json> [--json]');
    return 2;
  }

  let report = paths.length === 0
    ? buildLaunchDecisionRecordInputErrorReport('LAUNCH_DECISION_INPUT_REQUIRED')
    : null;

  if (report === null) {
    const input = readRecordFile(paths[0] ?? '');
    if (!input.ok) {
      report = buildLaunchDecisionRecordInputErrorReport(input.code);
    } else {
      const parsed = parseLaunchDecisionRecordJson(input.text);
      report = typeof parsed === 'string'
        ? buildLaunchDecisionRecordInputErrorReport(parsed)
        : buildLaunchDecisionRecordReport(parsed);
    }
  }

  process.stdout.write(asJson ? formatLaunchDecisionRecordJson(report) : formatLaunchDecisionRecordText(report));
  return launchDecisionRecordHasFailures(report) ? 1 : 0;
}

function readRecordFile(path: string): RecordFileReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: 'LAUNCH_DECISION_FILE_READ_FAILED' };
    if (stat.size > MAX_RECORD_BYTES) return { ok: false, code: 'LAUNCH_DECISION_FILE_TOO_LARGE' };

    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, code: 'LAUNCH_DECISION_FILE_READ_FAILED' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preflight output remains fixed and redaction-safe.
      }
    }
  }
}

process.exit(main());
