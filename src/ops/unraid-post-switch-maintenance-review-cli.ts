import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidPostSwitchMaintenanceReview,
  buildUnraidPostSwitchMaintenanceReviewInputError,
  formatUnraidPostSwitchMaintenanceReviewJson,
  formatUnraidPostSwitchMaintenanceReviewText,
  parseUnraidPostSwitchMaintenanceReviewJson,
  unraidPostSwitchMaintenanceReviewHasFailures,
  type UnraidPostSwitchMaintenanceReviewInputErrorCode,
} from './unraid-post-switch-maintenance-review.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidPostSwitchMaintenanceReviewInputErrorCode): never {
  const report = buildUnraidPostSwitchMaintenanceReviewInputError(code);
  process.stdout.write(process.argv.includes('--json')
    ? formatUnraidPostSwitchMaintenanceReviewJson(report)
    : formatUnraidPostSwitchMaintenanceReviewText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('POST_SWITCH_MAINTENANCE_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('POST_SWITCH_MAINTENANCE_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('POST_SWITCH_MAINTENANCE_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('POST_SWITCH_MAINTENANCE_FILE_READ_FAILED');
}

const parsed = parseUnraidPostSwitchMaintenanceReviewJson(text);
const report = typeof parsed === 'string'
  ? buildUnraidPostSwitchMaintenanceReviewInputError(parsed)
  : buildUnraidPostSwitchMaintenanceReview(parsed);

process.stdout.write(process.argv.includes('--json')
  ? formatUnraidPostSwitchMaintenanceReviewJson(report)
  : formatUnraidPostSwitchMaintenanceReviewText(report));
if (unraidPostSwitchMaintenanceReviewHasFailures(report)) process.exit(1);
