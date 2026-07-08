import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidSwitchEvidenceReview,
  buildUnraidSwitchEvidenceReviewInputError,
  formatUnraidSwitchEvidenceReviewJson,
  formatUnraidSwitchEvidenceReviewText,
  parseUnraidSwitchEvidenceReviewJson,
  unraidSwitchEvidenceReviewHasFailures,
  type UnraidSwitchEvidenceReviewInputErrorCode,
} from './unraid-switch-evidence-review.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidSwitchEvidenceReviewInputErrorCode): never {
  const report = buildUnraidSwitchEvidenceReviewInputError(code);
  process.stdout.write(process.argv.includes('--json') ? formatUnraidSwitchEvidenceReviewJson(report) : formatUnraidSwitchEvidenceReviewText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('SWITCH_EVIDENCE_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('SWITCH_EVIDENCE_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('SWITCH_EVIDENCE_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('SWITCH_EVIDENCE_FILE_READ_FAILED');
}

const parsed = parseUnraidSwitchEvidenceReviewJson(text);
const report = typeof parsed === 'string' ? buildUnraidSwitchEvidenceReviewInputError(parsed) : buildUnraidSwitchEvidenceReview(parsed);
process.stdout.write(process.argv.includes('--json') ? formatUnraidSwitchEvidenceReviewJson(report) : formatUnraidSwitchEvidenceReviewText(report));
if (unraidSwitchEvidenceReviewHasFailures(report)) process.exit(1);
