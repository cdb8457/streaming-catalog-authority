import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildChainBundle, type ChainBundleInput } from './promotion-chain-bundle.js';

// Offline artifact chain bundle CLI. Packs the closing Phase 230 records into one redaction-safe handoff
// manifest. Never promotes, never touches the real Movies root, never contacts Jellyfin, never merges.

function usage(): string {
  return [
    'usage: ops:promotion-chain-bundle --finalsummary <f> --releasechecklist <f> --mergereadiness <f> --negativecorpus <f> --provenancediff <f> --gatecoverage <f> [--out <bundle.json>]',
    '',
    'Local, non-live: CHAIN_BUNDLE_READY only when every component is present, valid, green, digest-bound,',
    'and the release checklist cleared the exact final summary. It authorizes NOTHING live and does not',
    'authorize Phase 231. Exit 0 = READY, 1 = BLOCKED.',
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
  const map: Array<[keyof ChainBundleInput, string]> = [
    ['finalSummary', '--finalsummary'], ['releaseChecklist', '--releasechecklist'], ['mergeReadiness', '--mergereadiness'],
    ['negativeCorpus', '--negativecorpus'], ['provenanceDiff', '--provenancediff'], ['gateCoverage', '--gatecoverage'],
  ];
  const input: ChainBundleInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const bundle = buildChainBundle(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-artifact-chain-bundle-capture',
    overall: bundle.overall,
    authorization: bundle.authorization,
    redactionSafe: true,
    components: bundle.components.map((c) => ({ component: c.component, present: c.present, ok: c.ok })),
    bindings: bundle.bindings,
    blockers: bundle.blockers,
    chainDigest: bundle.chainDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return bundle.overall === 'CHAIN_BUNDLE_READY' ? 0 : 1;
}

process.exit(main());
