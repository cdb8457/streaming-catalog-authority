import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildCustodianEvidencePreflightInputErrorReport,
  buildCustodianEvidencePreflightReport,
  formatCustodianEvidencePreflightJson,
  formatCustodianEvidencePreflightText,
  parseCustodianEvidenceDescriptorJson,
  reportHasFailures,
  type CustodianEvidencePreflightInputErrorCode,
} from './custodian-evidence-preflight.js';

const MAX_DESCRIPTOR_BYTES = 64 * 1024;

type DescriptorFileReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: CustodianEvidencePreflightInputErrorCode };

/**
 * Phase 29 - production custodian evidence descriptor preflight.
 *
 *   tsx src/ops/custodian-evidence-preflight-cli.ts <descriptor.json> [--json]
 *   (or: npm run ops:custodian-evidence-preflight -- -- <descriptor.json> --json)
 *
 * LOCAL DESCRIPTOR PREFLIGHT ONLY. Reads exactly one operator-supplied JSON descriptor file, then
 * validates metadata against the Phase 28 production custodian contract. It does not read env
 * values, scan directories, connect to a database, call remote APIs, run container tooling, or contact
 * external custody services.
 * service, inspect evidence artifacts, or close O4.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:custodian-evidence-preflight -- <descriptor.json> [--json]');
    return 0;
  }

  const normalized = args.filter((arg) => arg !== '--');
  const asJson = normalized.includes('--json');
  const unsupported = normalized.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const paths = normalized.filter((arg) => !arg.startsWith('-'));
  if (unsupported.length > 0 || paths.length !== 1) {
    console.error('usage: ops:custodian-evidence-preflight -- <descriptor.json> [--json]');
    return 2;
  }

  const input = readDescriptorFile(paths[0] ?? '');
  const report = input.ok
    ? buildReportFromJson(input.text)
    : buildCustodianEvidencePreflightInputErrorReport(input.code);

  process.stdout.write(asJson ? formatCustodianEvidencePreflightJson(report) : formatCustodianEvidencePreflightText(report));
  return reportHasFailures(report) ? 1 : 0;
}

function buildReportFromJson(jsonText: string) {
  const parsed = parseCustodianEvidenceDescriptorJson(jsonText);
  if (typeof parsed === 'string') return buildCustodianEvidencePreflightInputErrorReport(parsed);
  return buildCustodianEvidencePreflightReport(parsed);
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
        // Redaction-safe output is already determined by the descriptor read result.
      }
    }
  }
}

process.exit(main());
