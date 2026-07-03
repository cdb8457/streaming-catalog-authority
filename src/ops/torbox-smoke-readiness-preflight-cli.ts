import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildTorBoxSmokeReadinessPreflightInputErrorReport,
  buildTorBoxSmokeReadinessPreflightReport,
  formatTorBoxSmokeReadinessPreflightJson,
  formatTorBoxSmokeReadinessPreflightText,
  parseTorBoxSmokeReadinessDescriptorJson,
  reportHasFailures,
  type TorBoxSmokeReadinessPreflightInputErrorCode,
} from './torbox-smoke-readiness-preflight.js';

const MAX_DESCRIPTOR_BYTES = 64 * 1024;

type DescriptorFileReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: TorBoxSmokeReadinessPreflightInputErrorCode };

/**
 * Phase 40 - TorBox smoke readiness descriptor preflight.
 *
 *   tsx src/ops/torbox-smoke-readiness-preflight-cli.ts <descriptor.json> [--json]
 *   (or: npm run ops:torbox-smoke-readiness-preflight -- -- <descriptor.json> --json)
 *
 * LOCAL DESCRIPTOR PREFLIGHT ONLY. Reads exactly one operator-supplied JSON descriptor file, then
 * validates metadata for future TorBox operator-smoke readiness review. It does not read env values,
 * scan directories, connect to a database, call TorBox, run Docker, construct transports, inspect
 * evidence artifacts, read secret files, install provider mode, or close live-smoke readiness.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:torbox-smoke-readiness-preflight -- <descriptor.json> [--json]');
    return 0;
  }

  const normalized = args.filter((arg) => arg !== '--');
  const asJson = normalized.includes('--json');
  const unsupported = normalized.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const paths = normalized.filter((arg) => !arg.startsWith('-'));
  if (unsupported.length > 0 || paths.length !== 1) {
    console.error('usage: ops:torbox-smoke-readiness-preflight -- <descriptor.json> [--json]');
    return 2;
  }

  const input = readDescriptorFile(paths[0] ?? '');
  const report = input.ok
    ? buildReportFromJson(input.text)
    : buildTorBoxSmokeReadinessPreflightInputErrorReport(input.code);

  process.stdout.write(asJson ? formatTorBoxSmokeReadinessPreflightJson(report) : formatTorBoxSmokeReadinessPreflightText(report));
  return reportHasFailures(report) ? 1 : 0;
}

function buildReportFromJson(jsonText: string) {
  const parsed = parseTorBoxSmokeReadinessDescriptorJson(jsonText);
  if (typeof parsed === 'string') return buildTorBoxSmokeReadinessPreflightInputErrorReport(parsed);
  return buildTorBoxSmokeReadinessPreflightReport(parsed);
}

function readDescriptorFile(path: string): DescriptorFileReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: 'DESCRIPTOR_FILE_READ_FAILED' };
    if (stat.size > MAX_DESCRIPTOR_BYTES) return { ok: false, code: 'DESCRIPTOR_FILE_TOO_LARGE' };

    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { ok: false, code: 'DESCRIPTOR_FILE_READ_FAILED' };
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
