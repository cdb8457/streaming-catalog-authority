import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildPackComponentIntegrity, type PackComponentIntegrityInput } from './promotion-pack-component-integrity.js';

// Offline pack component-integrity CLI. Recomputes every packed component's self-digest from the
// authoritative source reports and binds the pack's redacted digests back to them. VERIFIED is NOT an
// approval, merge, or live promotion. Never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-pack-component-integrity --reviewerpack <f> --finalsummary <f> --releasechecklist <f> --mergereadiness <f> --chainbundle <f> --reviewautomation <f> --redactioncorpus <f> --boundarypolicy <f> [--out <report.json>]',
    '',
    'Local, non-live: PACK_INTEGRITY_VERIFIED only when the pack recomputes and every packed component',
    'recomputes, is green, and its redacted pack digest binds to the recomputed authoritative record.',
    'VERIFIED does NOT approve, merge, or authorize Phase 231. Exit 0 = VERIFIED, 1 = BROKEN.',
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
  const map: Array<[keyof PackComponentIntegrityInput, string]> = [
    ['reviewerPack', '--reviewerpack'], ['finalSummary', '--finalsummary'], ['releaseChecklist', '--releasechecklist'],
    ['mergeReadiness', '--mergereadiness'], ['chainBundle', '--chainbundle'], ['reviewAutomation', '--reviewautomation'],
    ['redactionCorpus', '--redactioncorpus'], ['boundaryPolicy', '--boundarypolicy'],
  ];
  const input: PackComponentIntegrityInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const report = buildPackComponentIntegrity(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-pack-component-integrity-capture',
    overall: report.overall,
    authorization: report.authorization,
    redactionSafe: true,
    packVerified: report.packVerified,
    components: report.components,
    boundDigests: report.boundDigests,
    verifiedCount: report.verifiedCount,
    blockers: report.blockers,
    integrityDigest: report.integrityDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.overall === 'PACK_INTEGRITY_VERIFIED' ? 0 : 1;
}

process.exit(main());
