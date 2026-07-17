import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReviewAutomation, type ReviewAutomationInput } from './promotion-review-automation.js';

// Offline coordinator review automation CLI. Composes the chain bundle, redaction corpus, and boundary
// policy into one automated-vs-manual review checklist. Never promotes, never touches the real Movies
// root, never contacts Jellyfin, never merges.

function usage(): string {
  return [
    'usage: ops:promotion-review-automation --chainbundle <f> --redactioncorpus <f> --boundarypolicy <f> [--out <automation.json>]',
    '',
    'Local, non-live: REVIEW_AUTOMATION_PASSED only when every automated input is present, valid, green, and',
    'digest-bound. Passing is NOT an approval -- the manual steps stay human. It authorizes NOTHING live and',
    'does not authorize Phase 231. Exit 0 = PASSED, 1 = BLOCKED.',
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
  const map: Array<[keyof ReviewAutomationInput, string]> = [
    ['chainBundle', '--chainbundle'], ['redactionCorpus', '--redactioncorpus'], ['boundaryPolicy', '--boundarypolicy'],
  ];
  const input: ReviewAutomationInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const automation = buildReviewAutomation(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(automation, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-review-automation-capture',
    overall: automation.overall,
    authorization: automation.authorization,
    redactionSafe: true,
    automatedChecks: automation.automatedChecks,
    boundDigests: automation.boundDigests,
    manualSteps: automation.manualSteps,
    blockers: automation.blockers,
    automationDigest: automation.automationDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return automation.overall === 'REVIEW_AUTOMATION_PASSED' ? 0 : 1;
}

process.exit(main());
