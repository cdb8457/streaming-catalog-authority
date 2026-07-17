import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildTerminalReadinessV2, type TerminalReadinessV2Input } from './promotion-terminal-readiness-v2.js';

// Offline terminal readiness v2 CLI. Ties the full local evidence set -- terminal closure, pack
// component-integrity, aggregator digest audit, artifact export manifest, negative-evidence corpus, and
// watchdog hygiene -- into one final local-only readiness record. CONFIRMED is NOT an approval, merge, or
// live promotion. Never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-terminal-readiness-v2 --terminalclosure <f> --packcomponentintegrity <f> --aggregatordigestaudit <f> --artifactexportmanifest <f> --negativeevidencecorpus <f> --watchdoghygiene <f> [--out <manifest.json>]',
    '',
    'Local, non-live: TERMINAL_READINESS_V2_CONFIRMED only when every component is present, valid, green, and',
    'digest-recomputes. CONFIRMED is NOT an approval and does not authorize Phase 231 or any merge.',
    'Exit 0 = CONFIRMED, 1 = NOT_CONFIRMED.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}
function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} file is missing or not valid JSON`); }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const map: Array<[keyof TerminalReadinessV2Input, string]> = [
    ['terminalClosure', '--terminalclosure'], ['packComponentIntegrity', '--packcomponentintegrity'], ['aggregatorDigestAudit', '--aggregatordigestaudit'],
    ['artifactExportManifest', '--artifactexportmanifest'], ['negativeEvidenceCorpus', '--negativeevidencecorpus'], ['watchdogHygiene', '--watchdoghygiene'],
  ];
  const input: TerminalReadinessV2Input = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const manifest = buildTerminalReadinessV2(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-terminal-readiness-v2-capture',
    overall: manifest.overall,
    authorization: manifest.authorization,
    redactionSafe: true,
    components: manifest.components,
    boundDigests: manifest.boundDigests,
    humanGates: manifest.humanGates,
    boundary: manifest.boundary,
    blockers: manifest.blockers,
    readinessV2Digest: manifest.readinessV2Digest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return manifest.overall === 'TERMINAL_READINESS_V2_CONFIRMED' ? 0 : 1;
}

process.exit(main());
