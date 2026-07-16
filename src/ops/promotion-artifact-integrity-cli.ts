import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyArtifactIntegrity, type ArtifactBundle } from './promotion-artifact-integrity.js';

// Offline artifact-integrity CLI. Reads the supplied Phase 230 artifact JSON files and verifies their
// self-digests and cross-artifact digest chain. Never promotes, never touches the real Movies root,
// never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-artifact-integrity [--approval-evidence <f>] [--promotion-evidence <f>] \\',
    '    [--evidence-review <f>] [--readiness <f>] [--acceptance-packet <f>] [--out <report.json>]',
    '',
    'Local, non-live: verifies each supplied artifact self-digest recomputes and the cross-artifact digest',
    'chain is consistent. Missing artifacts are reported. Exit 0 = ok, 1 = integrity problem(s).',
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
  const map: Array<[keyof ArtifactBundle, string]> = [
    ['approvalEvidence', '--approval-evidence'],
    ['promotionEvidence', '--promotion-evidence'],
    ['evidenceReview', '--evidence-review'],
    ['readiness', '--readiness'],
    ['acceptancePacket', '--acceptance-packet'],
  ];
  const bundle: ArtifactBundle = {};
  try {
    for (const [key, flag] of map) {
      const path = valueAfter(args, flag);
      if (path !== undefined) (bundle as Record<string, unknown>)[key] = readJson(path, key);
    }
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const out = valueAfter(args, '--out');
  const report = verifyArtifactIntegrity(bundle);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-artifact-integrity-capture',
    ok: report.ok,
    redactionSafe: true,
    checkedArtifacts: report.checkedArtifacts,
    problems: report.problems,
    integrityDigest: report.integrityDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.ok ? 0 : 1;
}

process.exit(main());
