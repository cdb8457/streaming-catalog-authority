import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildProvenanceDiff, type ProvenanceDiffInput, type ProvenanceContext } from './promotion-provenance-diff.js';

// Offline evidence provenance diff CLI. Aligns the dry-run context (branch/base/head/commits) against the
// review transcript and optional final summary / review bundle. Reads the context from a file -- invokes no
// git. Never promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-provenance-diff --context <f> --transcript <f> [--finalsummary <f>] [--reviewbundle <f>] [--out <diff.json>]',
    '',
    'The context file is { branch, base, head, commits:[{sha,subject}] }.',
    'Local, non-live: PROVENANCE_ALIGNED only when head == reviewedCommit, the reviewed commit is in range,',
    'and supplied artifacts bind. Fails closed on any mismatch/missing/malformed/leak. Exit 0 = ALIGNED, 1 = MISALIGNED.',
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
  const input: ProvenanceDiffInput = {};
  try {
    const ctx = valueAfter(args, '--context');
    if (ctx !== undefined) (input as { context?: ProvenanceContext }).context = readJson(ctx, 'context') as ProvenanceContext;
    const tr = valueAfter(args, '--transcript');
    if (tr !== undefined) (input as { transcript?: unknown }).transcript = readJson(tr, 'transcript');
    const fs = valueAfter(args, '--finalsummary');
    if (fs !== undefined) (input as { finalSummary?: unknown }).finalSummary = readJson(fs, 'finalSummary');
    const rb = valueAfter(args, '--reviewbundle');
    if (rb !== undefined) (input as { reviewBundle?: unknown }).reviewBundle = readJson(rb, 'reviewBundle');
  } catch (err) { console.error((err as Error).message); return 2; }
  const diff = buildProvenanceDiff(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(diff, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-provenance-diff-capture',
    overall: diff.overall,
    authorization: diff.authorization,
    redactionSafe: true,
    base: diff.base,
    head: diff.head,
    reviewedCommit: diff.reviewedCommit,
    commitCount: diff.commitCount,
    checks: diff.checks,
    blockers: diff.blockers,
    diffDigest: diff.diffDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return diff.overall === 'PROVENANCE_ALIGNED' ? 0 : 1;
}

process.exit(main());
