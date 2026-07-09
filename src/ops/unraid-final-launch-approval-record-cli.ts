import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidFinalLaunchApprovalRecord,
  buildUnraidFinalLaunchApprovalRecordInputError,
  formatUnraidFinalLaunchApprovalRecordJson,
  formatUnraidFinalLaunchApprovalRecordText,
  parseUnraidFinalLaunchApprovalRecordJson,
  unraidFinalLaunchApprovalRecordHasFailures,
  type UnraidFinalLaunchApprovalRecordInputErrorCode,
} from './unraid-final-launch-approval-record.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidFinalLaunchApprovalRecordInputErrorCode): never {
  const report = buildUnraidFinalLaunchApprovalRecordInputError(code);
  process.stdout.write(process.argv.includes('--json')
    ? formatUnraidFinalLaunchApprovalRecordJson(report)
    : formatUnraidFinalLaunchApprovalRecordText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('FINAL_LAUNCH_APPROVAL_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('FINAL_LAUNCH_APPROVAL_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('FINAL_LAUNCH_APPROVAL_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('FINAL_LAUNCH_APPROVAL_FILE_READ_FAILED');
}

const parsed = parseUnraidFinalLaunchApprovalRecordJson(text);
const report = typeof parsed === 'string'
  ? buildUnraidFinalLaunchApprovalRecordInputError(parsed)
  : buildUnraidFinalLaunchApprovalRecord(parsed);

process.stdout.write(process.argv.includes('--json')
  ? formatUnraidFinalLaunchApprovalRecordJson(report)
  : formatUnraidFinalLaunchApprovalRecordText(report));
if (unraidFinalLaunchApprovalRecordHasFailures(report)) process.exit(1);
