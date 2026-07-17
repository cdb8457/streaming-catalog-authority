import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCliErgonomics } from './promotion-cli-ergonomics.js';

// Offline CLI ergonomics guard CLI. Verifies every registered op's CLI defines usage() and handles --help.
// Never promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-cli-ergonomics [--out <ergonomics.json>]',
    '',
    'Local, non-live: CLI_ERGONOMICS_OK when every registered CLI defines usage() and handles --help. It',
    'authorizes NOTHING live and does not authorize Phase 231. Exit 0 = OK, 1 = GAP.',
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
  const ergonomics = buildCliErgonomics(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(ergonomics, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-cli-ergonomics-capture',
    overall: ergonomics.overall,
    authorization: ergonomics.authorization,
    redactionSafe: true,
    cliCount: ergonomics.cliCount,
    gaps: ergonomics.gaps,
    ergonomicsDigest: ergonomics.ergonomicsDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return ergonomics.overall === 'CLI_ERGONOMICS_OK' ? 0 : 1;
}

process.exit(main());
