import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyInjectionCorpus } from './promotion-injection-corpus.js';

// Offline injection-corpus CLI. Feeds adversarial untrusted text through the verifiers and confirms each
// is handled as data. Never promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-injection-corpus --bundle <bundle.json> [--out <corpus.json>]',
    '',
    'Local, non-live: embeds injection payloads into artifact/record fields and checks every verifier',
    'handles them as data (no execution, redaction-safe). Exit 0 = all handled as data, 1 = a lapse.',
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
  if (!bundlePath) { console.error(usage()); return 2; }
  let candidate: unknown;
  try { candidate = JSON.parse(readFileSync(bundlePath, 'utf8')); }
  catch { console.error('bundle file is missing or not valid JSON'); return 2; }
  const corpus = verifyInjectionCorpus(candidate);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(corpus, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-injection-corpus-capture',
    ok: corpus.ok,
    redactionSafe: true,
    payloadCount: corpus.payloadCount,
    entryCount: corpus.entries.length,
    corpusDigest: corpus.corpusDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return corpus.ok ? 0 : 1;
}

process.exit(main());
