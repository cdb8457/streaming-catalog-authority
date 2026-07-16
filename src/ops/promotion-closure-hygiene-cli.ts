import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClosureHygiene } from './promotion-closure-hygiene.js';

// Offline closure / dependency hygiene CLI. Confirms the gate DAG, blocker taxonomy, op registry, and
// wiring surfaces are mutually consistent. Never promotes, never touches the real Movies root, never
// contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-closure-hygiene [--out <hygiene.json>]',
    '',
    'Local, non-live: HYGIENE_OK when the DAG is acyclic, every gate blocker is catalogued, every taxonomy',
    'op is a real node, and every registered op is fully wired. It authorizes NOTHING live and does not',
    'authorize Phase 231. Exit 0 = HYGIENE_OK, 1 = HYGIENE_VIOLATION.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const report = buildClosureHygiene(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-closure-hygiene-capture',
    overall: report.overall,
    authorization: report.authorization,
    redactionSafe: true,
    checks: report.checks,
    problems: report.problems,
    hygieneDigest: report.hygieneDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.overall === 'HYGIENE_OK' ? 0 : 1;
}

process.exit(main());
