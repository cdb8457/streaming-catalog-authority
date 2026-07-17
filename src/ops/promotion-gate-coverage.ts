import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { buildGateDag } from './promotion-gate-dag.js';
import { BLOCKER_CODES, buildBlockerTaxonomy } from './promotion-blocker-taxonomy.js';
import { LOCAL_OPS_REGISTRY } from './promotion-acceptance-meta.js';

// Local, non-live gate coverage completeness report. It proves the Phase 230 toolchain is fully covered:
// every registered op has a module, CLI, test, doc, and package scripts and is in the local gate; every
// gate-DAG node points at a real test that is in `test:phase230-local`; every gate-DAG blocker code is
// catalogued in the taxonomy; and every taxonomy op maps to a real gate node. It reads files + the shared
// registries only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin,
// and authorizes nothing live. It fails closed on any coverage gap.

export interface CoverageDimension { readonly dimension: string; readonly ok: boolean; }

export interface GateCoverageReport {
  readonly report: 'phase-230-promotion-gate-coverage';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'GATE_COVERAGE_COMPLETE' | 'GATE_COVERAGE_INCOMPLETE';
  readonly opCount: number;
  readonly gateNodeCount: number;
  readonly blockerCodeCount: number;
  readonly dimensions: readonly CoverageDimension[];
  readonly gaps: readonly string[];
  readonly coverageDigest: string;
}

export function buildGateCoverage(projectRoot: string): GateCoverageReport {
  const exists = (rel: string): boolean => existsSync(`${projectRoot}/${rel}`);
  const read = (rel: string): string => { try { return readFileSync(`${projectRoot}/${rel}`, 'utf8'); } catch { return ''; } };
  const pkg = JSON.parse(read('package.json') || '{"scripts":{}}') as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const gate = scripts['test:phase230-local'] ?? '';

  const gaps: string[] = [];

  // Every registered op is fully wired (module / CLI / test / doc / scripts / gate).
  let missingWiring = false;
  for (const { base, doc } of LOCAL_OPS_REGISTRY) {
    const ok = exists(`src/ops/${base}.ts`) && exists(`src/ops/${base}-cli.ts`) && exists(`test/${base}.ts`) && exists(`docs/${doc}.md`)
      && typeof scripts[`ops:${base}`] === 'string' && typeof scripts[`test:${base}`] === 'string'
      && gate.includes(`tsx test/${base}.ts`);
    if (!ok) missingWiring = true;
  }
  if (missingWiring) gaps.push('MISSING_WIRING');

  // Every gate-DAG node points at a real test that the local suite actually runs.
  const nodes = buildGateDag();
  let gateNotInSuite = false;
  for (const n of nodes) {
    if (!exists(n.test) || !gate.includes(`tsx ${n.test}`)) gateNotInSuite = true;
  }
  if (gateNotInSuite) gaps.push('GATE_NOT_IN_LOCAL_SUITE');

  // Every gate blocker code is catalogued.
  const catalogued = new Set(BLOCKER_CODES);
  let uncatalogued = false;
  for (const n of nodes) for (const b of n.blockers) if (!catalogued.has(b)) uncatalogued = true;
  if (uncatalogued) gaps.push('UNCATALOGUED_BLOCKER');

  // Every taxonomy op maps to a real gate node.
  const taxonomy = buildBlockerTaxonomy();
  const nodeIds = new Set(nodes.map((n) => n.id));
  const unknownOp = taxonomy.entries.some((e) => !nodeIds.has(e.op));
  if (unknownOp) gaps.push('UNKNOWN_TAXONOMY_OP');

  const dimensions: CoverageDimension[] = [
    { dimension: 'ops-fully-wired', ok: !missingWiring },
    { dimension: 'gates-in-local-suite', ok: !gateNotInSuite },
    { dimension: 'blockers-catalogued', ok: !uncatalogued },
    { dimension: 'taxonomy-ops-are-gates', ok: !unknownOp },
  ];

  const uniqueGaps = [...new Set(gaps)];
  const overall: GateCoverageReport['overall'] = uniqueGaps.length === 0 ? 'GATE_COVERAGE_COMPLETE' : 'GATE_COVERAGE_INCOMPLETE';
  const withoutDigest: Omit<GateCoverageReport, 'coverageDigest'> = {
    report: 'phase-230-promotion-gate-coverage',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    opCount: LOCAL_OPS_REGISTRY.length,
    gateNodeCount: nodes.length,
    blockerCodeCount: BLOCKER_CODES.length,
    dimensions,
    gaps: uniqueGaps,
  };
  return { ...withoutDigest, coverageDigest: digest('phase-230-gate-coverage', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
