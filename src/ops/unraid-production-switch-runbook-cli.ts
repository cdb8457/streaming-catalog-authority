import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidProductionSwitchRunbook,
  buildUnraidProductionSwitchRunbookInputError,
  formatUnraidProductionSwitchRunbookJson,
  formatUnraidProductionSwitchRunbookText,
  parseUnraidProductionSwitchRunbookJson,
  unraidProductionSwitchRunbookHasFailures,
  type UnraidProductionSwitchRunbookInputErrorCode,
} from './unraid-production-switch-runbook.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidProductionSwitchRunbookInputErrorCode): never {
  const packet = buildUnraidProductionSwitchRunbookInputError(code);
  process.stdout.write(process.argv.includes('--json')
    ? formatUnraidProductionSwitchRunbookJson(packet)
    : formatUnraidProductionSwitchRunbookText(packet));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('PRODUCTION_SWITCH_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('PRODUCTION_SWITCH_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('PRODUCTION_SWITCH_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('PRODUCTION_SWITCH_FILE_READ_FAILED');
}

const parsed = parseUnraidProductionSwitchRunbookJson(text);
const packet = typeof parsed === 'string'
  ? buildUnraidProductionSwitchRunbookInputError(parsed)
  : buildUnraidProductionSwitchRunbook(parsed);

process.stdout.write(process.argv.includes('--json')
  ? formatUnraidProductionSwitchRunbookJson(packet)
  : formatUnraidProductionSwitchRunbookText(packet));
if (unraidProductionSwitchRunbookHasFailures(packet)) process.exit(1);
