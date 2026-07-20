import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGuardAdversarialCorpusV2 } from './promotion-guard-adversarial-corpus-v2.js';

// Offline shared adversarial guard corpus v2 CLI. Runs every adversarial + safe sample through the
// launch-proofing guard family and reports whether the corpus held. It authorizes nothing. Never touches the
// real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-guard-adversarial-corpus-v2 [--out <corpus.json>]',
    '',
    'Local, non-live: GUARD_CORPUS_V2_HELD when every adversarial sample fails its guard closed and every safe',
    'sample stays clean/pending. It does not authorize Phase 231 or live promotion. Exit 0 = HELD, 1 = BREACHED.',
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
  const corpus = buildGuardAdversarialCorpusV2(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(corpus, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-guard-adversarial-corpus-v2-capture',
    overall: corpus.overall,
    authorization: corpus.authorization,
    redactionSafe: true,
    count: corpus.count,
    guardsCovered: corpus.guardsCovered,
    categories: corpus.categories,
    breaches: corpus.breaches,
    corpusV2Digest: corpus.corpusV2Digest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return corpus.overall === 'GUARD_CORPUS_V2_HELD' ? 0 : 1;
}

process.exit(main());
