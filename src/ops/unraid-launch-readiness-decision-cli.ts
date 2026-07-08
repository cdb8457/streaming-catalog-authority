import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidLaunchReadinessDecision,
  buildUnraidLaunchReadinessDecisionInputError,
  formatUnraidLaunchReadinessDecisionJson,
  formatUnraidLaunchReadinessDecisionText,
  parseUnraidLaunchReadinessDecisionJson,
  unraidLaunchReadinessDecisionHasFailures,
  type UnraidLaunchReadinessDecisionInputErrorCode,
} from './unraid-launch-readiness-decision.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidLaunchReadinessDecisionInputErrorCode): never {
  const report = buildUnraidLaunchReadinessDecisionInputError(code);
  process.stdout.write(process.argv.includes('--json') ? formatUnraidLaunchReadinessDecisionJson(report) : formatUnraidLaunchReadinessDecisionText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('LAUNCH_READINESS_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('LAUNCH_READINESS_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('LAUNCH_READINESS_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('LAUNCH_READINESS_FILE_READ_FAILED');
}

const parsed = parseUnraidLaunchReadinessDecisionJson(text);
const report = typeof parsed === 'string' ? buildUnraidLaunchReadinessDecisionInputError(parsed) : buildUnraidLaunchReadinessDecision(parsed);
process.stdout.write(process.argv.includes('--json') ? formatUnraidLaunchReadinessDecisionJson(report) : formatUnraidLaunchReadinessDecisionText(report));
if (unraidLaunchReadinessDecisionHasFailures(report)) process.exit(1);
