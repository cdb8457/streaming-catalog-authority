import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { EXPECTED_PACK_COMPONENTS, EXPECTED_PACK_BINDINGS } from './promotion-reviewer-pack.js';

// Local, non-live Phase 230 acceptance preflight. A deterministic ready/not-ready report for coordinator
// review: it consumes the merge-review evidence pack (AW) plus the branch/base/head/test context and states
// EXACTLY which machine gates passed and which human gates remain. It approves nothing, merges nothing, and
// live-promotes nothing -- `approvalsGranted` is always empty and `authorization` is the constant NONE. It
// reads parsed JSON only; it invokes no git, performs no promotion, never touches the real Movies root, and
// never contacts Jellyfin. It echoes only hex shas, counts, and fixed-language strings.

export interface PreflightContext {
  readonly branch?: unknown;
  readonly base?: unknown;
  readonly head?: unknown;
  readonly commits?: unknown;
  readonly requiredTests?: unknown;
}

export interface AcceptancePreflightInput {
  readonly reviewerPack?: unknown;
  readonly context?: PreflightContext;
}

export const PREFLIGHT_HUMAN_GATES: readonly string[] = [
  'Human review of the commit range and diff.',
  'Running the full `npm test` aggregate (legacy/live/CRLF/DB suites) if desired.',
  'Explicit coordinator ACCEPT recorded via the acceptance seal.',
  'The merge / tag / push-to-master action itself -- a human operator step NOT performed or authorized here.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const PREFLIGHT_DISCLAIMERS: readonly string[] = [
  'This preflight does NOT approve, merge, tag, push, or live-promote anything.',
  'This preflight does NOT authorize Phase 231.',
  'No live Jellyfin call or real Movies write is implied or performed by this preflight.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface MachineGate { readonly gate: string; readonly passed: boolean; }

export interface AcceptancePreflight {
  readonly report: 'phase-230-promotion-acceptance-preflight';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly approvalsGranted: readonly string[];
  readonly overall: 'PREFLIGHT_READY' | 'PREFLIGHT_NOT_READY';
  readonly base: string | null;
  readonly head: string | null;
  readonly commitCount: number;
  readonly requiredTests: readonly string[];
  readonly machineGates: readonly MachineGate[];
  readonly humanGatesRemaining: readonly string[];
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly preflightDigest: string;
}

export function buildAcceptancePreflight(input: AcceptancePreflightInput): AcceptancePreflight {
  const blockers: string[] = [];
  const machineGates: MachineGate[] = [];

  // Required: the merge-review evidence pack -- valid, self-digest recomputes, READY, with the EXACT
  // expected component set and binding mesh (no missing/unknown/failing). Provenance is trusted only from
  // a self-consistent pack.
  let packProvenance: Record<string, unknown> = {};
  const rp = input.reviewerPack;
  if (rp === undefined) { blockers.push('REVIEWER_PACK_MISSING'); machineGates.push({ gate: 'reviewer-pack', passed: false }); }
  else {
    const o = asObject(rp);
    if (o.report !== 'phase-230-promotion-merge-review-evidence-pack') { blockers.push('REVIEWER_PACK_INVALID'); machineGates.push({ gate: 'reviewer-pack', passed: false }); }
    else {
      // The stated self-digest must recompute -- a forged pack with a made-up (or missing) digest fails.
      const digestOk = verifySelfDigests([o]).overall === 'ALL_VERIFIED';
      if (!digestOk) blockers.push('REVIEWER_PACK_DIGEST_MISMATCH');
      const ready = o.overall === 'REVIEWER_PACK_READY';
      if (!ready) blockers.push('REVIEWER_PACK_NOT_READY');
      machineGates.push({ gate: 'reviewer-pack', passed: ready && digestOk });

      // Exact expected component set: each expected present + ok; no unknown component names.
      const compOk = new Map<string, boolean>();
      const compNames: string[] = [];
      for (const c of (Array.isArray(o.components) ? o.components : [])) {
        const co = asObject(c);
        if (typeof co.component === 'string') { compNames.push(co.component); compOk.set(co.component, co.ok === true); }
      }
      let componentsComplete = true;
      for (const name of EXPECTED_PACK_COMPONENTS) {
        const ok = compOk.get(name) === true;
        if (!ok) componentsComplete = false;
        machineGates.push({ gate: `component:${name}`, passed: ok });
      }
      if (!componentsComplete) blockers.push('PACK_COMPONENT_INCOMPLETE');
      if (compNames.some((n) => !EXPECTED_PACK_COMPONENTS.includes(n))) blockers.push('PACK_COMPONENT_UNKNOWN');

      // Exact expected binding mesh: each expected present + ok; no missing/unknown/failing bindings.
      const bindOk = new Map<string, boolean>();
      const bindNames: string[] = [];
      for (const b of (Array.isArray(o.bindings) ? o.bindings : [])) {
        const bo = asObject(b);
        if (typeof bo.binding === 'string') { bindNames.push(bo.binding); bindOk.set(bo.binding, bo.ok === true); }
      }
      let bindingsMissing = false;
      let bindingsFailing = false;
      for (const name of EXPECTED_PACK_BINDINGS) {
        if (!bindOk.has(name)) bindingsMissing = true;
        else if (bindOk.get(name) !== true) bindingsFailing = true;
      }
      const bindingsUnknown = bindNames.some((n) => !EXPECTED_PACK_BINDINGS.includes(n));
      if (bindingsMissing) blockers.push('PACK_BINDING_MISSING');
      if (bindingsFailing) blockers.push('PACK_BINDING_FAILED');
      if (bindingsUnknown) blockers.push('PACK_BINDING_UNKNOWN');
      machineGates.push({ gate: 'pack-binding-mesh', passed: !bindingsMissing && !bindingsFailing && !bindingsUnknown });

      if (digestOk) packProvenance = asObject(o.provenance);
    }
  }

  // Required: a well-formed branch/base/head/test context.
  const ctx = input.context;
  let base: string | null = null;
  let head: string | null = null;
  let commitCount = 0;
  let requiredTests: string[] = [];
  if (ctx === undefined) { blockers.push('PREFLIGHT_CONTEXT_MISSING'); machineGates.push({ gate: 'context', passed: false }); }
  else {
    const branchOk = pathFreeString(ctx.branch) !== null;
    base = asSha40(ctx.base) ?? null;
    head = asSha40(ctx.head) ?? null;
    const commits = Array.isArray(ctx.commits) ? ctx.commits : [];
    const commitsOk = commits.length > 0 && commits.every((c) => { const o = asObject(c); return asSha40(o.sha) !== undefined && pathFreeString(o.subject) !== null; });
    commitCount = commitsOk ? commits.length : 0;
    const testsV = Array.isArray(ctx.requiredTests) ? ctx.requiredTests : null;
    const testsOk = testsV !== null && testsV.length > 0 && testsV.every((t) => pathFreeString(t) !== null);
    requiredTests = testsOk ? (testsV as string[]) : [];
    const ctxOk = branchOk && base !== null && head !== null && commitsOk && testsOk;
    if (!ctxOk) blockers.push('PREFLIGHT_CONTEXT_INVALID');
    machineGates.push({ gate: 'context', passed: ctxOk });

    // Bind the supplied context to the pack's authoritative provenance (from the digest-bound
    // merge-readiness). A branch/base/head/required-tests that does not match the packed evidence fails.
    const provBranch = pathFreeString(packProvenance.branch);
    const provBase = asSha40(packProvenance.base) ?? null;
    const provHead = asSha40(packProvenance.head) ?? null;
    const provTests = Array.isArray(packProvenance.requiredTests) ? packProvenance.requiredTests.filter((t): t is string => typeof t === 'string') : [];
    const branchBound = provBranch !== null && pathFreeString(ctx.branch) === provBranch;
    if (!branchBound) blockers.push('CONTEXT_BRANCH_MISMATCH');
    const baseBound = provBase !== null && base === provBase;
    if (!baseBound) blockers.push('CONTEXT_BASE_MISMATCH');
    const headBound = provHead !== null && head === provHead;
    if (!headBound) blockers.push('CONTEXT_HEAD_MISMATCH');
    const testsBound = provTests.length > 0 && sameStringSet(requiredTests, provTests);
    if (!testsBound) blockers.push('CONTEXT_REQUIRED_TESTS_MISMATCH');
    machineGates.push({ gate: 'context-bound-to-evidence', passed: branchBound && baseBound && headBound && testsBound });
  }

  if (machineGates.some((g) => !g.passed)) blockers.push('MACHINE_GATE_FAILED');

  const uniqueBlockers = [...new Set(blockers)];
  const overall: AcceptancePreflight['overall'] = uniqueBlockers.length === 0 ? 'PREFLIGHT_READY' : 'PREFLIGHT_NOT_READY';
  const withoutDigest: Omit<AcceptancePreflight, 'preflightDigest'> = {
    report: 'phase-230-promotion-acceptance-preflight',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    approvalsGranted: [], // always empty: this preflight grants nothing
    overall,
    base,
    head,
    commitCount,
    requiredTests,
    machineGates,
    humanGatesRemaining: PREFLIGHT_HUMAN_GATES,
    blockers: uniqueBlockers,
    disclaimers: PREFLIGHT_DISCLAIMERS,
  };
  return { ...withoutDigest, preflightDigest: digest('phase-230-acceptance-preflight', JSON.stringify(withoutDigest)) };
}

function pathFreeString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value)) return null;
  return value;
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}
function asSha40(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
