import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildBlockerTaxonomy } from './promotion-blocker-taxonomy.js';

// Offline blocker taxonomy CLI. Emits the declared catalogue of Phase 230 blocker codes, grouped by
// category and attributed to the raising op. Never promotes, never touches the real Movies root, never
// contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-blocker-taxonomy [--out <taxonomy.json>]',
    '',
    'Local, non-live: TAXONOMY_CONSISTENT when every code is well-formed, attributed, and unique per op.',
    'It authorizes NOTHING live and does not authorize Phase 231. Exit 0 = CONSISTENT, 1 = INCONSISTENT.',
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
  const taxonomy = buildBlockerTaxonomy();
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(taxonomy, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-blocker-taxonomy-capture',
    overall: taxonomy.overall,
    authorization: taxonomy.authorization,
    redactionSafe: true,
    count: taxonomy.count,
    categories: taxonomy.categories,
    problems: taxonomy.problems,
    taxonomyDigest: taxonomy.taxonomyDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return taxonomy.overall === 'TAXONOMY_CONSISTENT' ? 0 : 1;
}

process.exit(main());
