import { createHash } from 'node:crypto';

// Local, non-live merge-readiness DRY-RUN manifest. Given the coordinator evidence release checklist, a
// dry-run context (branch / base / head / commits-since-base / required tests), and optionally the final
// summary, it reports whether the branch's local evidence preconditions for a merge are met -- WITHOUT
// performing, staging, or authorizing any merge, tag, or push to master. It reads parsed JSON only; it runs
// no git command, performs no promotion, never touches the real Movies root, never contacts Jellyfin, and
// authorizes nothing live. `dryRun` is always true, `gitInvoked` is always false, and
// `mergeActionsPerformed` is always empty: advisory evidence, never an action.

export interface MergeContext {
  readonly branch?: unknown;
  readonly base?: unknown;
  readonly head?: unknown;
  readonly commits?: unknown;
  readonly requiredTests?: unknown;
}

export interface MergeReadinessInput {
  readonly releaseChecklist?: unknown;
  readonly context?: MergeContext;
  readonly finalSummary?: unknown;
}

export const FULL_NPM_TEST_CAVEAT =
  'The full `npm test` aggregate (legacy / live / CRLF-sensitive / embedded-Postgres / live-Jellyfin suites) is NOT run by the local gate and is out of scope for this dry run; only test:phase230-local was exercised.';

export const MERGE_READINESS_HUMAN_GATES: readonly string[] = [
  'The merge / tag / push-to-master action itself, which is a human operator step performed outside this tooling and is NOT authorized here.',
  'Running the full `npm test` aggregate (legacy/live/CRLF/DB suites) is a human step outside this local gate.',
  'Explicit coordinator ACCEPT recorded by the acceptance seal.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const MERGE_READINESS_DISCLAIMERS: readonly string[] = [
  'This is a DRY RUN: no merge, tag, branch, or push to master is performed, staged, or authorized.',
  'No git command is invoked; the branch/base/head and commit list are read from the supplied context, not from the repository.',
  'This manifest does NOT authorize Phase 231 or live promotion, and implies no live Jellyfin call or real Movies write.',
  'This is redaction-safe, advisory evidence only -- not an action and not an authorization.',
];

export interface MergeReadinessCheck { readonly check: string; readonly present: boolean; readonly pass: boolean; }
export interface MergeCommit { readonly sha: string; readonly subject: string; }

export interface MergeReadinessManifest {
  readonly report: 'phase-230-promotion-merge-readiness-dry-run';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly dryRun: true;
  readonly gitInvoked: false;
  readonly mergeActionsPerformed: readonly string[];
  readonly overall: 'MERGE_DRY_RUN_READY' | 'MERGE_DRY_RUN_BLOCKED';
  readonly branch: string | null;
  readonly base: string | null;
  readonly head: string | null;
  readonly commitsSinceBase: readonly MergeCommit[];
  readonly requiredTests: readonly string[];
  readonly fullNpmTestCaveat: string;
  readonly checks: readonly MergeReadinessCheck[];
  readonly openBlockers: readonly string[];
  readonly blockers: readonly string[];
  readonly humanGates: readonly string[];
  readonly disclaimers: readonly string[];
  readonly manifestDigest: string;
}

export function buildMergeReadiness(input: MergeReadinessInput): MergeReadinessManifest {
  const blockers: string[] = [];
  const checks: MergeReadinessCheck[] = [];

  // Required: the release checklist must be present, valid, and CLEARED.
  let checklistObj: Record<string, unknown> | undefined;
  const rc = input.releaseChecklist;
  if (rc === undefined) { blockers.push('RELEASE_CHECKLIST_MISSING'); checks.push({ check: 'release-checklist', present: false, pass: false }); }
  else {
    const o = asObject(rc);
    if (o.report !== 'phase-230-promotion-coordinator-release-checklist') { blockers.push('RELEASE_CHECKLIST_INVALID'); checks.push({ check: 'release-checklist', present: true, pass: false }); }
    else {
      checklistObj = o;
      const pass = o.overall === 'RELEASE_CHECKLIST_CLEARED';
      if (!pass) blockers.push('RELEASE_CHECKLIST_NOT_CLEARED');
      checks.push({ check: 'release-checklist', present: true, pass });
    }
  }

  // A checklist that claims CLEARED must actually carry the required run bindings; otherwise it cannot be
  // trusted as a merge precondition (defends against a forged/stale "cleared" checklist).
  if (checklistObj && checklistObj.overall === 'RELEASE_CHECKLIST_CLEARED') {
    const bd = asObject(checklistObj.boundDigests);
    const requiredBindings = ['review-bundle', 'transcript', 'final-summary', 'closure-hygiene', 'negative-evidence-corpus'];
    const complete = requiredBindings.every((k) => asSha256(bd[k]) !== undefined);
    if (!complete) blockers.push('CHECKLIST_BINDING_INCOMPLETE');
    checks.push({ check: 'checklist-bindings-complete', present: true, pass: complete });
  }

  // Optional: a supplied final summary must be READY and must bind to the checklist it was cleared under.
  const fs = input.finalSummary;
  if (fs !== undefined) {
    const o = asObject(fs);
    if (o.report !== 'phase-230-promotion-coordinator-final-summary') { blockers.push('FINAL_SUMMARY_INVALID'); checks.push({ check: 'final-summary', present: true, pass: false }); }
    else {
      const ready = o.overall === 'FINAL_SUMMARY_READY';
      if (!ready) blockers.push('FINAL_SUMMARY_NOT_READY');
      checks.push({ check: 'final-summary', present: true, pass: ready });
      const boundFinal = checklistObj ? asSha256(asObject(checklistObj.boundDigests)['final-summary']) : undefined;
      const bindOk = boundFinal !== undefined && boundFinal === asSha256(o.summaryDigest);
      if (!bindOk) blockers.push('FINAL_SUMMARY_BINDING_MISMATCH');
      checks.push({ check: 'final-summary=checklist-binding', present: true, pass: bindOk });
    }
  }

  // Required: a well-formed dry-run context (branch / base / head / commits / required tests).
  const ctx = input.context;
  let branch: string | null = null;
  let base: string | null = null;
  let head: string | null = null;
  let commitsSinceBase: MergeCommit[] = [];
  let requiredTests: string[] = [];
  if (ctx === undefined) { blockers.push('MERGE_CONTEXT_MISSING'); checks.push({ check: 'context', present: false, pass: false }); }
  else {
    const branchV = pathFreeString(ctx.branch);
    const baseV = asSha40(ctx.base) ?? null;
    const headV = asSha40(ctx.head) ?? null;
    const commitsV = normalizeCommits(ctx.commits);
    const testsV = normalizeRequiredTests(ctx.requiredTests);
    const ctxOk = branchV !== null && baseV !== null && headV !== null && commitsV !== null && testsV !== null
      && commitsV.length > 0 && testsV.length > 0;
    if (!ctxOk) blockers.push('MERGE_CONTEXT_INVALID');
    checks.push({ check: 'context', present: true, pass: ctxOk });
    branch = branchV;
    base = baseV;
    head = headV;
    commitsSinceBase = commitsV ?? [];
    requiredTests = testsV ?? [];
  }

  const checklistBlockers = checklistObj && Array.isArray(checklistObj.blockers)
    ? (checklistObj.blockers as unknown[]).filter((b): b is string => typeof b === 'string') : [];
  const openBlockers = [...new Set([...checklistBlockers, ...blockers])];

  const overall: MergeReadinessManifest['overall'] = blockers.length === 0 ? 'MERGE_DRY_RUN_READY' : 'MERGE_DRY_RUN_BLOCKED';
  const withoutDigest: Omit<MergeReadinessManifest, 'manifestDigest'> = {
    report: 'phase-230-promotion-merge-readiness-dry-run',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    dryRun: true,
    gitInvoked: false,
    mergeActionsPerformed: [], // always empty: this manifest never performs a merge/tag/master action
    overall,
    branch,
    base,
    head,
    commitsSinceBase,
    requiredTests,
    fullNpmTestCaveat: FULL_NPM_TEST_CAVEAT,
    checks,
    openBlockers,
    blockers,
    humanGates: MERGE_READINESS_HUMAN_GATES,
    disclaimers: MERGE_READINESS_DISCLAIMERS,
  };
  return { ...withoutDigest, manifestDigest: digest('phase-230-merge-readiness', JSON.stringify(withoutDigest)) };
}

// Returns the validated commit list, or null if any row is malformed (so the caller blocks).
function normalizeCommits(value: unknown): MergeCommit[] | null {
  if (!Array.isArray(value)) return null;
  const out: MergeCommit[] = [];
  for (const c of value) {
    const o = asObject(c);
    const sha = asSha40(o.sha);
    const subject = pathFreeString(o.subject);
    if (sha === undefined || subject === null) return null;
    out.push({ sha, subject });
  }
  return out;
}
function normalizeRequiredTests(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const t of value) { const s = pathFreeString(t); if (s === null) return null; out.push(s); }
  return out;
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
