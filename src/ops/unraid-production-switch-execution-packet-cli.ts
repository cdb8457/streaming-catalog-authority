import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidProductionSwitchExecutionPacket,
  buildUnraidProductionSwitchExecutionPacketInputError,
  formatUnraidProductionSwitchExecutionPacketJson,
  formatUnraidProductionSwitchExecutionPacketText,
  parseUnraidProductionSwitchExecutionPacketJson,
  unraidProductionSwitchExecutionPacketHasFailures,
  type UnraidProductionSwitchExecutionPacketInputErrorCode,
} from './unraid-production-switch-execution-packet.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidProductionSwitchExecutionPacketInputErrorCode): never {
  const report = buildUnraidProductionSwitchExecutionPacketInputError(code);
  process.stdout.write(process.argv.includes('--json')
    ? formatUnraidProductionSwitchExecutionPacketJson(report)
    : formatUnraidProductionSwitchExecutionPacketText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('PRODUCTION_SWITCH_EXECUTION_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('PRODUCTION_SWITCH_EXECUTION_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('PRODUCTION_SWITCH_EXECUTION_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('PRODUCTION_SWITCH_EXECUTION_FILE_READ_FAILED');
}

const parsed = parseUnraidProductionSwitchExecutionPacketJson(text);
const report = typeof parsed === 'string'
  ? buildUnraidProductionSwitchExecutionPacketInputError(parsed)
  : buildUnraidProductionSwitchExecutionPacket(parsed);

process.stdout.write(process.argv.includes('--json')
  ? formatUnraidProductionSwitchExecutionPacketJson(report)
  : formatUnraidProductionSwitchExecutionPacketText(report));
if (unraidProductionSwitchExecutionPacketHasFailures(report)) process.exit(1);
