import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidPostInstallValidationReviewReport,
  formatUnraidPostInstallValidationReviewJson,
} from './unraid-post-install-validation-review.js';

const MAX_INPUT_BYTES = 64 * 1024;
const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
function readJson(path: string | undefined): Record<string, unknown> {
  if (!path || path.startsWith('--')) throw new Error('input-required');
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('input-unreadable');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object-required');
  return parsed as Record<string, unknown>;
}
try {
  const report = buildUnraidPostInstallValidationReviewReport(readJson(argValue('--evidence-gate')), readJson(argValue('--review')));
  process.stdout.write(formatUnraidPostInstallValidationReviewJson(report));
  if (report.postInstallValidationStatus !== 'ready-for-production-readiness-decision') process.exit(1);
} catch {
  process.stdout.write(formatUnraidPostInstallValidationReviewJson(buildUnraidPostInstallValidationReviewReport({}, {})));
  process.exit(1);
}
