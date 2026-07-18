import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Local, non-live cross-component context-consistency audit. Many Phase 230 reports carry a slice of the
// review context -- branch, base, head/reviewed-commit, the ordered commit shas, and the required test set.
// Each can be independently green and self-digested, yet a set stitched from different runs (or a fresh
// full chain in which one component was resealed onto a different head/range) can disagree on that shared
// context. The pairwise/consumer checks catch specific seams (acceptance-preflight binds a supplied context
// to the reviewer-pack provenance; review-authorization binds a review matrix to the commit-range / transcript
// evidence), but nothing reconciles the WHOLE set at the value level. This audit does: it recomputes each
// supplied report's self-digest and, over the verified ones, asserts every shared context field agrees --
// failing closed on any inconsistency with a focused blocker. It is deterministic and reads parsed JSON only;
// it performs no promotion, never touches the real Movies root, never contacts Jellyfin, and its
// `authorization` field is the constant NONE. It echoes only shas (hex), path-free labels, counts, and
// booleans -- never a raw path or title -- and does not authorize Phase 231 or any live action.

export interface ContextConsistencyInput {
  readonly reports?: unknown; // an array of Phase 230 reports that carry review context
}

interface Projection {
  readonly branch?: string;
  readonly base?: string;
  readonly head?: string;
  readonly commitShas?: readonly string[];
  readonly requiredTests?: readonly string[];
}

// report id -> the context fields it authoritatively carries. Only these ids are reconciled.
const PROJECTORS: Readonly<Record<string, (o: Record<string, unknown>) => Projection>> = {
  'phase-230-promotion-merge-readiness-dry-run': (o) => ({
    branch: pathFree(o.branch), base: sha40(o.base), head: sha40(o.head),
    commitShas: shaListFrom(o.commitsSinceBase, 'sha'), requiredTests: labelList(o.requiredTests),
  }),
  'phase-230-promotion-merge-review-evidence-pack': (o) => {
    const p = asObject(o.provenance);
    return { branch: pathFree(p.branch), base: sha40(p.base), head: sha40(p.head), commitShas: shaList(p.commitShas), requiredTests: labelList(p.requiredTests) };
  },
  'phase-230-promotion-acceptance-preflight': (o) => ({ base: sha40(o.base), head: sha40(o.head), requiredTests: labelList(o.requiredTests) }),
  'phase-230-promotion-commit-range-closure': (o) => ({ base: sha40(o.base), head: sha40(o.head), commitShas: shaListFrom(o.results, 'sha') }),
  'phase-230-promotion-transcript-verification': (o) => ({ head: sha40(o.head) }),
  'phase-230-promotion-review-transcript': (o) => ({ head: sha40(o.reviewedCommit) }),
  'phase-230-promotion-coordinator-final-summary': (o) => ({ head: sha40(o.reviewedCommit) }),
  'phase-230-promotion-provenance-diff': (o) => ({ base: sha40(o.base), head: sha40(o.head) ?? sha40(o.reviewedCommit) }),
  'phase-230-promotion-review-matrix': (o) => ({ base: sha40(o.base), head: sha40(o.head), commitShas: shaListFrom(o.rows, 'sha'), requiredTests: matrixTests(o.rows) }),
};

const SCALAR_FIELDS: ReadonlyArray<['branch' | 'base' | 'head', string]> = [
  ['branch', 'CONTEXT_BRANCH_INCONSISTENT'], ['base', 'CONTEXT_BASE_INCONSISTENT'], ['head', 'CONTEXT_HEAD_INCONSISTENT'],
];

export interface ContextComponent { readonly component: string; readonly verified: boolean; readonly fields: readonly string[]; }
export interface FieldConsistency { readonly field: string; readonly contributors: number; readonly consistent: boolean; }

export interface ContextConsistencyReport {
  readonly report: 'phase-230-promotion-context-consistency-audit';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'CONTEXT_CONSISTENT' | 'CONTEXT_INCONSISTENT';
  readonly componentCount: number;
  readonly components: readonly ContextComponent[];
  readonly fieldConsistency: readonly FieldConsistency[];
  readonly reconciled: { readonly branch: string | null; readonly base: string | null; readonly head: string | null };
  readonly blockers: readonly string[];
  readonly auditDigest: string;
}

export function buildContextConsistencyAudit(input: ContextConsistencyInput): ContextConsistencyReport {
  const blockers: string[] = [];
  const rawReports = Array.isArray(input.reports) ? input.reports : [];

  const components: ContextComponent[] = [];
  const projections: Projection[] = [];
  for (const r of rawReports) {
    const obj = asObject(r);
    const id = typeof obj.report === 'string' ? obj.report : '';
    const projector = PROJECTORS[id];
    if (!projector) continue; // not a context-bearing report; ignore
    const component = id.replace(/^phase-230-promotion-/, '');
    const verified = verifySelfDigests([obj]).results[0]?.verified === true;
    if (!verified) { blockers.push('COMPONENT_UNVERIFIED'); components.push({ component, verified: false, fields: [] }); continue; }
    const p = projector(obj);
    const fields = (['branch', 'base', 'head', 'commitShas', 'requiredTests'] as const).filter((f) => p[f] !== undefined);
    components.push({ component, verified: true, fields });
    projections.push(p);
  }

  if (projections.length < 2) blockers.push('INSUFFICIENT_CONTEXT_COMPONENTS');

  const fieldConsistency: FieldConsistency[] = [];
  const reconciled: { branch: string | null; base: string | null; head: string | null } = { branch: null, base: null, head: null };

  for (const [field, code] of SCALAR_FIELDS) {
    const values = projections.map((p) => p[field]).filter((v): v is string => v !== undefined);
    const distinct = [...new Set(values)];
    const consistent = distinct.length <= 1;
    if (!consistent) blockers.push(code);
    else if (distinct.length === 1) reconciled[field] = distinct[0]!;
    fieldConsistency.push({ field, contributors: values.length, consistent });
  }

  // Ordered commit shas: every contributing list must be identical in order.
  const commitLists = projections.map((p) => p.commitShas).filter((v): v is readonly string[] => v !== undefined);
  const commitsConsistent = commitLists.length <= 1 || commitLists.every((l) => sameOrdered(l, commitLists[0]!));
  if (!commitsConsistent) blockers.push('CONTEXT_COMMITS_INCONSISTENT');
  fieldConsistency.push({ field: 'commitShas', contributors: commitLists.length, consistent: commitsConsistent });

  // Cross-field: the agreed head must be the TERMINAL commit of the agreed ordered commit list. head and
  // commitShas are each internally consistent above, but a consistent head A paired with a consistent commit
  // list ending in C (!= A) still describes an incoherent range -- fail closed.
  if (reconciled.head !== null && commitsConsistent && commitLists.length > 0) {
    const list = commitLists[0]!;
    if (list.length === 0 || list[list.length - 1] !== reconciled.head) blockers.push('CONTEXT_HEAD_NOT_TERMINAL');
  }

  // Required tests: every contributing set must be equal.
  const testSets = projections.map((p) => p.requiredTests).filter((v): v is readonly string[] => v !== undefined);
  const testsConsistent = testSets.length <= 1 || testSets.every((s) => sameSet(s, testSets[0]!));
  if (!testsConsistent) blockers.push('CONTEXT_TESTS_INCONSISTENT');
  fieldConsistency.push({ field: 'requiredTests', contributors: testSets.length, consistent: testsConsistent });

  const uniqueBlockers = [...new Set(blockers)];
  const overall: ContextConsistencyReport['overall'] = uniqueBlockers.length === 0 ? 'CONTEXT_CONSISTENT' : 'CONTEXT_INCONSISTENT';
  const withoutDigest: Omit<ContextConsistencyReport, 'auditDigest'> = {
    report: 'phase-230-promotion-context-consistency-audit',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    componentCount: projections.length,
    components,
    fieldConsistency,
    reconciled,
    blockers: uniqueBlockers,
  };
  return { ...withoutDigest, auditDigest: digest('phase-230-context-consistency-audit', JSON.stringify(withoutDigest)) };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sha40(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}
function shaList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v) => sha40(v)).filter((s): s is string => s !== undefined);
  return out.length > 0 ? out : undefined;
}
function shaListFrom(value: unknown, key: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v) => sha40(asObject(v)[key])).filter((s): s is string => s !== undefined);
  return out.length > 0 ? out : undefined;
}
function matrixTests(rows: unknown): string[] | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const tests = new Set<string>();
  for (const row of rows) for (const t of (Array.isArray(asObject(row).tests) ? asObject(row).tests as unknown[] : [])) {
    const label = pathFree(asObject(t).test);
    if (label !== undefined) tests.add(label);
  }
  return tests.size > 0 ? [...tests] : undefined;
}
function labelList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v) => pathFree(v)).filter((s): s is string => s !== undefined);
  return out.length > 0 ? out : undefined;
}
function pathFree(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (/^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value)) return undefined;
  return value;
}
function sameOrdered(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
