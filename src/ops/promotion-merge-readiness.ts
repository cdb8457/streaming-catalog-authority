import { createHash } from 'node:crypto';

// Local, non-live merge-readiness DRY-RUN manifest. Given the coordinator evidence release checklist (and,
// optionally, the final summary), it reports whether the branch's local evidence preconditions for a merge
// are met -- WITHOUT performing, staging, or authorizing any merge, tag, or push to master. It reads parsed
// JSON only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin, runs no
// git action, and authorizes nothing live. `mergeActionsPerformed` is always empty and `dryRun` is always
// true: this manifest is advisory evidence only, never an action.

export interface MergeReadinessInput {
  readonly releaseChecklist?: unknown;
  readonly finalSummary?: unknown;
}

export const MERGE_READINESS_HUMAN_GATES: readonly string[] = [
  'The merge / tag / push-to-master action itself, which is a human operator step performed outside this tooling and is NOT authorized here.',
  'Explicit coordinator ACCEPT recorded by the acceptance seal.',
  'The live promotion, which is Phase 229-defined, operator-run, and out of scope here.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const MERGE_READINESS_DISCLAIMERS: readonly string[] = [
  'This is a DRY RUN: no merge, tag, branch, or push to master is performed, staged, or authorized.',
  'This manifest does NOT authorize Phase 231 or live promotion.',
  'No live Jellyfin call or real Movies write is implied or performed by this manifest.',
  'This is redaction-safe, advisory evidence only -- not an action and not an authorization.',
];

export interface MergeReadinessCheck { readonly check: string; readonly present: boolean; readonly pass: boolean; }

export interface MergeReadinessManifest {
  readonly report: 'phase-230-promotion-merge-readiness-dry-run';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly dryRun: true;
  readonly mergeActionsPerformed: readonly string[];
  readonly overall: 'MERGE_DRY_RUN_READY' | 'MERGE_DRY_RUN_BLOCKED';
  readonly checks: readonly MergeReadinessCheck[];
  readonly blockers: readonly string[];
  readonly humanGates: readonly string[];
  readonly disclaimers: readonly string[];
  readonly manifestDigest: string;
}

interface Spec {
  readonly key: keyof MergeReadinessInput;
  readonly check: string;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
  readonly required: boolean;
}

const SPECS: readonly Spec[] = [
  { key: 'releaseChecklist', check: 'release-checklist', report: 'phase-230-promotion-coordinator-release-checklist', ok: (o) => o.overall === 'RELEASE_CHECKLIST_CLEARED', missing: 'RELEASE_CHECKLIST_MISSING', invalid: 'RELEASE_CHECKLIST_INVALID', notOk: 'RELEASE_CHECKLIST_NOT_CLEARED', required: true },
  { key: 'finalSummary', check: 'final-summary', report: 'phase-230-promotion-coordinator-final-summary', ok: (o) => o.overall === 'FINAL_SUMMARY_READY', missing: 'FINAL_SUMMARY_MISSING', invalid: 'FINAL_SUMMARY_INVALID', notOk: 'FINAL_SUMMARY_NOT_READY', required: false },
];

export function buildMergeReadiness(input: MergeReadinessInput): MergeReadinessManifest {
  const blockers: string[] = [];
  const checks: MergeReadinessCheck[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) {
      if (spec.required) { blockers.push(spec.missing); return { check: spec.check, present: false, pass: false }; }
      return { check: spec.check, present: false, pass: true };
    }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { check: spec.check, present: true, pass: false }; }
    const pass = spec.ok(obj);
    if (!pass) blockers.push(spec.notOk);
    return { check: spec.check, present: true, pass };
  });

  const overall: MergeReadinessManifest['overall'] = blockers.length === 0 ? 'MERGE_DRY_RUN_READY' : 'MERGE_DRY_RUN_BLOCKED';
  const withoutDigest: Omit<MergeReadinessManifest, 'manifestDigest'> = {
    report: 'phase-230-promotion-merge-readiness-dry-run',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    dryRun: true,
    mergeActionsPerformed: [], // always empty: this manifest never performs a merge/tag/master action
    overall,
    checks,
    blockers,
    humanGates: MERGE_READINESS_HUMAN_GATES,
    disclaimers: MERGE_READINESS_DISCLAIMERS,
  };
  return { ...withoutDigest, manifestDigest: digest('phase-230-merge-readiness', JSON.stringify(withoutDigest)) };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
