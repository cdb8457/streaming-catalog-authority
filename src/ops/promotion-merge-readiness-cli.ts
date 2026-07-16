import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildMergeReadiness, type MergeReadinessInput, type MergeContext } from './promotion-merge-readiness.js';

// Offline merge-readiness DRY-RUN CLI. Reports whether the local evidence preconditions for a merge are
// met, without performing, staging, or authorizing any merge/tag/master. Reads the branch/base/head and
// commit list from the supplied context file -- it invokes no git. Never promotes, never touches the real
// Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-merge-readiness --releasechecklist <f> --context <f> [--finalsummary <f>] [--out <manifest.json>]',
    '',
    'The context file is { branch, base, head, commits:[{sha,subject}], requiredTests:[...] }.',
    'Local, non-live DRY RUN: MERGE_DRY_RUN_READY only when the release checklist is CLEARED, the context is',
    'well-formed, and any supplied final summary is READY and bound to the checklist. It performs NO',
    'merge/tag/master and authorizes NOTHING live or Phase 231. Exit 0 = READY, 1 = BLOCKED.',
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
  const input: MergeReadinessInput = {};
  try {
    const rc = valueAfter(args, '--releasechecklist');
    if (rc !== undefined) (input as { releaseChecklist?: unknown }).releaseChecklist = readJson(rc, 'releaseChecklist');
    const fs = valueAfter(args, '--finalsummary');
    if (fs !== undefined) (input as { finalSummary?: unknown }).finalSummary = readJson(fs, 'finalSummary');
    const ctx = valueAfter(args, '--context');
    if (ctx !== undefined) (input as { context?: MergeContext }).context = readJson(ctx, 'context') as MergeContext;
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
    gitInvoked: manifest.gitInvoked,
    mergeActionsPerformed: manifest.mergeActionsPerformed,
    branch: manifest.branch,
    base: manifest.base,
    head: manifest.head,
    commitsSinceBase: manifest.commitsSinceBase,
    requiredTests: manifest.requiredTests,
    openBlockers: manifest.openBlockers,
    blockers: manifest.blockers,
    manifestDigest: manifest.manifestDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return manifest.overall === 'MERGE_DRY_RUN_READY' ? 0 : 1;
}

process.exit(main());
