import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildTorBoxLiveSmokeSummaryInputErrorPack,
  buildTorBoxLiveSmokeSummaryPack,
  formatTorBoxLiveSmokeSummaryPackJson,
  formatTorBoxLiveSmokeSummaryPackText,
  parseTorBoxLiveSmokeSummaryEvidenceJson,
  torBoxLiveSmokeSummaryPackHasFailures,
  TORBOX_LIVE_SMOKE_SUMMARY_MAX_INPUTS,
  type TorBoxLiveSmokeSummaryInputErrorCode,
} from './torbox-live-smoke-summary-pack.js';

const MAX_EVIDENCE_BYTES = 64 * 1024;

type EvidenceFileReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: TorBoxLiveSmokeSummaryInputErrorCode };

/**
 * Phase 49 - TorBox live smoke summary pack.
 *
 * LOCAL SUMMARY ONLY. Reads explicit operator-supplied Phase 43 JSON reports and emits fixed,
 * redaction-safe summary labels. It does not scan directories, echo paths, read env values, read
 * credential files, connect to a database, call TorBox, construct transports, or close review.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:torbox-live-smoke-summary-pack -- <phase-43-report.json>... [--json]');
    return 0;
  }

  const normalized = args.filter((arg) => arg !== '--');
  const asJson = normalized.includes('--json');
  const unsupported = normalized.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const paths = normalized.filter((arg) => !arg.startsWith('-'));
  if (unsupported.length > 0) {
    console.error('usage: ops:torbox-live-smoke-summary-pack -- <phase-43-report.json>... [--json]');
    return 2;
  }

  let report = paths.length === 0
    ? buildTorBoxLiveSmokeSummaryInputErrorPack('SUMMARY_INPUT_REQUIRED')
    : paths.length > TORBOX_LIVE_SMOKE_SUMMARY_MAX_INPUTS
      ? buildTorBoxLiveSmokeSummaryInputErrorPack('SUMMARY_TOO_MANY_INPUTS')
      : null;

  if (report === null) {
    const evidence: Record<string, unknown>[] = [];
    for (const path of paths) {
      const input = readEvidenceFile(path);
      if (!input.ok) {
        report = buildTorBoxLiveSmokeSummaryInputErrorPack(input.code);
        break;
      }
      const parsed = parseTorBoxLiveSmokeSummaryEvidenceJson(input.text);
      if (typeof parsed === 'string') {
        report = buildTorBoxLiveSmokeSummaryInputErrorPack(parsed);
        break;
      }
      evidence.push(parsed);
    }
    if (report === null) report = buildTorBoxLiveSmokeSummaryPack(evidence);
  }

  process.stdout.write(asJson ? formatTorBoxLiveSmokeSummaryPackJson(report) : formatTorBoxLiveSmokeSummaryPackText(report));
  return torBoxLiveSmokeSummaryPackHasFailures(report) ? 1 : 0;
}

function readEvidenceFile(path: string): EvidenceFileReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: 'SUMMARY_FILE_READ_FAILED' };
    if (stat.size > MAX_EVIDENCE_BYTES) return { ok: false, code: 'SUMMARY_FILE_TOO_LARGE' };

    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, code: 'SUMMARY_FILE_READ_FAILED' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Summary output remains fixed and redaction-safe.
      }
    }
  }
}

process.exit(main());
