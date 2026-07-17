import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildChangelog, type ChangelogInput } from './promotion-changelog.js';

// Offline changelog CLI. Reads a commit list from an input JSON (produced locally, e.g. via
// `git log --format=...`) and emits a redaction-safe changelog. Never promotes, never touches the real
// Movies root, never contacts Jellyfin, and does no git/process I/O itself.

function usage(): string {
  return [
    'usage: ops:promotion-changelog --input <commits.json> [--out <changelog.json>]',
    '',
    'The input JSON carries { commits: [{ sha, subject }] }. Local, non-live: emits a redaction-safe',
    'changelog with a no-live / no-Phase-231 footer. Exit 0 = ok, 1 = a problem (e.g. a raw path in a subject).',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const inputPath = valueAfter(args, '--input');
  const out = valueAfter(args, '--out');
  if (!inputPath) { console.error(usage()); return 2; }
  let input: ChangelogInput;
  try {
    const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
    input = parsed && typeof parsed === 'object' ? parsed as ChangelogInput : {};
  } catch { console.error('input file is missing or not valid JSON'); return 2; }
  const changelog = buildChangelog(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(changelog, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-changelog-capture',
    ok: changelog.ok,
    authorization: changelog.authorization,
    redactionSafe: true,
    count: changelog.count,
    problems: changelog.problems,
    changelogDigest: changelog.changelogDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return changelog.ok ? 0 : 1;
}

process.exit(main());
