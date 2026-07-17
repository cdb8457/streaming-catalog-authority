import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifactExportManifest } from './promotion-artifact-export-manifest.js';

// Offline artifact generation / export manifest CLI. Emits the reproducibility catalog for every Phase 230
// artifact -- how it is generated and whether it exports. Never promotes, never touches the real Movies
// root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-artifact-export-manifest [--out <manifest.json>]',
    '',
    'Local, non-live: ARTIFACT_EXPORT_MANIFEST_COMPLETE when every registered op artifact is registered,',
    'generatable, exportable via --out, and redaction-safe. It authorizes NOTHING live and does not authorize',
    'Phase 231. Exit 0 = COMPLETE, 1 = INCOMPLETE.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const manifest = buildArtifactExportManifest(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-artifact-export-manifest-capture',
    overall: manifest.overall,
    authorization: manifest.authorization,
    redactionSafe: true,
    artifactCount: manifest.artifactCount,
    exportableCount: manifest.exportableCount,
    artifacts: manifest.artifacts,
    gaps: manifest.gaps,
    exportDigest: manifest.exportDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return manifest.overall === 'ARTIFACT_EXPORT_MANIFEST_COMPLETE' ? 0 : 1;
}

process.exit(main());
