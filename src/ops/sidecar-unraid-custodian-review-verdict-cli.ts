import { readFileSync, statSync } from 'node:fs';
import {
  buildSidecarUnraidCustodianReviewVerdictInputErrorReport,
  buildSidecarUnraidCustodianReviewVerdictReport,
  formatSidecarUnraidCustodianReviewVerdictJson,
  formatSidecarUnraidCustodianReviewVerdictText,
  parseSidecarUnraidCustodianReviewVerdictJson,
  sidecarUnraidCustodianReviewVerdictHasFailures,
  type SidecarUnraidCustodianReviewVerdictInputErrorCode,
} from './sidecar-unraid-custodian-review-verdict.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: SidecarUnraidCustodianReviewVerdictInputErrorCode): never {
  const report = buildSidecarUnraidCustodianReviewVerdictInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidCustodianReviewVerdictJson(report) : formatSidecarUnraidCustodianReviewVerdictText(report));
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

const parsed = parseSidecarUnraidCustodianReviewVerdictJson(text);
const report = typeof parsed === 'string'
  ? buildSidecarUnraidCustodianReviewVerdictInputErrorReport(parsed)
  : buildSidecarUnraidCustodianReviewVerdictReport(parsed);

process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidCustodianReviewVerdictJson(report) : formatSidecarUnraidCustodianReviewVerdictText(report));
if (sidecarUnraidCustodianReviewVerdictHasFailures(report)) process.exit(1);
