import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewChecklistV2, type ReviewChecklistV2Input } from './promotion-review-checklist-v2.js';

// Offline coordinator review checklist v2 CLI. Aggregates closure-summary-v3 + closure-input-bundle-audit +
// live-boundary suite status + local test command labels + human-only remaining steps into one redaction-safe
// checklist. It authorizes nothing (status PENDING). Never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-review-checklist-v2 --closuresummary <f> --bundleaudit <f> [--out <checklist.json>]',
    '',
    'Local, non-live: CHECKLIST_READY when the closure summary v3 is READY, the closure-input bundle audit is',
    'VERIFIED, the live-boundary guard is in the local suite, and the local test commands are listed. It does',
    'NOT approve anything and does not authorize Phase 231. Exit 0 = READY, 1 = BLOCKED.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}
function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} file is missing or not valid JSON`); }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const input: ReviewChecklistV2Input = {};
  try {
    const cs = valueAfter(args, '--closuresummary');
    const ba = valueAfter(args, '--bundleaudit');
    if (cs !== undefined) (input as Record<string, unknown>).closureSummary = readJson(cs, 'closureSummary');
    if (ba !== undefined) (input as Record<string, unknown>).bundleAudit = readJson(ba, 'bundleAudit');
  } catch (err) { console.error((err as Error).message); return 2; }
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const checklist = buildReviewChecklistV2(projectRoot, input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(checklist, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-coordinator-review-checklist-v2-capture',
    overall: checklist.overall,
    authorization: checklist.authorization,
    status: checklist.status,
    redactionSafe: true,
    machineChecks: checklist.machineChecks,
    localTestCommands: checklist.localTestCommands,
    blockers: checklist.blockers,
    checklistV2Digest: checklist.checklistV2Digest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return checklist.overall === 'CHECKLIST_READY' ? 0 : 1;
}

process.exit(main());
