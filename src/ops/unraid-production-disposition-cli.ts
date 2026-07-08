import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidProductionDisposition,
  buildUnraidProductionDispositionInputError,
  formatUnraidProductionDispositionJson,
  formatUnraidProductionDispositionText,
  parseUnraidProductionDispositionJson,
  unraidProductionDispositionHasFailures,
  type UnraidProductionDispositionInputErrorCode,
} from './unraid-production-disposition.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidProductionDispositionInputErrorCode): never {
  const report = buildUnraidProductionDispositionInputError(code);
  process.stdout.write(process.argv.includes('--json') ? formatUnraidProductionDispositionJson(report) : formatUnraidProductionDispositionText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('PRODUCTION_DISPOSITION_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('PRODUCTION_DISPOSITION_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('PRODUCTION_DISPOSITION_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('PRODUCTION_DISPOSITION_FILE_READ_FAILED');
}

const parsed = parseUnraidProductionDispositionJson(text);
const report = typeof parsed === 'string' ? buildUnraidProductionDispositionInputError(parsed) : buildUnraidProductionDisposition(parsed);
process.stdout.write(process.argv.includes('--json') ? formatUnraidProductionDispositionJson(report) : formatUnraidProductionDispositionText(report));
if (unraidProductionDispositionHasFailures(report)) process.exit(1);
