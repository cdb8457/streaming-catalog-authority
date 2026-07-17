import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReviewerPack, type ReviewerPackInput } from './promotion-reviewer-pack.js';

// Offline merge-review evidence pack CLI. Assembles the seven closing records into one digest-bound
// reviewer pack. Never promotes, never touches the real Movies root, never contacts Jellyfin, never merges.

function usage(): string {
  return [
    'usage: ops:promotion-reviewer-pack --finalsummary <f> --releasechecklist <f> --mergereadiness <f> --chainbundle <f> --reviewautomation <f> --redactioncorpus <f> --boundarypolicy <f> [--out <pack.json>]',
    '',
    'Local, non-live: REVIEWER_PACK_READY only when every component is present, valid, green, digest-bound,',
    'and the whole mesh binds to one run. It authorizes NOTHING live and does not authorize Phase 231.',
    'Exit 0 = READY, 1 = BLOCKED.',
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
  const map: Array<[keyof ReviewerPackInput, string]> = [
    ['finalSummary', '--finalsummary'], ['releaseChecklist', '--releasechecklist'], ['mergeReadiness', '--mergereadiness'],
    ['chainBundle', '--chainbundle'], ['reviewAutomation', '--reviewautomation'], ['redactionCorpus', '--redactioncorpus'], ['boundaryPolicy', '--boundarypolicy'],
  ];
  const input: ReviewerPackInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const pack = buildReviewerPack(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(pack, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-merge-review-evidence-pack-capture',
    overall: pack.overall,
    authorization: pack.authorization,
    redactionSafe: true,
    components: pack.components.map((c) => ({ component: c.component, present: c.present, ok: c.ok })),
    bindings: pack.bindings,
    blockers: pack.blockers,
    packDigest: pack.packDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return pack.overall === 'REVIEWER_PACK_READY' ? 0 : 1;
}

process.exit(main());
