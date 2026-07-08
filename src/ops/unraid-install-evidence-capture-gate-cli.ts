import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidInstallEvidenceCaptureReport,
  formatUnraidInstallEvidenceCaptureJson,
} from './unraid-install-evidence-capture-gate.js';

const MAX_INPUT_BYTES = 64 * 1024;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(path: string | undefined): Record<string, unknown> {
  if (!path || path.startsWith('--')) throw new Error('input-required');
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('input-unreadable');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object-required');
  return parsed as Record<string, unknown>;
}

try {
  const report = buildUnraidInstallEvidenceCaptureReport(readJson(argValue('--manifest')), readJson(argValue('--evidence')));
  process.stdout.write(formatUnraidInstallEvidenceCaptureJson(report));
  if (report.installEvidenceStatus !== 'complete-ready-for-post-install-review') process.exit(1);
} catch {
  process.stdout.write(formatUnraidInstallEvidenceCaptureJson(buildUnraidInstallEvidenceCaptureReport({}, {})));
  process.exit(1);
}
