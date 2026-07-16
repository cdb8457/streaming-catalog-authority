import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildArchiveManifest, type ArchiveInput } from './promotion-archive-manifest.js';

// Offline evidence archive-manifest CLI. Assembles the provenance ledger, gate DAG, evidence packet, and
// review transcript into a redaction-safe archive manifest. Never promotes, never touches the real
// Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-archive-manifest --ledger <f> --dag <f> --evidence <f> --transcript <f> [--out <archive.json>]',
    '',
    'Local, non-live: ARCHIVE_READY only when the ledger is complete, the DAG is acyclic, the evidence',
    'packet is EVIDENCE_COMPLETE, and the review transcript is REVIEW_CLEAN. Exit 0 = READY, 1 = BLOCKED.',
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
  const out = valueAfter(args, '--out');
  const paths: Array<[keyof ArchiveInput, string]> = [['ledger', '--ledger'], ['dag', '--dag'], ['evidence', '--evidence'], ['transcript', '--transcript']];
  const input: ArchiveInput = {};
  try {
    for (const [key, flag] of paths) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const archive = buildArchiveManifest(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(archive, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-evidence-archive-manifest-capture',
    overall: archive.overall,
    authorization: archive.authorization,
    redactionSafe: true,
    components: archive.components.map((c) => ({ component: c.component, present: c.present, ok: c.ok })),
    blockers: archive.blockers,
    archiveDigest: archive.archiveDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return archive.overall === 'ARCHIVE_READY' ? 0 : 1;
}

process.exit(main());
