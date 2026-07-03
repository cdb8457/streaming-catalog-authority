import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildTorBoxLiveSmokeEvidencePreflightInputErrorReport,
  buildTorBoxLiveSmokeEvidencePreflightReport,
  formatTorBoxLiveSmokeEvidencePreflightJson,
  formatTorBoxLiveSmokeEvidencePreflightText,
  parseTorBoxLiveSmokeEvidenceJson,
  torBoxLiveSmokeEvidenceReportHasFailures,
  type TorBoxLiveSmokeEvidenceInputErrorCode,
} from './torbox-live-smoke-evidence-preflight.js';

const MAX_EVIDENCE_BYTES = 64 * 1024;

type EvidenceFileReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: TorBoxLiveSmokeEvidenceInputErrorCode };

/**
 * Phase 44 - TorBox live smoke evidence preflight.
 *
 * LOCAL EVIDENCE PREFLIGHT ONLY. Reads exactly one operator-supplied Phase 43 JSON report and
 * verifies its redaction-safe shape. It does not read env values, read credential files, scan
 * directories, connect to a database, call TorBox, construct transports, or close live-smoke review.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:torbox-live-smoke-evidence-preflight -- <phase-43-report.json> [--json]');
    return 0;
  }

  const normalized = args.filter((arg) => arg !== '--');
  const asJson = normalized.includes('--json');
  const unsupported = normalized.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const paths = normalized.filter((arg) => !arg.startsWith('-'));
  if (unsupported.length > 0 || paths.length !== 1) {
    console.error('usage: ops:torbox-live-smoke-evidence-preflight -- <phase-43-report.json> [--json]');
    return 2;
  }

  const input = readEvidenceFile(paths[0] ?? '');
  const report = input.ok
    ? buildReportFromJson(input.text)
    : buildTorBoxLiveSmokeEvidencePreflightInputErrorReport(input.code);

  process.stdout.write(asJson ? formatTorBoxLiveSmokeEvidencePreflightJson(report) : formatTorBoxLiveSmokeEvidencePreflightText(report));
  return torBoxLiveSmokeEvidenceReportHasFailures(report) ? 1 : 0;
}

function buildReportFromJson(jsonText: string) {
  const parsed = parseTorBoxLiveSmokeEvidenceJson(jsonText);
  if (typeof parsed === 'string') return buildTorBoxLiveSmokeEvidencePreflightInputErrorReport(parsed);
  return buildTorBoxLiveSmokeEvidencePreflightReport(parsed);
}

function readEvidenceFile(path: string): EvidenceFileReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: 'EVIDENCE_FILE_READ_FAILED' };
    if (stat.size > MAX_EVIDENCE_BYTES) return { ok: false, code: 'EVIDENCE_FILE_TOO_LARGE' };

    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, code: 'EVIDENCE_FILE_READ_FAILED' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Output is fixed and redaction-safe regardless of close errors.
      }
    }
  }
}

process.exit(main());
