import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidPostSwitchEvidenceReview,
  buildUnraidPostSwitchEvidenceReviewInputError,
  formatUnraidPostSwitchEvidenceReviewJson,
  formatUnraidPostSwitchEvidenceReviewText,
  parseUnraidPostSwitchEvidenceReviewJson,
  unraidPostSwitchEvidenceReviewHasFailures,
  type UnraidPostSwitchEvidenceReviewInputErrorCode,
} from './unraid-post-switch-evidence-review.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidPostSwitchEvidenceReviewInputErrorCode): never {
  const report = buildUnraidPostSwitchEvidenceReviewInputError(code);
  process.stdout.write(process.argv.includes('--json')
    ? formatUnraidPostSwitchEvidenceReviewJson(report)
    : formatUnraidPostSwitchEvidenceReviewText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('POST_SWITCH_EVIDENCE_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('POST_SWITCH_EVIDENCE_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('POST_SWITCH_EVIDENCE_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('POST_SWITCH_EVIDENCE_FILE_READ_FAILED');
}

const parsed = parseUnraidPostSwitchEvidenceReviewJson(text);
const report = typeof parsed === 'string'
  ? buildUnraidPostSwitchEvidenceReviewInputError(parsed)
  : buildUnraidPostSwitchEvidenceReview(parsed);

process.stdout.write(process.argv.includes('--json')
  ? formatUnraidPostSwitchEvidenceReviewJson(report)
  : formatUnraidPostSwitchEvidenceReviewText(report));
if (unraidPostSwitchEvidenceReviewHasFailures(report)) process.exit(1);
