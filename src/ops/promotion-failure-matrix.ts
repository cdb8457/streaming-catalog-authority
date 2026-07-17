import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { buildGateDag } from './promotion-gate-dag.js';
import { BLOCKER_CODES, buildBlockerTaxonomy } from './promotion-blocker-taxonomy.js';
import { LOCAL_OPS_REGISTRY } from './promotion-acceptance-meta.js';

// Local, non-live failure-mode matrix. It maps EVERY catalogued blocker code -- the original set and the
// AP-AX additions -- to (a) the test suite that exercises its raising op (positive/negative cases), (b) a
// doc reference, and (c) a gate reference (the op's gate-DAG node), and classifies the evidence kind:
// 'asserted' (the code literally appears in a test or corpus), 'emitted' (it appears in a module that
// raises it), or 'suite' (covered by the op's suite). It fails closed on an unmapped blocker, a stale
// taxonomy (map/taxonomy drift or DAG blockers not catalogued), a missing test path, or a blocker without
// any evidence. It reads files + the shared registries only; it performs no promotion, never touches the
// real Movies root, never contacts Jellyfin, and authorizes nothing live.

// Ops that are gates but not `promotion-<op>` registry tools map to these docs.
const SPECIAL_DOCS: Readonly<Record<string, string>> = {
  'promotion': 'PHASE_230_LOCAL_TOOLING_INDEX',
  'closure': 'PHASE_230_LOCAL_CLOSURE_INDEX',
  'live-boundary': 'PHASE_230_PROMOTION_LIVE_BOUNDARY_GUARD',
};

// Corpus modules whose payload/sample declarations count as 'asserted' evidence.
const CORPUS_MODULES: readonly string[] = [
  'promotion-negative-evidence-corpus.ts', 'promotion-redaction-corpus.ts',
  'promotion-injection-corpus.ts', 'promotion-tamper-corpus.ts',
];

// Declaration-only files: appearing here is a declaration, not evidence.
const DECLARATION_FILES: readonly string[] = [
  'promotion-blocker-taxonomy.ts', 'promotion-gate-dag.ts',
  'promotion-failure-matrix.ts', 'promotion-failure-matrix-cli.ts',
];

export interface FailureMatrixEntry {
  readonly code: string;
  readonly ops: readonly string[];
  readonly test: string | null;
  readonly doc: string | null;
  readonly kind: 'asserted' | 'emitted' | 'suite' | 'none';
  readonly mapped: boolean;
}

export interface FailureMatrixReport {
  readonly report: 'phase-230-promotion-failure-mode-matrix';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'FAILURE_MATRIX_COMPLETE' | 'FAILURE_MATRIX_INCOMPLETE';
  readonly codeCount: number;
  readonly mappedCount: number;
  readonly kinds: Readonly<Record<string, number>>;
  readonly entries: readonly FailureMatrixEntry[];
  readonly gaps: readonly string[];
  readonly failureMatrixDigest: string;
}

export function buildFailureMatrix(projectRoot: string, extraEntries: readonly { code: string; op: string }[] = []): FailureMatrixReport {
  const exists = (rel: string): boolean => existsSync(`${projectRoot}/${rel}`);
  const read = (rel: string): string => { try { return readFileSync(`${projectRoot}/${rel}`, 'utf8'); } catch { return ''; } };
  const list = (dir: string): string[] => { try { return readdirSync(`${projectRoot}/${dir}`).filter((f) => f.endsWith('.ts')); } catch { return []; } };
  const gaps: string[] = [];

  // Taxonomy must be internally consistent and cover every gate-DAG blocker.
  const taxonomy = buildBlockerTaxonomy();
  const catalogued = new Set(BLOCKER_CODES);
  const nodes = buildGateDag();
  if (taxonomy.overall !== 'TAXONOMY_CONSISTENT') gaps.push('STALE_TAXONOMY');
  for (const n of nodes) for (const b of n.blockers) if (!catalogued.has(b)) gaps.push('STALE_TAXONOMY');
  // A mapped code that is no longer in the taxonomy is stale drift.
  for (const e of extraEntries) if (!catalogued.has(e.code)) gaps.push('STALE_TAXONOMY');

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const registryDocs = new Map(LOCAL_OPS_REGISTRY.map((r) => [r.base, r.doc]));

  // Evidence blobs: literal assertions in tests/corpora, and emitters in the op modules.
  const assertedBlob = [
    ...list('test').map((f) => read(`test/${f}`)),
    ...CORPUS_MODULES.map((f) => read(`src/ops/${f}`)),
  ].join('\n');
  const emittedBlob = list('src/ops')
    .filter((f) => !DECLARATION_FILES.includes(f))
    .map((f) => read(`src/ops/${f}`))
    .join('\n');

  const allEntries = [...taxonomy.entries.map((e) => ({ code: e.code, op: e.op })), ...extraEntries];
  const opsByCode = new Map<string, string[]>();
  for (const e of allEntries) {
    const ops = opsByCode.get(e.code) ?? [];
    if (!ops.includes(e.op)) ops.push(e.op);
    opsByCode.set(e.code, ops);
  }

  const entries: FailureMatrixEntry[] = [...opsByCode.keys()].sort().map((code) => {
    const ops = opsByCode.get(code)!;
    let test: string | null = null;
    let doc: string | null = null;
    for (const op of ops) {
      const node = nodeById.get(op);
      const docName = registryDocs.get(`promotion-${op}`) ?? SPECIAL_DOCS[op];
      if (node && docName !== undefined) { test = node.test; doc = docName; break; }
    }
    if (test === null || doc === null) gaps.push('UNMAPPED_BLOCKER');
    const testExists = test !== null && exists(test);
    if (test !== null && !testExists) gaps.push('MISSING_TEST_PATH');
    const docExists = doc !== null && exists(`docs/${doc}.md`);
    if (doc !== null && !docExists) gaps.push('UNMAPPED_BLOCKER');

    const kind: FailureMatrixEntry['kind'] = assertedBlob.includes(code) ? 'asserted'
      : emittedBlob.includes(code) ? 'emitted'
        : testExists ? 'suite' : 'none';
    if (kind === 'none') gaps.push('BLOCKER_WITHOUT_EVIDENCE');

    const mapped = test !== null && doc !== null && testExists && docExists && kind !== 'none';
    return { code, ops, test, doc, kind, mapped };
  });

  const kinds: Record<string, number> = {};
  for (const e of entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const uniqueGaps = [...new Set(gaps)];
  const overall: FailureMatrixReport['overall'] = uniqueGaps.length === 0 ? 'FAILURE_MATRIX_COMPLETE' : 'FAILURE_MATRIX_INCOMPLETE';
  const withoutDigest: Omit<FailureMatrixReport, 'failureMatrixDigest'> = {
    report: 'phase-230-promotion-failure-mode-matrix',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    codeCount: entries.length,
    mappedCount: entries.filter((e) => e.mapped).length,
    kinds,
    entries,
    gaps: uniqueGaps,
  };
  return { ...withoutDigest, failureMatrixDigest: digest('phase-230-failure-matrix', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
