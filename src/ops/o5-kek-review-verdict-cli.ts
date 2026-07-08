import { readFileSync, statSync } from 'node:fs';
import {
  buildO5KekReviewVerdictInputErrorReport,
  buildO5KekReviewVerdictReport,
  formatO5KekReviewVerdictJson,
  formatO5KekReviewVerdictText,
  o5KekReviewVerdictHasFailures,
  parseO5KekReviewVerdictJson,
  type O5KekReviewVerdictInputErrorCode,
} from './o5-kek-review-verdict.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: O5KekReviewVerdictInputErrorCode): never {
  const report = buildO5KekReviewVerdictInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatO5KekReviewVerdictJson(report) : formatO5KekReviewVerdictText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('VERDICT_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('VERDICT_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('VERDICT_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('VERDICT_FILE_READ_FAILED');
}

const parsed = parseO5KekReviewVerdictJson(text);
const report = typeof parsed === 'string'
  ? buildO5KekReviewVerdictInputErrorReport(parsed)
  : buildO5KekReviewVerdictReport(parsed);

process.stdout.write(process.argv.includes('--json') ? formatO5KekReviewVerdictJson(report) : formatO5KekReviewVerdictText(report));
if (o5KekReviewVerdictHasFailures(report)) process.exit(1);

