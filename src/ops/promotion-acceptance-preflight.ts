import { createHash } from 'node:crypto';

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

  // Required: the merge-review evidence pack, valid, digest-bound, and READY.
  const rp = input.reviewerPack;
  if (rp === undefined) { blockers.push('REVIEWER_PACK_MISSING'); machineGates.push({ gate: 'reviewer-pack', passed: false }); }
  else {
    const o = asObject(rp);
    if (o.report !== 'phase-230-promotion-merge-review-evidence-pack') { blockers.push('REVIEWER_PACK_INVALID'); machineGates.push({ gate: 'reviewer-pack', passed: false }); }
    else {
      const rawDigest = o.packDigest;
      const d = asSha256(rawDigest);
      if (rawDigest === undefined) blockers.push('COMPONENT_DIGEST_MISSING');
      else if (d === undefined) blockers.push('COMPONENT_DIGEST_INVALID');
      const ready = o.overall === 'REVIEWER_PACK_READY';
      if (!ready) blockers.push('REVIEWER_PACK_NOT_READY');
      machineGates.push({ gate: 'reviewer-pack', passed: ready && d !== undefined });
      // Surface each packed component and the binding mesh as individual machine gates.
      const comps = Array.isArray(o.components) ? o.components : [];
      for (const c of comps) {
        const co = asObject(c);
        if (typeof co.component === 'string') machineGates.push({ gate: co.component, passed: co.ok === true });
      }
      const bindings = Array.isArray(o.bindings) ? o.bindings : [];
      const bindingsOk = bindings.length > 0 && bindings.every((b) => asObject(b).ok === true);
      machineGates.push({ gate: 'pack-binding-mesh', passed: bindingsOk });
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
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function asSha40(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
