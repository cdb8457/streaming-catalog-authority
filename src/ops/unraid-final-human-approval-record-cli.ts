import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidFinalHumanApprovalRecordInputErrorPreflight,
  buildUnraidFinalHumanApprovalRecordPreflight,
  formatUnraidFinalHumanApprovalRecordPreflightJson,
  formatUnraidFinalHumanApprovalRecordPreflightText,
  parseUnraidFinalHumanApprovalRecordJson,
  unraidFinalHumanApprovalRecordHasFailures,
  type UnraidFinalHumanApprovalRecordInputErrorCode,
} from './unraid-final-human-approval-record.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidFinalHumanApprovalRecordInputErrorCode): never {
  const report = buildUnraidFinalHumanApprovalRecordInputErrorPreflight(code);
  process.stdout.write(process.argv.includes('--json')
    ? formatUnraidFinalHumanApprovalRecordPreflightJson(report)
    : formatUnraidFinalHumanApprovalRecordPreflightText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('FINAL_APPROVAL_RECORD_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('FINAL_APPROVAL_RECORD_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('FINAL_APPROVAL_RECORD_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('FINAL_APPROVAL_RECORD_FILE_READ_FAILED');
}

const parsed = parseUnraidFinalHumanApprovalRecordJson(text);
const report = typeof parsed === 'string'
  ? buildUnraidFinalHumanApprovalRecordInputErrorPreflight(parsed)
  : buildUnraidFinalHumanApprovalRecordPreflight(parsed);

process.stdout.write(process.argv.includes('--json')
  ? formatUnraidFinalHumanApprovalRecordPreflightJson(report)
  : formatUnraidFinalHumanApprovalRecordPreflightText(report));
if (unraidFinalHumanApprovalRecordHasFailures(report)) process.exit(1);
