import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildTorBoxLiveSmokeReviewGateInputErrorReport,
  buildTorBoxLiveSmokeReviewGateReport,
  formatTorBoxLiveSmokeReviewGateJson,
  formatTorBoxLiveSmokeReviewGateText,
  parseTorBoxLiveSmokeReviewGateSummaryJson,
  torBoxLiveSmokeReviewGateHasFailures,
  type TorBoxLiveSmokeReviewGateInputErrorCode,
} from './torbox-live-smoke-review-gate.js';

const MAX_SUMMARY_BYTES = 64 * 1024;

type SummaryFileReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: TorBoxLiveSmokeReviewGateInputErrorCode };

/**
 * Phase 51 - TorBox live smoke review gate.
 *
 * LOCAL REVIEW PREP ONLY. Reads one explicit Phase 49 summary JSON file and emits fixed,
 * redaction-safe review readiness labels. It does not scan directories, echo paths, read env values,
 * read credential files, connect to a database, call TorBox, construct transports, or close review.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:torbox-live-smoke-review-gate -- <phase-49-summary-pack.json> [--json]');
    return 0;
  }

  const normalized = args.filter((arg) => arg !== '--');
  const asJson = normalized.includes('--json');
  const unsupported = normalized.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const paths = normalized.filter((arg) => !arg.startsWith('-'));
  if (unsupported.length > 0 || paths.length > 1) {
    console.error('usage: ops:torbox-live-smoke-review-gate -- <phase-49-summary-pack.json> [--json]');
    return 2;
  }

  let report = paths.length === 0
    ? buildTorBoxLiveSmokeReviewGateInputErrorReport('REVIEW_GATE_INPUT_REQUIRED')
    : null;

  if (report === null) {
    const input = readSummaryFile(paths[0] ?? '');
    if (!input.ok) {
      report = buildTorBoxLiveSmokeReviewGateInputErrorReport(input.code);
    } else {
      const parsed = parseTorBoxLiveSmokeReviewGateSummaryJson(input.text);
      report = typeof parsed === 'string'
        ? buildTorBoxLiveSmokeReviewGateInputErrorReport(parsed)
        : buildTorBoxLiveSmokeReviewGateReport(parsed);
    }
  }

  process.stdout.write(asJson ? formatTorBoxLiveSmokeReviewGateJson(report) : formatTorBoxLiveSmokeReviewGateText(report));
  return torBoxLiveSmokeReviewGateHasFailures(report) ? 1 : 0;
}

function readSummaryFile(path: string): SummaryFileReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: 'REVIEW_GATE_FILE_READ_FAILED' };
    if (stat.size > MAX_SUMMARY_BYTES) return { ok: false, code: 'REVIEW_GATE_FILE_TOO_LARGE' };

    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, code: 'REVIEW_GATE_FILE_READ_FAILED' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Review gate output remains fixed and redaction-safe.
      }
    }
  }
}

process.exit(main());
