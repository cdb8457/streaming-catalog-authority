import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Local, non-live artifact chain bundle packer for coordinator handoff. It packs the top-level closing
// records -- the coordinator final summary, the release checklist, the merge-readiness dry-run manifest,
// the negative-evidence adversarial corpus, the provenance diff, and the gate coverage report -- into one
// redaction-safe manifest that is CHAIN_BUNDLE_READY only when every component is present, valid, green,
// carries a valid self-digest, and binds consistently (the release checklist must have cleared the exact
// final summary). It reads parsed JSON only; it performs no promotion, never touches the real Movies root,
// never contacts Jellyfin, and authorizes nothing live. It carries no raw paths or titles.

export interface ChainBundleInput {
  readonly finalSummary?: unknown;
  readonly releaseChecklist?: unknown;
  readonly mergeReadiness?: unknown;
  readonly negativeCorpus?: unknown;
  readonly provenanceDiff?: unknown;
  readonly gateCoverage?: unknown;
}

export interface ChainComponent { readonly component: string; readonly present: boolean; readonly ok: boolean; readonly digest?: string; }
export interface ChainBinding { readonly binding: string; readonly ok: boolean; }

export interface ChainBundle {
  readonly report: 'phase-230-promotion-artifact-chain-bundle';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'CHAIN_BUNDLE_READY' | 'CHAIN_BUNDLE_BLOCKED';
  readonly components: readonly ChainComponent[];
  readonly bindings: readonly ChainBinding[];
  readonly blockers: readonly string[];
  readonly chainDigest: string;
}

interface Spec {
  readonly key: keyof ChainBundleInput;
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
  { key: 'negativeCorpus', component: 'negative-evidence-corpus', report: 'phase-230-promotion-negative-evidence-corpus', ok: (o) => o.overall === 'CORPUS_HELD', digestField: 'corpusDigest', missing: 'NEGATIVE_CORPUS_MISSING', invalid: 'NEGATIVE_CORPUS_INVALID', notOk: 'NEGATIVE_CORPUS_BREACHED' },
  { key: 'provenanceDiff', component: 'provenance-diff', report: 'phase-230-promotion-provenance-diff', ok: (o) => o.overall === 'PROVENANCE_ALIGNED', digestField: 'diffDigest', missing: 'PROVENANCE_DIFF_MISSING', invalid: 'PROVENANCE_DIFF_INVALID', notOk: 'PROVENANCE_DIFF_MISALIGNED' },
  { key: 'gateCoverage', component: 'gate-coverage', report: 'phase-230-promotion-gate-coverage', ok: (o) => o.overall === 'GATE_COVERAGE_COMPLETE', digestField: 'coverageDigest', missing: 'GATE_COVERAGE_MISSING', invalid: 'GATE_COVERAGE_INVALID', notOk: 'GATE_COVERAGE_INCOMPLETE' },
];

export function buildChainBundle(input: ChainBundleInput): ChainBundle {
  const blockers: string[] = [];
  const parsed: Partial<Record<keyof ChainBundleInput, Record<string, unknown>>> = {};
  const components: ChainComponent[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) { blockers.push(spec.missing); return { component: spec.component, present: false, ok: false }; }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { component: spec.component, present: true, ok: false }; }
    parsed[spec.key] = obj;
    // Fail closed on the binding digest: a present component must carry a valid sha256 self-digest that
    // actually RECOMPUTES against its body (delegated to the authoritative self-digest verifier). A green
    // status paired with a well-formed but wrong digest -- a tampered/forged body -- fails here.
    const rawDigest = obj[spec.digestField];
    const d = asSha256(rawDigest);
    const digestVerified = d !== undefined && verifySelfDigests([obj]).results[0]?.verified === true;
    if (rawDigest === undefined) blockers.push('COMPONENT_DIGEST_MISSING');
    else if (d === undefined) blockers.push('COMPONENT_DIGEST_INVALID');
    else if (!digestVerified) blockers.push('COMPONENT_DIGEST_MISMATCH');
    const okState = spec.ok(obj);
    if (!okState) blockers.push(spec.notOk);
    return { component: spec.component, present: true, ok: okState && digestVerified, ...(digestVerified ? { digest: d } : {}) };
  });

  // Binding: the release checklist must have cleared the exact final summary packed here.
  const bindings: ChainBinding[] = [];
  const fs = parsed.finalSummary;
  const rc = parsed.releaseChecklist;
  if (fs && rc) {
    const bound = asSha256(asObject(rc.boundDigests)['final-summary']);
    const ok = bound !== undefined && bound === asSha256(fs.summaryDigest);
    if (!ok) blockers.push('FINAL_SUMMARY_BINDING_MISMATCH');
    bindings.push({ binding: 'release-checklist=final-summary', ok });
  }

  const overall: ChainBundle['overall'] = blockers.length === 0 ? 'CHAIN_BUNDLE_READY' : 'CHAIN_BUNDLE_BLOCKED';
  const withoutDigest: Omit<ChainBundle, 'chainDigest'> = {
    report: 'phase-230-promotion-artifact-chain-bundle',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    components,
    bindings,
    blockers: [...new Set(blockers)],
  };
  return { ...withoutDigest, chainDigest: digest('phase-230-artifact-chain-bundle', JSON.stringify(withoutDigest)) };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
