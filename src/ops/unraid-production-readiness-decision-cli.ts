import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidProductionReadinessDecisionReport,
  formatUnraidProductionReadinessDecisionJson,
} from './unraid-production-readiness-decision.js';

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
  const report = buildUnraidProductionReadinessDecisionReport(readJson(argValue('--validation-review')), readJson(argValue('--decision')));
  process.stdout.write(formatUnraidProductionReadinessDecisionJson(report));
  if (report.productionReadinessDecisionStatus !== 'ready-for-final-human-production-approval') process.exit(1);
} catch {
  process.stdout.write(formatUnraidProductionReadinessDecisionJson(buildUnraidProductionReadinessDecisionReport({}, {})));
  process.exit(1);
}
