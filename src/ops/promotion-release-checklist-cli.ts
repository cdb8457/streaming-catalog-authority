import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReleaseChecklist, type ReleaseChecklistInput } from './promotion-release-checklist.js';

// Offline coordinator evidence release checklist CLI. Composes the final summary, negative-evidence
// corpus, closure hygiene, and (optional) self-digest verification into a go/no-go release checklist.
// Never promotes, never touches the real Movies root, never contacts Jellyfin, never merges.

function usage(): string {
  return [
    'usage: ops:promotion-release-checklist --finalsummary <f> --negativecorpus <f> --closurehygiene <f> [--selfdigest <f>] [--out <checklist.json>]',
    '',
    'Local, non-live: RELEASE_CHECKLIST_CLEARED only when every required item is present, valid, and passing.',
    'Clearing it authorizes NOTHING live, no merge, and does not authorize Phase 231. Exit 0 = CLEARED, 1 = BLOCKED.',
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
  const map: Array<[keyof ReleaseChecklistInput, string]> = [
    ['finalSummary', '--finalsummary'], ['negativeCorpus', '--negativecorpus'], ['closureHygiene', '--closurehygiene'], ['selfDigest', '--selfdigest'],
  ];
  const input: ReleaseChecklistInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const checklist = buildReleaseChecklist(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(checklist, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-coordinator-release-checklist-capture',
    overall: checklist.overall,
    authorization: checklist.authorization,
    redactionSafe: true,
    items: checklist.items,
    blockers: checklist.blockers,
    checklistDigest: checklist.checklistDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return checklist.overall === 'RELEASE_CHECKLIST_CLEARED' ? 0 : 1;
}

process.exit(main());
