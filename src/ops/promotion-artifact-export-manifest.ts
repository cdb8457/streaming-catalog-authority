import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { LOCAL_OPS_REGISTRY } from './promotion-acceptance-meta.js';
import { KNOWN_REPORT_IDS } from './promotion-self-digest-verifier.js';

// Local, non-live artifact generation / export manifest. Unlike the coverage guards (which pass/fail on
// wiring) this PRODUCES the reproducibility catalog: for every registered Phase 230 op it records the
// artifact it generates -- the produced report id, the `ops:`/`test:` scripts that generate and check it,
// its doc, whether its CLI supports `--out` export, and whether that CLI emits a redaction-safe capture --
// so a coordinator can regenerate and export the entire offline evidence set from one manifest. It fails
// closed on any artifact that is not registered, generatable, documented, exportable, or redaction-safe, so
// the catalog is trustworthy. It reads files + the shared registries only; it performs no promotion, never
// touches the real Movies root, never contacts Jellyfin, and authorizes nothing live. It carries only op
// short-names, fixed report ids/script names, booleans and counts -- no raw paths -- and a self-digest.
// COMPLETE means the artifact set is fully generatable/exportable offline; it is NOT an approval, a merge,
// or a Phase 231 / live-promotion authorization.

export interface ArtifactExportEntry {
  readonly artifact: string;       // op short-name (path-free)
  readonly reportId: string | null; // the produced report id, or null if none/unregistered
  readonly generateScript: string; // `ops:<base>`
  readonly testScript: string;     // `test:<base>`
  readonly doc: string;            // doc base name
  readonly registered: boolean;    // report id verifiable by the self-digest verifier
  readonly exportsToFile: boolean; // CLI supports `--out` export
  readonly cliRedactionSafe: boolean; // CLI emits a `-capture` id + `redactionSafe: true`
  readonly generatable: boolean;   // module + CLI + test + doc + scripts all present
}

export interface ArtifactExportManifest {
  readonly report: 'phase-230-promotion-artifact-export-manifest';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'ARTIFACT_EXPORT_MANIFEST_COMPLETE' | 'ARTIFACT_EXPORT_MANIFEST_INCOMPLETE';
  readonly artifactCount: number;
  readonly exportableCount: number;
  readonly artifacts: readonly ArtifactExportEntry[];
  readonly gaps: readonly string[];
  readonly exportDigest: string;
}

export function buildArtifactExportManifest(projectRoot: string): ArtifactExportManifest {
  const exists = (rel: string): boolean => existsSync(`${projectRoot}/${rel}`);
  const read = (rel: string): string => { try { return readFileSync(`${projectRoot}/${rel}`, 'utf8'); } catch { return ''; } };
  const pkg = JSON.parse(read('package.json') || '{"scripts":{}}') as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const gate = scripts['test:phase230-local'] ?? '';
  const known = new Set(KNOWN_REPORT_IDS);
  const gaps: string[] = [];

  const artifacts: ArtifactExportEntry[] = [...LOCAL_OPS_REGISTRY]
    .sort((a, b) => a.base.localeCompare(b.base))
    .map(({ base, doc }) => {
      const artifact = base.replace(/^promotion-/, '');
      const moduleSrc = read(`src/ops/${base}.ts`);
      const cliSrc = read(`src/ops/${base}-cli.ts`);

      // The produced report id is the first `report: 'phase-230-...'` literal in the module.
      const idMatch = /report: '(phase-230-[a-z0-9-]+)'/.exec(moduleSrc);
      const reportId = idMatch ? idMatch[1]! : null;
      const registered = reportId !== null && known.has(reportId);

      const generatable = exists(`src/ops/${base}.ts`) && exists(`src/ops/${base}-cli.ts`) && exists(`test/${base}.ts`)
        && exists(`docs/${doc}.md`) && typeof scripts[`ops:${base}`] === 'string' && typeof scripts[`test:${base}`] === 'string'
        && gate.includes(`tsx test/${base}.ts`);
      // Exportable = the CLI can persist its artifact to a file. Most ops use `--out`; a few (e.g. the
      // approval workflow) use `--evidence-out` / `--approval-out`. The truest signal is a file write.
      const exportsToFile = cliSrc.includes('writeFileSync') && /--[a-z-]*out\b/.test(cliSrc);
      const cliRedactionSafe = cliSrc.includes("-capture'") && cliSrc.includes('redactionSafe: true');

      if (!registered) gaps.push('ARTIFACT_REPORT_UNREGISTERED');
      if (!generatable) gaps.push('ARTIFACT_NOT_GENERATABLE');
      if (!exportsToFile) gaps.push('ARTIFACT_EXPORT_UNSUPPORTED');
      if (!cliRedactionSafe) gaps.push('ARTIFACT_CLI_NONCONFORMANT');

      return {
        artifact,
        reportId,
        generateScript: `ops:${base}`,
        testScript: `test:${base}`,
        doc,
        registered,
        exportsToFile,
        cliRedactionSafe,
        generatable,
      };
    });

  if (artifacts.length === 0) gaps.push('NO_ARTIFACTS_FOUND');

  const exportableCount = artifacts.filter((a) => a.registered && a.generatable && a.exportsToFile && a.cliRedactionSafe).length;
  const uniqueGaps = [...new Set(gaps)];
  const overall: ArtifactExportManifest['overall'] = uniqueGaps.length === 0 ? 'ARTIFACT_EXPORT_MANIFEST_COMPLETE' : 'ARTIFACT_EXPORT_MANIFEST_INCOMPLETE';
  const withoutDigest: Omit<ArtifactExportManifest, 'exportDigest'> = {
    report: 'phase-230-promotion-artifact-export-manifest',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    artifactCount: artifacts.length,
    exportableCount,
    artifacts,
    gaps: uniqueGaps,
  };
  return { ...withoutDigest, exportDigest: digest('phase-230-artifact-export-manifest', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
