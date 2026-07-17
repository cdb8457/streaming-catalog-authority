import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';
import { EXPECTED_PACK_COMPONENTS } from './promotion-reviewer-pack.js';

// Local, non-live pack component-integrity verifier. The merge-review evidence pack (AW) carries only the
// REDACTED self-digest of each packed record, and the acceptance preflight (AX) recomputes the pack's own
// self-digest but trusts the pack's per-component `ok` flags -- so nothing in the acceptance chain ever
// recomputes the self-digest of the individual packed reports. This verifier closes that gap: given the
// pack PLUS the authoritative source reports, it recomputes every component's self-digest (delegated to the
// authoritative self-digest verifier), confirms each is in its expected green state, and binds the pack's
// redacted component digest back to the recomputed authoritative digest. A forged pack digest cannot match
// a real report, and a green-status-but-tampered component fails its recompute. It reads parsed JSON only;
// it performs no promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes
// nothing live. VERIFIED means the packed component digests are bound to authoritative recomputed records
// -- it is NOT an approval, a merge, or a Phase 231 / live-promotion authorization. It carries no raw paths.

export interface PackComponentIntegrityInput {
  readonly reviewerPack?: unknown;
  readonly finalSummary?: unknown;
  readonly releaseChecklist?: unknown;
  readonly mergeReadiness?: unknown;
  readonly chainBundle?: unknown;
  readonly reviewAutomation?: unknown;
  readonly redactionCorpus?: unknown;
  readonly boundaryPolicy?: unknown;
}

export const PACK_INTEGRITY_DISCLAIMERS: readonly string[] = [
  'VERIFIED integrity is NOT an approval, a merge, or a live promotion.',
  'This verifier does NOT authorize Phase 231.',
  'No live Jellyfin call or real Movies write is implied or performed by this verifier.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface ComponentIntegrityCheck {
  readonly component: string;
  readonly present: boolean;
  readonly recomputes: boolean; // the authoritative report's stated self-digest recomputes against its body
  readonly green: boolean;      // the authoritative report is in its expected green state
  readonly boundToPack: boolean; // the pack's redacted digest equals the recomputed authoritative digest
}

export interface PackComponentIntegrityReport {
  readonly report: 'phase-230-promotion-pack-component-integrity';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'PACK_INTEGRITY_VERIFIED' | 'PACK_INTEGRITY_BROKEN';
  readonly packVerified: boolean;
  readonly components: readonly ComponentIntegrityCheck[];
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly verifiedCount: number;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly integrityDigest: string;
}

interface Spec {
  readonly key: keyof PackComponentIntegrityInput;
  readonly component: string;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly digestField: string;
}

// The authoritative source report for each packed component -- report id, expected green state, and the
// trailing self-digest field. The component set is asserted equal to EXPECTED_PACK_COMPONENTS below.
const SPECS: readonly Spec[] = [
  { key: 'finalSummary', component: 'final-summary', report: 'phase-230-promotion-coordinator-final-summary', ok: (o) => o.overall === 'FINAL_SUMMARY_READY', digestField: 'summaryDigest' },
  { key: 'releaseChecklist', component: 'release-checklist', report: 'phase-230-promotion-coordinator-release-checklist', ok: (o) => o.overall === 'RELEASE_CHECKLIST_CLEARED', digestField: 'checklistDigest' },
  { key: 'mergeReadiness', component: 'merge-readiness', report: 'phase-230-promotion-merge-readiness-dry-run', ok: (o) => o.overall === 'MERGE_DRY_RUN_READY', digestField: 'manifestDigest' },
  { key: 'chainBundle', component: 'chain-bundle', report: 'phase-230-promotion-artifact-chain-bundle', ok: (o) => o.overall === 'CHAIN_BUNDLE_READY', digestField: 'chainDigest' },
  { key: 'reviewAutomation', component: 'review-automation', report: 'phase-230-promotion-review-automation', ok: (o) => o.overall === 'REVIEW_AUTOMATION_PASSED', digestField: 'automationDigest' },
  { key: 'redactionCorpus', component: 'redaction-corpus', report: 'phase-230-promotion-redaction-corpus', ok: (o) => o.overall === 'REDACTION_CORPUS_HELD', digestField: 'redactionDigest' },
  { key: 'boundaryPolicy', component: 'boundary-policy', report: 'phase-230-promotion-boundary-policy', ok: (o) => o.overall === 'BOUNDARY_POLICY_ENFORCED', digestField: 'policyDigest' },
];

// Drift guard: the verifier must cover exactly the canonical pack component set.
export const COVERS_EXPECTED_PACK_COMPONENTS: boolean =
  SPECS.length === EXPECTED_PACK_COMPONENTS.length && SPECS.every((s, i) => s.component === EXPECTED_PACK_COMPONENTS[i]);

export function buildPackComponentIntegrity(input: PackComponentIntegrityInput): PackComponentIntegrityReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};

  // The pack: present, valid, self-digest recomputes, READY. Its redacted component digests are trusted
  // (extracted) only when the pack's own self-digest recomputes.
  let packVerified = false;
  const packDigests = new Map<string, string>();
  const rp = input.reviewerPack;
  if (rp === undefined) blockers.push('PACK_MISSING');
  else {
    const o = asObject(rp);
    if (o.report !== 'phase-230-promotion-merge-review-evidence-pack') blockers.push('PACK_INVALID');
    else {
      const packDigestOk = verifySelfDigests([o]).overall === 'ALL_VERIFIED';
      if (!packDigestOk) blockers.push('PACK_DIGEST_MISMATCH');
      const ready = o.overall === 'REVIEWER_PACK_READY';
      if (!ready) blockers.push('PACK_NOT_READY');
      packVerified = packDigestOk && ready;
      if (packDigestOk && Array.isArray(o.components)) {
        for (const c of o.components) {
          const co = asObject(c);
          const dd = asSha256(co.digest);
          if (typeof co.component === 'string' && dd !== undefined) packDigests.set(co.component, dd);
        }
      }
    }
  }

  // Each authoritative source report: recompute its self-digest, confirm it is green, and bind the pack's
  // redacted digest to the recomputed authoritative digest.
  const components: ComponentIntegrityCheck[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) { blockers.push('COMPONENT_REPORT_MISSING'); return { component: spec.component, present: false, recomputes: false, green: false, boundToPack: false }; }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push('COMPONENT_REPORT_INVALID'); return { component: spec.component, present: true, recomputes: false, green: false, boundToPack: false }; }

    const recomputes = verifySelfDigests([obj]).results[0]?.verified === true;
    if (!recomputes) blockers.push('COMPONENT_DIGEST_MISMATCH');
    const green = spec.ok(obj);
    if (!green) blockers.push('COMPONENT_NOT_GREEN');

    // Authoritative digest is trusted only when the report's own self-digest recomputes.
    const authoritative = recomputes ? asSha256(obj[spec.digestField]) : undefined;
    const packDigest = packDigests.get(spec.component);
    let boundToPack = false;
    if (recomputes) {
      if (packDigest === undefined) blockers.push('PACK_DIGEST_UNBOUND');
      else if (authoritative === undefined || packDigest !== authoritative) blockers.push('PACK_COMPONENT_DIGEST_MISMATCH');
      else boundToPack = true;
    }
    if (recomputes && green && boundToPack && authoritative !== undefined) boundDigests[spec.component] = authoritative;
    return { component: spec.component, present: true, recomputes, green, boundToPack };
  });

  const verifiedCount = components.filter((c) => c.present && c.recomputes && c.green && c.boundToPack).length;
  const uniqueBlockers = [...new Set(blockers)];
  const overall: PackComponentIntegrityReport['overall'] = uniqueBlockers.length === 0 ? 'PACK_INTEGRITY_VERIFIED' : 'PACK_INTEGRITY_BROKEN';
  const withoutDigest: Omit<PackComponentIntegrityReport, 'integrityDigest'> = {
    report: 'phase-230-promotion-pack-component-integrity',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    packVerified,
    components,
    boundDigests,
    verifiedCount,
    blockers: uniqueBlockers,
    disclaimers: PACK_INTEGRITY_DISCLAIMERS,
  };
  return { ...withoutDigest, integrityDigest: digest('phase-230-pack-component-integrity', JSON.stringify(withoutDigest)) };
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
