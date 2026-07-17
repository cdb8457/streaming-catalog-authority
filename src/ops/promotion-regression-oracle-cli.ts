import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegressionOracle } from './promotion-regression-oracle.js';

// Offline regression oracle index CLI. Maps every coordinator-discovered regression to its guard blocker +
// repro test and confirms each mapping is live. Never promotes, never touches the real Movies root, never
// contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-regression-oracle [--out <oracle.json>]',
    '',
    'Local, non-live: ORACLE_COMPLETE when every finding maps to a catalogued blocker and an existing repro',
    'test. It authorizes NOTHING live and does not authorize Phase 231. Exit 0 = COMPLETE, 1 = INCOMPLETE.',
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
  const oracle = buildRegressionOracle(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(oracle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-regression-oracle-capture',
    overall: oracle.overall,
    authorization: oracle.authorization,
    redactionSafe: true,
    count: oracle.count,
    entries: oracle.entries,
    gaps: oracle.gaps,
    oracleDigest: oracle.oracleDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return oracle.overall === 'ORACLE_COMPLETE' ? 0 : 1;
}

process.exit(main());
