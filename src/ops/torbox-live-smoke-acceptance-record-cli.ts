import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildTorBoxLiveSmokeAcceptanceInputErrorReport,
  buildTorBoxLiveSmokeAcceptanceReport,
  formatTorBoxLiveSmokeAcceptanceJson,
  formatTorBoxLiveSmokeAcceptanceText,
  parseTorBoxLiveSmokeAcceptanceJson,
  torBoxLiveSmokeAcceptanceHasFailures,
  type TorBoxLiveSmokeAcceptanceInputErrorCode,
} from './torbox-live-smoke-acceptance-record.js';

const MAX_ACCEPTANCE_BYTES = 64 * 1024;

type AcceptanceFileReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: TorBoxLiveSmokeAcceptanceInputErrorCode };

/**
 * Phase 54 - TorBox live smoke acceptance record preflight.
 *
 * LOCAL REVIEW PREP ONLY. Reads one explicit operator-supplied acceptance JSON file and emits fixed,
 * redaction-safe readiness labels. It does not scan directories, read artifact contents, echo paths,
 * read env values, read credentials, call TorBox, construct transports, or enable provider mode.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:torbox-live-smoke-acceptance-record -- <acceptance-record.json> [--json]');
    return 0;
  }

  const normalized = args.filter((arg) => arg !== '--');
  const asJson = normalized.includes('--json');
  const unsupported = normalized.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const paths = normalized.filter((arg) => !arg.startsWith('-'));
  if (unsupported.length > 0 || paths.length > 1) {
    console.error('usage: ops:torbox-live-smoke-acceptance-record -- <acceptance-record.json> [--json]');
    return 2;
  }

  let report = paths.length === 0
    ? buildTorBoxLiveSmokeAcceptanceInputErrorReport('ACCEPTANCE_INPUT_REQUIRED')
    : null;

  if (report === null) {
    const input = readAcceptanceFile(paths[0] ?? '');
    if (!input.ok) {
      report = buildTorBoxLiveSmokeAcceptanceInputErrorReport(input.code);
    } else {
      const parsed = parseTorBoxLiveSmokeAcceptanceJson(input.text);
      report = typeof parsed === 'string'
        ? buildTorBoxLiveSmokeAcceptanceInputErrorReport(parsed)
        : buildTorBoxLiveSmokeAcceptanceReport(parsed);
    }
  }

  process.stdout.write(asJson ? formatTorBoxLiveSmokeAcceptanceJson(report) : formatTorBoxLiveSmokeAcceptanceText(report));
  return torBoxLiveSmokeAcceptanceHasFailures(report) ? 1 : 0;
}

function readAcceptanceFile(path: string): AcceptanceFileReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: 'ACCEPTANCE_FILE_READ_FAILED' };
    if (stat.size > MAX_ACCEPTANCE_BYTES) return { ok: false, code: 'ACCEPTANCE_FILE_TOO_LARGE' };

    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, code: 'ACCEPTANCE_FILE_READ_FAILED' };
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
