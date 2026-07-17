import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildTerminalClosure, type TerminalClosureInput } from './promotion-terminal-closure.js';

// Offline terminal closure manifest CLI. Ties all local evidence into one terminal record for coordinator
// review -- never an approval, merge, or live promotion. Never touches the real Movies root, never contacts
// Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-terminal-closure --transcriptverification <f> --evidenceminimizer <f> --commitrangeclosure <f> --regressionoracle <f> --coordinatorreadiness <f> [--out <manifest.json>]',
    '',
    'Local, non-live: TERMINAL_CLOSURE_CONFIRMED only when every component is present, valid, green, and',
    'digest-bound. CONFIRMED is NOT an approval and does not authorize Phase 231 or any merge.',
    'Exit 0 = CONFIRMED, 1 = NOT_CONFIRMED.',
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
  const map: Array<[keyof TerminalClosureInput, string]> = [
    ['transcriptVerification', '--transcriptverification'], ['evidenceMinimizer', '--evidenceminimizer'], ['commitRangeClosure', '--commitrangeclosure'],
    ['regressionOracle', '--regressionoracle'], ['coordinatorReadiness', '--coordinatorreadiness'],
  ];
  const input: TerminalClosureInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const manifest = buildTerminalClosure(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-terminal-closure-manifest-capture',
    overall: manifest.overall,
    authorization: manifest.authorization,
    redactionSafe: true,
    components: manifest.components,
    boundDigests: manifest.boundDigests,
    humanGates: manifest.humanGates,
    boundary: manifest.boundary,
    blockers: manifest.blockers,
    terminalDigest: manifest.terminalDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return manifest.overall === 'TERMINAL_CLOSURE_CONFIRMED' ? 0 : 1;
}

process.exit(main());
