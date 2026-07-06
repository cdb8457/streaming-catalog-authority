import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildOperatorUiLocalAuthSecretFilePreflightInputErrorReport,
  buildOperatorUiLocalAuthSecretFilePreflightReport,
  formatOperatorUiLocalAuthSecretFilePreflightJson,
  formatOperatorUiLocalAuthSecretFilePreflightText,
  operatorUiLocalAuthSecretFilePreflightHasFailures,
  parseOperatorUiLocalAuthSecretFilePreflightDescriptorJson,
  type OperatorUiLocalAuthSecretFilePreflightInputErrorCode,
} from './operator-ui-local-auth-secret-file-preflight.js';

const MAX_DESCRIPTOR_BYTES = 16 * 1024;

type DescriptorFileReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: OperatorUiLocalAuthSecretFilePreflightInputErrorCode };

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('usage: ops:operator-ui-local-auth-secret-file-preflight -- <descriptor.json> [--json]\n');
    return 0;
  }

  const normalized = args.filter((arg) => arg !== '--');
  const asJson = normalized.includes('--json');
  const unsupported = normalized.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const paths = normalized.filter((arg) => !arg.startsWith('-'));

  const input: DescriptorFileReadResult = unsupported.length > 0 || paths.length !== 1
    ? { ok: false, code: 'DESCRIPTOR_FILE_REQUIRED' }
    : readDescriptorFile(paths[0] ?? '');

  const report = input.ok
    ? buildReportFromJson(input.text)
    : buildOperatorUiLocalAuthSecretFilePreflightInputErrorReport(input.code);

  process.stdout.write(asJson
    ? formatOperatorUiLocalAuthSecretFilePreflightJson(report)
    : formatOperatorUiLocalAuthSecretFilePreflightText(report));
  return operatorUiLocalAuthSecretFilePreflightHasFailures(report) ? 1 : 0;
}

function buildReportFromJson(jsonText: string) {
  const parsed = parseOperatorUiLocalAuthSecretFilePreflightDescriptorJson(jsonText);
  if (typeof parsed === 'string') return buildOperatorUiLocalAuthSecretFilePreflightInputErrorReport(parsed);
  return buildOperatorUiLocalAuthSecretFilePreflightReport(parsed);
}

function readDescriptorFile(path: string): DescriptorFileReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (stat.isDirectory()) return { ok: false, code: 'DESCRIPTOR_FILE_IS_DIRECTORY' };
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
        // Output remains fixed by the already computed descriptor read result.
      }
    }
  }
}

process.exit(main());
