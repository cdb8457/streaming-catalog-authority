import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidRestartPersistenceReview,
  buildUnraidRestartPersistenceReviewInputError,
  formatUnraidRestartPersistenceReviewJson,
  formatUnraidRestartPersistenceReviewText,
  parseUnraidRestartPersistenceReviewJson,
  unraidRestartPersistenceReviewHasFailures,
  type UnraidRestartPersistenceReviewInputErrorCode,
} from './unraid-restart-persistence-review.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidRestartPersistenceReviewInputErrorCode): never {
  const report = buildUnraidRestartPersistenceReviewInputError(code);
  process.stdout.write(process.argv.includes('--json')
    ? formatUnraidRestartPersistenceReviewJson(report)
    : formatUnraidRestartPersistenceReviewText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('UNRAID_RESTART_PERSISTENCE_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('UNRAID_RESTART_PERSISTENCE_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('UNRAID_RESTART_PERSISTENCE_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('UNRAID_RESTART_PERSISTENCE_FILE_READ_FAILED');
}

const parsed = parseUnraidRestartPersistenceReviewJson(text);
const report = typeof parsed === 'string'
  ? buildUnraidRestartPersistenceReviewInputError(parsed)
  : buildUnraidRestartPersistenceReview(parsed);

process.stdout.write(process.argv.includes('--json')
  ? formatUnraidRestartPersistenceReviewJson(report)
  : formatUnraidRestartPersistenceReviewText(report));
if (unraidRestartPersistenceReviewHasFailures(report)) process.exit(1);
