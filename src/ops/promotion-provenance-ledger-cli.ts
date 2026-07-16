import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildProvenanceLedger, type ProvenanceInput } from './promotion-provenance-ledger.js';

// Offline provenance-ledger CLI. Records artifact/report provenance (id, digest, producer, consumers,
// status) from a fixture bundle (+ optional replay/evidence/transcript). Never promotes, never touches
// the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-provenance-ledger --bundle <bundle.json> [--replay <f>] [--evidence <f>] [--transcript <f>] [--out <ledger.json>]',
    '',
    'Local, non-live: emits a redaction-safe provenance ledger. Exit 0 = complete (every entry present),',
    '1 = incomplete.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}
function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} file is missing or not valid JSON`); }
}

function main(): number {
  const args = process.argv.slice(2);
  const bundlePath = valueAfter(args, '--bundle');
  const out = valueAfter(args, '--out');
  if (!bundlePath) { console.error(usage()); return 2; }
  let input: ProvenanceInput;
  try {
    input = {
      bundle: readJson(bundlePath, 'bundle'),
      ...(valueAfter(args, '--replay') ? { replay: readJson(valueAfter(args, '--replay')!, 'replay') } : {}),
      ...(valueAfter(args, '--evidence') ? { evidence: readJson(valueAfter(args, '--evidence')!, 'evidence') } : {}),
      ...(valueAfter(args, '--transcript') ? { transcript: readJson(valueAfter(args, '--transcript')!, 'transcript') } : {}),
    };
  } catch (err) { console.error((err as Error).message); return 2; }
  const ledger = buildProvenanceLedger(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-provenance-ledger-capture',
    complete: ledger.complete,
    redactionSafe: true,
    absent: ledger.absent,
    ledgerDigest: ledger.ledgerDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return ledger.complete ? 0 : 1;
}

process.exit(main());
