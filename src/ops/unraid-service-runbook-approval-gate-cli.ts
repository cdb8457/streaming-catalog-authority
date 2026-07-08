import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidServiceRunbookApprovalGateInputErrorReport,
  buildUnraidServiceRunbookApprovalGateReport,
  formatUnraidServiceRunbookApprovalGateJson,
  formatUnraidServiceRunbookApprovalGateText,
  parseUnraidServiceRunbookApprovalGateJson,
  type UnraidServiceRunbookApprovalGateInputErrorCode,
  unraidServiceRunbookApprovalGateHasFailures,
} from './unraid-service-runbook-approval-gate.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidServiceRunbookApprovalGateInputErrorCode): never {
  const report = buildUnraidServiceRunbookApprovalGateInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatUnraidServiceRunbookApprovalGateJson(report) : formatUnraidServiceRunbookApprovalGateText(report));
  process.exit(1);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(path: string | undefined, kind: 'runbook' | 'review'): Record<string, unknown> | UnraidServiceRunbookApprovalGateInputErrorCode {
  if (!path || path.startsWith('--')) return kind === 'runbook' ? 'RUNBOOK_INPUT_REQUIRED' : 'REVIEW_INPUT_REQUIRED';
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return kind === 'runbook' ? 'RUNBOOK_FILE_READ_FAILED' : 'REVIEW_FILE_READ_FAILED';
    if (stat.size > MAX_INPUT_BYTES) return kind === 'runbook' ? 'RUNBOOK_FILE_TOO_LARGE' : 'REVIEW_FILE_TOO_LARGE';
    return parseUnraidServiceRunbookApprovalGateJson(readFileSync(path, 'utf8'), kind);
  } catch {
    return kind === 'runbook' ? 'RUNBOOK_FILE_READ_FAILED' : 'REVIEW_FILE_READ_FAILED';
  }
}

const runbook = readJson(argValue('--runbook'), 'runbook');
if (typeof runbook === 'string') inputError(runbook);
const review = readJson(argValue('--review'), 'review');
if (typeof review === 'string') inputError(review);

const report = buildUnraidServiceRunbookApprovalGateReport(runbook, review);
process.stdout.write(process.argv.includes('--json') ? formatUnraidServiceRunbookApprovalGateJson(report) : formatUnraidServiceRunbookApprovalGateText(report));
if (unraidServiceRunbookApprovalGateHasFailures(report)) process.exit(1);
