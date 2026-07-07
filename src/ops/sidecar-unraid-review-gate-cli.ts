import { readFileSync, statSync } from 'node:fs';
import {
  buildSidecarUnraidReviewGateInputErrorReport,
  buildSidecarUnraidReviewGateReport,
  formatSidecarUnraidReviewGateJson,
  formatSidecarUnraidReviewGateText,
  parseSidecarUnraidEvidenceBundleJson,
  sidecarUnraidReviewGateHasFailures,
  type SidecarUnraidReviewGateInputErrorCode,
} from './sidecar-unraid-review-gate.js';

const MAX_INPUT_BYTES = 64 * 1024;

function main(): void {
  const json = process.argv.includes('--json');
  const inputPath = process.argv.filter((arg) => arg !== '--' && arg !== '--json').slice(2)[0];
  const report = inputPath
    ? buildFromPath(inputPath)
    : buildSidecarUnraidReviewGateInputErrorReport('REVIEW_GATE_INPUT_REQUIRED');

  process.stdout.write(json ? formatSidecarUnraidReviewGateJson(report) : formatSidecarUnraidReviewGateText(report));
  if (sidecarUnraidReviewGateHasFailures(report)) process.exit(1);
}

function buildFromPath(inputPath: string) {
  let text: string;
  try {
    if (statSync(inputPath).size > MAX_INPUT_BYTES) return buildSidecarUnraidReviewGateInputErrorReport('REVIEW_GATE_FILE_TOO_LARGE');
    text = readFileSync(inputPath, 'utf8');
  } catch {
    return buildSidecarUnraidReviewGateInputErrorReport('REVIEW_GATE_FILE_READ_FAILED');
  }
  const parsed = parseSidecarUnraidEvidenceBundleJson(text);
  if (typeof parsed === 'string') return buildSidecarUnraidReviewGateInputErrorReport(parsed as SidecarUnraidReviewGateInputErrorCode);
  return buildSidecarUnraidReviewGateReport(parsed);
}

main();
