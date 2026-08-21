import { readFileSync } from 'node:fs';

import { buildPhase15Plan, type Phase15EntryState } from '../core/projection/phase15.js';

const usage = 'usage: ops:projection-phase15-plan --input <entry-and-changed-paths.json> [--json]';

function parseInput(input: unknown): { entry: Phase15EntryState; changedPaths: readonly string[] } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('NOT_AN_OBJECT');
  const obj = input as Record<string, unknown>;
  if (Object.keys(obj).some((key) => key !== 'entry' && key !== 'changedPaths')) throw new Error('UNKNOWN_FIELD');
  if (obj.entry === null || typeof obj.entry !== 'object' || Array.isArray(obj.entry)) throw new Error('ENTRY_INVALID');
  const entry = obj.entry as Record<string, unknown>;
  const allowed = new Set(['phase14Disposition', 'phase14OpenClaimsRecorded', 'phase14WindowsRecorded', 'earlierFrozenCandidatesRecorded']);
  if (Object.keys(entry).some((key) => !allowed.has(key))) throw new Error('ENTRY_UNKNOWN_FIELD');
  if (entry.phase14Disposition !== 'go' && entry.phase14Disposition !== 'preflight-issued' && entry.phase14Disposition !== 'missing') throw new Error('DISPOSITION_INVALID');
  for (const key of ['phase14OpenClaimsRecorded', 'phase14WindowsRecorded', 'earlierFrozenCandidatesRecorded']) {
    if (typeof entry[key] !== 'boolean') throw new Error('ENTRY_NON_BOOLEAN');
  }
  if (!Array.isArray(obj.changedPaths) || obj.changedPaths.some((path) => typeof path !== 'string')) throw new Error('CHANGED_PATHS_INVALID');
  return { entry: entry as unknown as Phase15EntryState, changedPaths: Object.freeze([...obj.changedPaths]) as readonly string[] };
}

export function main(argv: readonly string[]): number {
  let inputPath: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--help') { console.log(usage); return 0; }
    if (arg === '--input' && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) { inputPath = argv[++i]; continue; }
    console.error(usage); return 2;
  }
  if (inputPath === undefined) { console.error(usage); return 2; }
  try {
    const input = parseInput(JSON.parse(readFileSync(inputPath, 'utf8')));
    const report = buildPhase15Plan(input.entry, input.changedPaths);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('Projection Phase 15 — release plan');
      console.log(`status: ${report.status}`);
      console.log(`soak required: ${report.soakRequired ? 'yes' : 'no'}`);
      for (const refusal of report.entryRefusals) console.log(`  ${refusal}`);
      console.log('Phase 15 run: no; Phase 15 closed: no; maintenance authorization still required');
    }
    return report.status === 'READY_TO_PREPARE' ? 0 : 3;
  } catch {
    console.error('INPUT_REFUSED: the plan input is not the closed boolean/path-shape schema');
    return 4;
  }
}

if (process.argv[1]?.endsWith('projection-phase15-plan-cli.ts')) process.exitCode = main(process.argv.slice(2));

