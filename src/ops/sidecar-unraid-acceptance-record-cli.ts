import { readFileSync, statSync } from 'node:fs';
import {
  buildSidecarUnraidAcceptanceInputErrorReport,
  buildSidecarUnraidAcceptanceReport,
  formatSidecarUnraidAcceptanceJson,
  formatSidecarUnraidAcceptanceText,
  parseSidecarUnraidAcceptanceJson,
  sidecarUnraidAcceptanceHasFailures,
  type SidecarUnraidAcceptanceInputErrorCode,
} from './sidecar-unraid-acceptance-record.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: SidecarUnraidAcceptanceInputErrorCode): never {
  const report = buildSidecarUnraidAcceptanceInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidAcceptanceJson(report) : formatSidecarUnraidAcceptanceText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('ACCEPTANCE_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('ACCEPTANCE_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('ACCEPTANCE_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('ACCEPTANCE_FILE_READ_FAILED');
}

const parsed = parseSidecarUnraidAcceptanceJson(text);
const report = typeof parsed === 'string'
  ? buildSidecarUnraidAcceptanceInputErrorReport(parsed)
  : buildSidecarUnraidAcceptanceReport(parsed);

process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidAcceptanceJson(report) : formatSidecarUnraidAcceptanceText(report));
if (sidecarUnraidAcceptanceHasFailures(report)) process.exit(1);
