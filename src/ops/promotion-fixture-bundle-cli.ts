import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildFixtureEvidenceBundle, type FixtureBundleInput } from './promotion-fixture-bundle.js';

// Offline fixture-bundle CLI. Runs a successful rehearsal and writes a redaction-safe, deterministic
// evidence bundle. Never promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-fixture-bundle [--work-dir <dir>] [--run-id <id>] [--acceptor-id <id>] [--out <bundle.json>]',
    '',
    'Local, non-live: assembles approval/promotion/review/readiness/acceptance + integrity/schema/matrix/',
    'handoff/dashboard into one redaction-safe bundle. Exit 0 = BUNDLE_READY, 1 = BUNDLE_INCOMPLETE.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const out = valueAfter(args, '--out');
  const input: FixtureBundleInput = {
    ...(valueAfter(args, '--work-dir') !== undefined ? { workDir: valueAfter(args, '--work-dir') } : {}),
    ...(valueAfter(args, '--run-id') !== undefined ? { runId: valueAfter(args, '--run-id') } : {}),
    ...(valueAfter(args, '--acceptor-id') !== undefined ? { acceptorId: valueAfter(args, '--acceptor-id') } : {}),
  };
  let bundle;
  try {
    bundle = await buildFixtureEvidenceBundle(input);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-fixture-bundle-capture',
    outcome: bundle.outcome,
    authorization: bundle.authorization,
    redactionSafe: true,
    notes: bundle.notes,
    bundleDigest: bundle.bundleDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return bundle.outcome === 'BUNDLE_READY' ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
