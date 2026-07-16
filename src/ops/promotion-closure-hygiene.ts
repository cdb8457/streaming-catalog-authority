import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildGateDag, verifyGateDag } from './promotion-gate-dag.js';
import { BLOCKER_CODES, buildBlockerTaxonomy } from './promotion-blocker-taxonomy.js';
import { LOCAL_OPS_REGISTRY } from './promotion-acceptance-meta.js';
import { KNOWN_REPORT_IDS } from './promotion-self-digest-verifier.js';

// Local, non-live closure / dependency hygiene meta-verifier. It confirms the toolchain's structural
// invariants hold together: the gate DAG is acyclic, every gate blocker code is catalogued in the blocker
// taxonomy, every taxonomy op is a real gate node, the taxonomy is internally consistent, and every op in
// the registry is wired into the package scripts, the local gate, the suite manifest, the live-boundary
// guard, and the closure index. It reads files + the shared registries only; it performs no promotion,
// never touches the real Movies root, never contacts Jellyfin, and authorizes nothing live.

export interface HygieneCheck { readonly check: string; readonly ok: boolean; }

export interface ClosureHygieneReport {
  readonly report: 'phase-230-promotion-closure-hygiene';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'HYGIENE_OK' | 'HYGIENE_VIOLATION';
  readonly opCount: number;
  readonly nodeCount: number;
  readonly blockerCodeCount: number;
  readonly checks: readonly HygieneCheck[];
  readonly problems: readonly string[];
  readonly hygieneDigest: string;
}

export function buildClosureHygiene(projectRoot: string): ClosureHygieneReport {
  const read = (rel: string): string => { try { return readFileSync(`${projectRoot}/${rel}`, 'utf8'); } catch { return ''; } };
  const pkg = JSON.parse(read('package.json') || '{"scripts":{}}') as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const gate = scripts['test:phase230-local'] ?? '';
  const manifestSrc = read('test/phase230-local-suite-manifest.ts');
  const guardSrc = read('test/promotion-live-boundary-guard.ts');
  const closureIndex = read('docs/PHASE_230_LOCAL_CLOSURE_INDEX.md');

  const problems: string[] = [];

  const dag = verifyGateDag();
  if (!dag.ok) problems.push('DAG_NOT_ACYCLIC');

  const nodes = buildGateDag();
  const nodeIds = new Set(nodes.map((n) => n.id));
  const catalogued = new Set(BLOCKER_CODES);
  let uncatalogued = false;
  for (const n of nodes) for (const b of n.blockers) if (!catalogued.has(b)) uncatalogued = true;
  if (uncatalogued) problems.push('UNCATALOGUED_BLOCKER');

  const taxonomy = buildBlockerTaxonomy();
  if (taxonomy.overall !== 'TAXONOMY_CONSISTENT') problems.push('TAXONOMY_INCONSISTENT');
  const unknownOp = taxonomy.entries.some((e) => !nodeIds.has(e.op));
  if (unknownOp) problems.push('UNKNOWN_TAXONOMY_OP');

  const known = new Set(KNOWN_REPORT_IDS);
  let notWired = false;
  let reportUncovered = false;
  let cliNonConformant = false;
  for (const { base } of LOCAL_OPS_REGISTRY) {
    const wired = typeof scripts[`ops:${base}`] === 'string' && typeof scripts[`test:${base}`] === 'string'
      && gate.includes(`tsx test/${base}.ts`)
      && manifestSrc.includes(`test/${base}.ts`)
      && guardSrc.includes(`src/ops/${base}.ts`)
      && closureIndex.includes(base);
    if (!wired) notWired = true;

    // Every op's primary report id must be verifiable by the self-digest verifier.
    const moduleSrc = read(`src/ops/${base}.ts`);
    const idMatch = /report: '(phase-230-[a-z0-9-]+)'/.exec(moduleSrc);
    if (idMatch && !known.has(idMatch[1]!)) reportUncovered = true;

    // Every op's CLI must conform to the universal stdout contract (a -capture id + a redaction flag).
    const cliSrc = read(`src/ops/${base}-cli.ts`);
    if (!(cliSrc.includes("-capture'") && cliSrc.includes('redactionSafe: true'))) cliNonConformant = true;
  }
  if (notWired) problems.push('REGISTRY_NOT_WIRED');
  if (reportUncovered) problems.push('REPORT_NOT_IN_SELF_DIGEST_REGISTRY');
  if (cliNonConformant) problems.push('CLI_NOT_CONTRACT_CONFORMANT');

  const checks: HygieneCheck[] = [
    { check: 'dag-acyclic', ok: dag.ok },
    { check: 'blockers-catalogued', ok: !uncatalogued },
    { check: 'taxonomy-consistent', ok: taxonomy.overall === 'TAXONOMY_CONSISTENT' },
    { check: 'taxonomy-ops-known', ok: !unknownOp },
    { check: 'registry-wired', ok: !notWired },
    { check: 'self-digest-covers-reports', ok: !reportUncovered },
    { check: 'cli-contract-conformant', ok: !cliNonConformant },
  ];

  const uniqueProblems = [...new Set(problems)];
  const overall: ClosureHygieneReport['overall'] = uniqueProblems.length === 0 ? 'HYGIENE_OK' : 'HYGIENE_VIOLATION';
  const withoutDigest: Omit<ClosureHygieneReport, 'hygieneDigest'> = {
    report: 'phase-230-promotion-closure-hygiene',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    opCount: LOCAL_OPS_REGISTRY.length,
    nodeCount: nodes.length,
    blockerCodeCount: BLOCKER_CODES.length,
    checks,
    problems: uniqueProblems,
  };
  return { ...withoutDigest, hygieneDigest: digest('phase-230-closure-hygiene', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
