import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyTamperCorpus } from './promotion-tamper-corpus.js';

// Offline tamper-corpus CLI. Reads a clean fixture bundle, generates the tamper corpus, and confirms
// each tampered input produces its expected generic failure. Never promotes, never touches the real
// Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-tamper-corpus --bundle <bundle.json> [--out <corpus.json>]',
    '',
    'Local, non-live: derives tampered inputs from a clean bundle and checks each verifier reports its',
    'expected generic failure. Exit 0 = every tamper detected as expected, 1 = a tamper slipped through.',
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
  const bundlePath = valueAfter(args, '--bundle');
  const out = valueAfter(args, '--out');
  if (!bundlePath) {
    console.error(usage());
    return 2;
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(readFileSync(bundlePath, 'utf8'));
  } catch {
    console.error('bundle file is missing or not valid JSON');
    return 2;
  }
  const corpus = verifyTamperCorpus(candidate);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(corpus, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-tamper-corpus-capture',
    ok: corpus.ok,
    redactionSafe: true,
    entries: corpus.entries,
    corpusDigest: corpus.corpusDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return corpus.ok ? 0 : 1;
}

process.exit(main());
