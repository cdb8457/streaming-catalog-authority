import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildRedactionCorpus } from './promotion-redaction-corpus.js';

// Offline redaction regression corpus CLI. Runs every leak-shaped payload through every redaction detector
// and every safe value through the same detectors, and reports whether redaction held. Never promotes,
// never touches the real Movies root, never contacts Jellyfin. Never echoes a payload.

function usage(): string {
  return [
    'usage: ops:promotion-redaction-corpus [--out <corpus.json>]',
    '',
    'Local, non-live: REDACTION_CORPUS_HELD only when every leak payload is flagged by every detector and',
    'no safe value is flagged. It authorizes NOTHING live and does not authorize Phase 231.',
    'Exit 0 = HELD, 1 = BREACHED.',
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
  const corpus = buildRedactionCorpus();
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(corpus, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-redaction-corpus-capture',
    overall: corpus.overall,
    authorization: corpus.authorization,
    redactionSafe: true,
    leakCount: corpus.leakCount,
    safeCount: corpus.safeCount,
    detectorCount: corpus.detectorCount,
    categories: corpus.categories,
    breaches: corpus.breaches,
    gaps: corpus.gaps,
    redactionDigest: corpus.redactionDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return corpus.overall === 'REDACTION_CORPUS_HELD' ? 0 : 1;
}

process.exit(main());
