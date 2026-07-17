import { createHash } from 'node:crypto';

// Local, non-live merge-review evidence pack. It assembles the seven closing records -- the coordinator
// final summary, the release checklist, the merge-readiness dry-run manifest, the artifact chain bundle,
// the review automation checklist, the redaction regression corpus, and the static boundary policy -- into
// ONE offline reviewer pack. Every component must be present, valid, green, and carry a valid self-digest,
// and the pack cross-binds the whole mesh: the release checklist must have cleared the exact final summary,
// the chain bundle must have packed the exact final summary / release checklist / merge readiness, and the
// review automation must have verified the exact chain bundle / redaction corpus / boundary policy. A pack
// stitched from different runs fails closed. It reads parsed JSON only; it performs no promotion, never
// touches the real Movies root, never contacts Jellyfin, and authorizes nothing live. No raw paths or
// titles are carried.

export interface ReviewerPackInput {
  readonly finalSummary?: unknown;
  readonly releaseChecklist?: unknown;
  readonly mergeReadiness?: unknown;
  readonly chainBundle?: unknown;
  readonly reviewAutomation?: unknown;
  readonly redactionCorpus?: unknown;
  readonly boundaryPolicy?: unknown;
}

export const REVIEWER_PACK_DISCLAIMERS: readonly string[] = [
  'This reviewer pack does NOT authorize Phase 231.',
  'This reviewer pack does NOT authorize live promotion or any merge/tag/master action.',
  'No live Jellyfin call or real Movies write is implied or performed by this pack.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface PackComponent { readonly component: string; readonly present: boolean; readonly ok: boolean; readonly digest?: string; }
export interface PackBinding { readonly binding: string; readonly ok: boolean; }

// The canonical component set and binding mesh a complete pack must carry -- exported so a consumer can
// fail closed on any missing, unknown, or failing component/binding.
export const EXPECTED_PACK_COMPONENTS: readonly string[] = ['final-summary', 'release-checklist', 'merge-readiness', 'chain-bundle', 'review-automation', 'redaction-corpus', 'boundary-policy'];
export const EXPECTED_PACK_BINDINGS: readonly string[] = ['release-checklist=final-summary', 'chain-bundle=final-summary', 'chain-bundle=release-checklist', 'chain-bundle=merge-readiness', 'review-automation=chain-bundle', 'review-automation=redaction-corpus', 'review-automation=boundary-policy'];

// Redaction-safe provenance carried from the packed (digest-bound) merge-readiness manifest, so a consumer
// can bind a supplied review context (branch/base/head/required tests) to the authoritative evidence.
export interface PackProvenance {
  readonly branch: string | null;
  readonly base: string | null;
  readonly head: string | null;
  readonly commitCount: number;
  readonly requiredTests: readonly string[];
}

export interface ReviewerPack {
  readonly report: 'phase-230-promotion-merge-review-evidence-pack';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'REVIEWER_PACK_READY' | 'REVIEWER_PACK_BLOCKED';
  readonly components: readonly PackComponent[];
  readonly bindings: readonly PackBinding[];
  readonly provenance: PackProvenance;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly packDigest: string;
}

interface Spec {
  readonly key: keyof ReviewerPackInput;
  readonly component: string;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly digestField: string;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
}

const SPECS: readonly Spec[] = [
  { key: 'finalSummary', component: 'final-summary', report: 'phase-230-promotion-coordinator-final-summary', ok: (o) => o.overall === 'FINAL_SUMMARY_READY', digestField: 'summaryDigest', missing: 'FINAL_SUMMARY_MISSING', invalid: 'FINAL_SUMMARY_INVALID', notOk: 'FINAL_SUMMARY_NOT_READY' },
  { key: 'releaseChecklist', component: 'release-checklist', report: 'phase-230-promotion-coordinator-release-checklist', ok: (o) => o.overall === 'RELEASE_CHECKLIST_CLEARED', digestField: 'checklistDigest', missing: 'RELEASE_CHECKLIST_MISSING', invalid: 'RELEASE_CHECKLIST_INVALID', notOk: 'RELEASE_CHECKLIST_NOT_CLEARED' },
  { key: 'mergeReadiness', component: 'merge-readiness', report: 'phase-230-promotion-merge-readiness-dry-run', ok: (o) => o.overall === 'MERGE_DRY_RUN_READY', digestField: 'manifestDigest', missing: 'MERGE_READINESS_MISSING', invalid: 'MERGE_READINESS_INVALID', notOk: 'MERGE_READINESS_NOT_READY' },
  { key: 'chainBundle', component: 'chain-bundle', report: 'phase-230-promotion-artifact-chain-bundle', ok: (o) => o.overall === 'CHAIN_BUNDLE_READY', digestField: 'chainDigest', missing: 'CHAIN_BUNDLE_MISSING', invalid: 'CHAIN_BUNDLE_INVALID', notOk: 'CHAIN_BUNDLE_NOT_READY' },
  { key: 'reviewAutomation', component: 'review-automation', report: 'phase-230-promotion-review-automation', ok: (o) => o.overall === 'REVIEW_AUTOMATION_PASSED', digestField: 'automationDigest', missing: 'REVIEW_AUTOMATION_MISSING', invalid: 'REVIEW_AUTOMATION_INVALID', notOk: 'REVIEW_AUTOMATION_NOT_PASSED' },
  { key: 'redactionCorpus', component: 'redaction-corpus', report: 'phase-230-promotion-redaction-corpus', ok: (o) => o.overall === 'REDACTION_CORPUS_HELD', digestField: 'redactionDigest', missing: 'REDACTION_CORPUS_MISSING', invalid: 'REDACTION_CORPUS_INVALID', notOk: 'REDACTION_CORPUS_BREACHED' },
  { key: 'boundaryPolicy', component: 'boundary-policy', report: 'phase-230-promotion-boundary-policy', ok: (o) => o.overall === 'BOUNDARY_POLICY_ENFORCED', digestField: 'policyDigest', missing: 'BOUNDARY_POLICY_MISSING', invalid: 'BOUNDARY_POLICY_INVALID', notOk: 'BOUNDARY_POLICY_VIOLATED' },
];

export function buildReviewerPack(input: ReviewerPackInput): ReviewerPack {
  const blockers: string[] = [];
  const parsed: Partial<Record<keyof ReviewerPackInput, Record<string, unknown>>> = {};
  const components: PackComponent[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) { blockers.push(spec.missing); return { component: spec.component, present: false, ok: false }; }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { component: spec.component, present: true, ok: false }; }
    parsed[spec.key] = obj;
    // Fail closed on binding evidence: every present component must carry a valid sha256 self-digest.
    const rawDigest = obj[spec.digestField];
    const d = asSha256(rawDigest);
    if (rawDigest === undefined) blockers.push('COMPONENT_DIGEST_MISSING');
    else if (d === undefined) blockers.push('COMPONENT_DIGEST_INVALID');
    const okState = spec.ok(obj);
    if (!okState) blockers.push(spec.notOk);
    return { component: spec.component, present: true, ok: okState && d !== undefined, ...(d ? { digest: d } : {}) };
  });

  // Full-mesh digest bindings: every downstream record must have been built over the exact upstream ones.
  const bindings: PackBinding[] = [];
  const bind = (name: string, left: string | undefined, right: string | undefined): void => {
    const ok = left !== undefined && left === right;
    if (!ok) blockers.push('PACK_BINDING_MISMATCH');
    bindings.push({ binding: name, ok });
  };
  const fs = parsed.finalSummary;
  const rc = parsed.releaseChecklist;
  const mr = parsed.mergeReadiness;
  const cb = parsed.chainBundle;
  const ra = parsed.reviewAutomation;
  const rd = parsed.redactionCorpus;
  const bp = parsed.boundaryPolicy;
  if (rc && fs) bind('release-checklist=final-summary', asSha256(asObject(rc.boundDigests)['final-summary']), asSha256(fs.summaryDigest));
  if (cb && fs) bind('chain-bundle=final-summary', componentDigest(cb, 'final-summary'), asSha256(fs.summaryDigest));
  if (cb && rc) bind('chain-bundle=release-checklist', componentDigest(cb, 'release-checklist'), asSha256(rc.checklistDigest));
  if (cb && mr) bind('chain-bundle=merge-readiness', componentDigest(cb, 'merge-readiness'), asSha256(mr.manifestDigest));
  if (ra && cb) bind('review-automation=chain-bundle', asSha256(asObject(ra.boundDigests)['chain-bundle']), asSha256(cb.chainDigest));
  if (ra && rd) bind('review-automation=redaction-corpus', asSha256(asObject(ra.boundDigests)['redaction-corpus']), asSha256(rd.redactionDigest));
  if (ra && bp) bind('review-automation=boundary-policy', asSha256(asObject(ra.boundDigests)['boundary-policy']), asSha256(bp.policyDigest));

  // Provenance from the packed merge-readiness manifest (itself digest-bound above). All fields are
  // redaction-safe: hex shas, a path-free branch name, a count, and path-free command labels.
  const provenance: PackProvenance = {
    branch: mr ? pathFreeString(mr.branch) : null,
    base: mr ? asSha40(mr.base) ?? null : null,
    head: mr ? asSha40(mr.head) ?? null : null,
    commitCount: mr && Array.isArray(mr.commitsSinceBase) ? mr.commitsSinceBase.length : 0,
    requiredTests: mr && Array.isArray(mr.requiredTests) ? mr.requiredTests.filter((t): t is string => typeof t === 'string' && pathFreeString(t) !== null) : [],
  };

  const overall: ReviewerPack['overall'] = blockers.length === 0 ? 'REVIEWER_PACK_READY' : 'REVIEWER_PACK_BLOCKED';
  const withoutDigest: Omit<ReviewerPack, 'packDigest'> = {
    report: 'phase-230-promotion-merge-review-evidence-pack',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    components,
    bindings,
    provenance,
    blockers: [...new Set(blockers)],
    disclaimers: REVIEWER_PACK_DISCLAIMERS,
  };
  return { ...withoutDigest, packDigest: digest('phase-230-reviewer-pack', JSON.stringify(withoutDigest)) };
}

function componentDigest(report: Record<string, unknown>, name: string): string | undefined {
  const comps = report.components;
  if (!Array.isArray(comps)) return undefined;
  for (const c of comps) { const co = asObject(c); if (co.component === name) return asSha256(co.digest); }
  return undefined;
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
function pathFreeString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value)) return null;
  return value;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
