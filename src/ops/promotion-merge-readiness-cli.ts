import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildMergeReadiness, type MergeReadinessInput } from './promotion-merge-readiness.js';

// Offline merge-readiness DRY-RUN CLI. Reports whether the local evidence preconditions for a merge are
// met, without performing, staging, or authorizing any merge/tag/master. Never promotes, never touches the
// real Movies root, never contacts Jellyfin, runs no git action.

function usage(): string {
  return [
    'usage: ops:promotion-merge-readiness --releasechecklist <f> [--finalsummary <f>] [--out <manifest.json>]',
    '',
    'Local, non-live DRY RUN: MERGE_DRY_RUN_READY only when the release checklist is CLEARED (and any supplied',
    'final summary is READY). It performs NO merge/tag/master and authorizes NOTHING live or Phase 231.',
    'Exit 0 = MERGE_DRY_RUN_READY, 1 = MERGE_DRY_RUN_BLOCKED.',
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
  const map: Array<[keyof MergeReadinessInput, string]> = [
    ['releaseChecklist', '--releasechecklist'], ['finalSummary', '--finalsummary'],
  ];
  const input: MergeReadinessInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const manifest = buildMergeReadiness(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-merge-readiness-dry-run-capture',
    overall: manifest.overall,
    authorization: manifest.authorization,
    redactionSafe: true,
    dryRun: manifest.dryRun,
    mergeActionsPerformed: manifest.mergeActionsPerformed,
    checks: manifest.checks,
    blockers: manifest.blockers,
    manifestDigest: manifest.manifestDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return manifest.overall === 'MERGE_DRY_RUN_READY' ? 0 : 1;
}

process.exit(main());
