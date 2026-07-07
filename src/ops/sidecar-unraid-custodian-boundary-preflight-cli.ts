import { readFileSync, statSync } from 'node:fs';
import {
  buildSidecarUnraidCustodianBoundaryInputErrorReport,
  buildSidecarUnraidCustodianBoundaryPreflightReport,
  formatSidecarUnraidCustodianBoundaryJson,
  formatSidecarUnraidCustodianBoundaryText,
  parseSidecarUnraidCustodianBoundaryJson,
  sidecarUnraidCustodianBoundaryHasFailures,
  type SidecarUnraidCustodianBoundaryInputErrorCode,
} from './sidecar-unraid-custodian-boundary-preflight.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: SidecarUnraidCustodianBoundaryInputErrorCode): never {
  const report = buildSidecarUnraidCustodianBoundaryInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidCustodianBoundaryJson(report) : formatSidecarUnraidCustodianBoundaryText(report));
  process.exit(1);
}

const inputPaths = process.argv.slice(2).filter((arg) => arg !== '--' && arg !== '--json');
if (inputPaths.length !== 1) inputError('BOUNDARY_INPUT_REQUIRED');
const inputPath = inputPaths[0] as string;

let text: string;
try {
  const stat = statSync(inputPath);
  if (!stat.isFile()) inputError('BOUNDARY_FILE_READ_FAILED');
  if (stat.size > MAX_INPUT_BYTES) inputError('BOUNDARY_FILE_TOO_LARGE');
  text = readFileSync(inputPath, 'utf8');
} catch {
  inputError('BOUNDARY_FILE_READ_FAILED');
}

const parsed = parseSidecarUnraidCustodianBoundaryJson(text);
const report = typeof parsed === 'string'
  ? buildSidecarUnraidCustodianBoundaryInputErrorReport(parsed)
  : buildSidecarUnraidCustodianBoundaryPreflightReport(parsed);

process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidCustodianBoundaryJson(report) : formatSidecarUnraidCustodianBoundaryText(report));
if (sidecarUnraidCustodianBoundaryHasFailures(report)) process.exit(1);
