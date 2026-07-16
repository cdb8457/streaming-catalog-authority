import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildNegativeEvidenceCorpus } from './promotion-negative-evidence-corpus.js';

// Offline negative-evidence adversarial corpus CLI. Runs every adversarial sample through its validator
// and reports whether the validators held (rejected all). Never promotes, never touches the real Movies
// root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-negative-evidence-corpus [--out <corpus.json>]',
    '',
    'Local, non-live: CORPUS_HELD when every adversarial sample is rejected by its validator. It authorizes',
    'NOTHING live and does not authorize Phase 231. Exit 0 = CORPUS_HELD, 1 = CORPUS_BREACHED.',
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
  const corpus = buildNegativeEvidenceCorpus();
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(corpus, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-negative-evidence-corpus-capture',
    overall: corpus.overall,
    authorization: corpus.authorization,
    redactionSafe: true,
    count: corpus.count,
    categories: corpus.categories,
    breaches: corpus.breaches,
    corpusDigest: corpus.corpusDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return corpus.overall === 'CORPUS_HELD' ? 0 : 1;
}

process.exit(main());
