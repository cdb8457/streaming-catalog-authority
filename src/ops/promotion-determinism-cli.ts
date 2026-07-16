import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assessDeterminism, type DeterminismSubject } from './promotion-determinism.js';

// Offline determinism stress CLI. Reads a subjects file ({ "subjects": [{ "subject", "digests": [...] }] })
// and reports whether every subject's repeated digests are identical. Never promotes, never touches the
// real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-determinism --in <subjects.json> [--out <report.json>]',
    '',
    'Local, non-live: DETERMINISTIC only when every subject has >=2 samples that are all identical.',
    'It authorizes NOTHING live and does not authorize Phase 231. Exit 0 = DETERMINISTIC, 1 = otherwise.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const inPath = valueAfter(args, '--in');
  const out = valueAfter(args, '--out');
  if (inPath === undefined) { console.error(usage()); return 2; }
  let subjects: DeterminismSubject[];
  try {
    const parsed = JSON.parse(readFileSync(inPath, 'utf8')) as { subjects?: DeterminismSubject[] };
    subjects = Array.isArray(parsed.subjects) ? parsed.subjects : [];
  } catch { console.error('--in file is missing or not valid JSON'); return 2; }
  const report = assessDeterminism(subjects);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-determinism-stress-capture',
    overall: report.overall,
    authorization: report.authorization,
    redactionSafe: true,
    results: report.results,
    nonDeterministic: report.nonDeterministic,
    determinismDigest: report.determinismDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.overall === 'DETERMINISTIC' ? 0 : 1;
}

process.exit(main());
