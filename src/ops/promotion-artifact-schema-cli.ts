import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateArtifactSchemas, type ArtifactBundle } from './promotion-artifact-schema.js';

// Offline artifact-schema CLI. Reads the supplied Phase 230 artifact JSON files and validates each
// artifact's structural shape and status enums (independent of digests). Never promotes, never touches
// the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-artifact-schema [--approval-evidence <f>] [--promotion-evidence <f>] \\',
    '    [--evidence-review <f>] [--readiness <f>] [--acceptance-packet <f>] [--out <report.json>]',
    '',
    'Local, non-live: strict schema/status validation of the offline artifacts. Exit 0 = ok, 1 = schema problem(s).',
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
  const report = validateArtifactSchemas(bundle);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-artifact-schema-capture',
    ok: report.ok,
    redactionSafe: true,
    checkedArtifacts: report.checkedArtifacts,
    problems: report.problems,
    schemaDigest: report.schemaDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.ok ? 0 : 1;
}

process.exit(main());
