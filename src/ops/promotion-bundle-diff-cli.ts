import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { diffFixtureBundles } from './promotion-bundle-diff.js';

// Offline bundle diff/audit CLI. Compares two fixture evidence bundles by digest only and emits a
// redaction-safe diff. Never promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-bundle-diff --a <bundleA.json> --b <bundleB.json> [--out <diff.json>]',
    '',
    'Local, non-live: compares two fixture bundles by per-artifact / per-report digests. Exit 0 = identical,',
    '1 = differences (or an invalid bundle).',
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
  const aPath = valueAfter(args, '--a');
  const bPath = valueAfter(args, '--b');
  const out = valueAfter(args, '--out');
  if (!aPath || !bPath) {
    console.error(usage());
    return 2;
  }
  let a: unknown;
  let b: unknown;
  try {
    a = readJson(aPath, 'a');
    b = readJson(bPath, 'b');
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const diff = diffFixtureBundles(a, b);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(diff, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-bundle-diff-capture',
    identical: diff.identical,
    aValid: diff.aValid,
    bValid: diff.bValid,
    redactionSafe: true,
    differingComponents: diff.differingComponents,
    diffDigest: diff.diffDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return diff.identical ? 0 : 1;
}

process.exit(main());
