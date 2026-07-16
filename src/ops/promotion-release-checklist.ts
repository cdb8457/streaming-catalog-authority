import { createHash } from 'node:crypto';

// Local, non-live coordinator evidence release checklist. It composes the coordinator final summary, the
// negative-evidence adversarial corpus, and the closure/dependency hygiene report (and, optionally, the
// self-digest verification) into an explicit go/no-go release checklist: every required item must be
// present, valid, and passing before the evidence is cleared for coordinator release. It reads parsed JSON
// only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin, and
// authorizes nothing live. Clearing the checklist is NOT a merge, a release action, or a Phase 231
// authorization -- only a statement that the local evidence preconditions are met.

export interface ReleaseChecklistInput {
  readonly finalSummary?: unknown;
  readonly negativeCorpus?: unknown;
  readonly closureHygiene?: unknown;
  readonly selfDigest?: unknown;
}

export const RELEASE_CHECKLIST_HUMAN_GATES: readonly string[] = [
  'Approval authoring and independent attestation by a human operator.',
  'The live promotion itself, which is Phase 229-defined, operator-run, and out of scope here.',
  'Explicit coordinator ACCEPT recorded by the acceptance seal.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const RELEASE_CHECKLIST_DISCLAIMERS: readonly string[] = [
  'Clearing this checklist does NOT authorize Phase 231.',
  'Clearing this checklist does NOT authorize live promotion or any merge/tag/master action.',
  'No live Jellyfin call or real Movies write is implied or performed by this checklist.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface ChecklistItem { readonly item: string; readonly present: boolean; readonly pass: boolean; }

export interface ReleaseChecklist {
  readonly report: 'phase-230-promotion-coordinator-release-checklist';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'RELEASE_CHECKLIST_CLEARED' | 'RELEASE_CHECKLIST_BLOCKED';
  readonly items: readonly ChecklistItem[];
  readonly blockers: readonly string[];
  readonly humanGates: readonly string[];
  readonly disclaimers: readonly string[];
  readonly checklistDigest: string;
}

interface Spec {
  readonly key: keyof ReleaseChecklistInput;
  readonly item: string;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
  readonly required: boolean;
}

const SPECS: readonly Spec[] = [
  { key: 'finalSummary', item: 'final-summary', report: 'phase-230-promotion-coordinator-final-summary', ok: (o) => o.overall === 'FINAL_SUMMARY_READY', missing: 'FINAL_SUMMARY_MISSING', invalid: 'FINAL_SUMMARY_INVALID', notOk: 'FINAL_SUMMARY_NOT_READY', required: true },
  { key: 'negativeCorpus', item: 'negative-evidence-corpus', report: 'phase-230-promotion-negative-evidence-corpus', ok: (o) => o.overall === 'CORPUS_HELD', missing: 'NEGATIVE_CORPUS_MISSING', invalid: 'NEGATIVE_CORPUS_INVALID', notOk: 'NEGATIVE_CORPUS_BREACHED', required: true },
  { key: 'closureHygiene', item: 'closure-hygiene', report: 'phase-230-promotion-closure-hygiene', ok: (o) => o.overall === 'HYGIENE_OK', missing: 'CLOSURE_HYGIENE_MISSING', invalid: 'CLOSURE_HYGIENE_INVALID', notOk: 'CLOSURE_HYGIENE_NOT_OK', required: true },
  { key: 'selfDigest', item: 'self-digest', report: 'phase-230-promotion-self-digest-verification', ok: (o) => o.overall === 'ALL_VERIFIED', missing: 'SELF_DIGEST_MISSING', invalid: 'SELF_DIGEST_INVALID', notOk: 'SELF_DIGEST_NOT_VERIFIED', required: false },
];

export function buildReleaseChecklist(input: ReleaseChecklistInput): ReleaseChecklist {
  const blockers: string[] = [];
  const items: ChecklistItem[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) {
      if (spec.required) { blockers.push(spec.missing); return { item: spec.item, present: false, pass: false }; }
      return { item: spec.item, present: false, pass: true }; // optional + absent = not a blocker
    }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { item: spec.item, present: true, pass: false }; }
    const pass = spec.ok(obj);
    if (!pass) blockers.push(spec.notOk);
    return { item: spec.item, present: true, pass };
  });

  const overall: ReleaseChecklist['overall'] = blockers.length === 0 ? 'RELEASE_CHECKLIST_CLEARED' : 'RELEASE_CHECKLIST_BLOCKED';
  const withoutDigest: Omit<ReleaseChecklist, 'checklistDigest'> = {
    report: 'phase-230-promotion-coordinator-release-checklist',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    items,
    blockers,
    humanGates: RELEASE_CHECKLIST_HUMAN_GATES,
    disclaimers: RELEASE_CHECKLIST_DISCLAIMERS,
  };
  return { ...withoutDigest, checklistDigest: digest('phase-230-release-checklist', JSON.stringify(withoutDigest)) };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
