import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReviewBundle, type ReviewBundleInput } from './promotion-review-bundle.js';

// Offline final review-bundle CLI. Combines the evidence packet, review transcript, provenance ledger,
// gate DAG, and archive manifest into a redaction-safe coordinator review bundle. Never promotes, never
// touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-review-bundle --evidence <f> --transcript <f> --ledger <f> --dag <f> --archive <f> [--out <bundle.json>]',
    '',
    'Local, non-live: REVIEW_BUNDLE_READY only when every component is present, valid, and green. It',
    'authorizes NOTHING live and does not authorize Phase 231. Exit 0 = READY, 1 = BLOCKED.',
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
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const map: Array<[keyof ReviewBundleInput, string]> = [['evidence', '--evidence'], ['transcript', '--transcript'], ['ledger', '--ledger'], ['dag', '--dag'], ['archive', '--archive']];
  const input: ReviewBundleInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const bundle = buildReviewBundle(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-coordinator-review-bundle-capture',
    overall: bundle.overall,
    authorization: bundle.authorization,
    redactionSafe: true,
    components: bundle.components.map((c) => ({ component: c.component, present: c.present, ok: c.ok })),
    blockers: bundle.blockers,
    reviewBundleDigest: bundle.reviewBundleDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return bundle.overall === 'REVIEW_BUNDLE_READY' ? 0 : 1;
}

process.exit(main());
