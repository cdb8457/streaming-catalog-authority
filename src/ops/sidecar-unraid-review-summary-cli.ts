import { readFileSync, statSync } from 'node:fs';
import {
  buildSidecarUnraidReviewSummaryInputErrorReport,
  buildSidecarUnraidReviewSummaryReport,
  formatSidecarUnraidReviewSummaryJson,
  formatSidecarUnraidReviewSummaryText,
  parseSidecarUnraidReviewSummaryJson,
  sidecarUnraidReviewSummaryHasFailures,
  type SidecarUnraidReviewSummaryInputErrorCode,
} from './sidecar-unraid-review-summary.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: SidecarUnraidReviewSummaryInputErrorCode): never {
  const report = buildSidecarUnraidReviewSummaryInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidReviewSummaryJson(report) : formatSidecarUnraidReviewSummaryText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('REVIEW_SUMMARY_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('REVIEW_SUMMARY_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('REVIEW_SUMMARY_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('REVIEW_SUMMARY_FILE_READ_FAILED');
}

const parsed = parseSidecarUnraidReviewSummaryJson(text);
const report = typeof parsed === 'string'
  ? buildSidecarUnraidReviewSummaryInputErrorReport(parsed)
  : buildSidecarUnraidReviewSummaryReport(parsed);

process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidReviewSummaryJson(report) : formatSidecarUnraidReviewSummaryText(report));
if (sidecarUnraidReviewSummaryHasFailures(report)) process.exit(1);
