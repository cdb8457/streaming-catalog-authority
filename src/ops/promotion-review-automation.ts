import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Local, non-live coordinator review automation checklist. It composes the automated closing evidence --
// the artifact chain bundle, the redaction regression corpus, and the static boundary policy report --
// into one checklist stating which review steps are machine-verified and which remain HUMAN steps. Every
// required input must be present, valid, green, and carry a valid self-digest (fail closed). It reads
// parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin,
// and authorizes nothing live. Passing automation is NOT an approval: the manual steps -- human diff
// review, coordinator ACCEPT, any merge, and any Phase 231 authorization -- stay human and unauthorized.

export interface ReviewAutomationInput {
  readonly chainBundle?: unknown;
  readonly redactionCorpus?: unknown;
  readonly boundaryPolicy?: unknown;
}

export const MANUAL_REVIEW_STEPS: readonly string[] = [
  'Human review of the commit range and diff.',
  'Running the full `npm test` aggregate (legacy/live/CRLF/DB suites) if desired.',
  'Explicit coordinator ACCEPT recorded via the acceptance seal.',
  'Any merge/tag/push and any Phase 231 authorization -- human steps NOT performed or authorized here.',
];

export const AUTOMATION_DISCLAIMERS: readonly string[] = [
  'Passing automation does NOT authorize Phase 231.',
  'Passing automation does NOT authorize live promotion or any merge/tag/master action.',
  'No live Jellyfin call or real Movies write is implied or performed by this checklist.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface AutomationCheck { readonly check: string; readonly present: boolean; readonly pass: boolean; }

export interface ReviewAutomationReport {
  readonly report: 'phase-230-promotion-review-automation';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'REVIEW_AUTOMATION_PASSED' | 'REVIEW_AUTOMATION_BLOCKED';
  readonly automatedChecks: readonly AutomationCheck[];
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly manualSteps: readonly string[];
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly automationDigest: string;
}

interface Spec {
  readonly key: keyof ReviewAutomationInput;
  readonly check: string;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly digestField: string;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
}

const SPECS: readonly Spec[] = [
  { key: 'chainBundle', check: 'chain-bundle', report: 'phase-230-promotion-artifact-chain-bundle', ok: (o) => o.overall === 'CHAIN_BUNDLE_READY', digestField: 'chainDigest', missing: 'CHAIN_BUNDLE_MISSING', invalid: 'CHAIN_BUNDLE_INVALID', notOk: 'CHAIN_BUNDLE_NOT_READY' },
  { key: 'redactionCorpus', check: 'redaction-corpus', report: 'phase-230-promotion-redaction-corpus', ok: (o) => o.overall === 'REDACTION_CORPUS_HELD', digestField: 'redactionDigest', missing: 'REDACTION_CORPUS_MISSING', invalid: 'REDACTION_CORPUS_INVALID', notOk: 'REDACTION_CORPUS_BREACHED' },
  { key: 'boundaryPolicy', check: 'boundary-policy', report: 'phase-230-promotion-boundary-policy', ok: (o) => o.overall === 'BOUNDARY_POLICY_ENFORCED', digestField: 'policyDigest', missing: 'BOUNDARY_POLICY_MISSING', invalid: 'BOUNDARY_POLICY_INVALID', notOk: 'BOUNDARY_POLICY_VIOLATED' },
];

export function buildReviewAutomation(input: ReviewAutomationInput): ReviewAutomationReport {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};
  const automatedChecks: AutomationCheck[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) { blockers.push(spec.missing); return { check: spec.check, present: false, pass: false }; }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { check: spec.check, present: true, pass: false }; }
    // Fail closed on the binding digest: a present input must carry a valid sha256 self-digest that
    // actually RECOMPUTES against its body (delegated to the authoritative self-digest verifier). A green
    // status paired with a well-formed but wrong digest -- a tampered/forged body -- fails here.
    const rawDigest = obj[spec.digestField];
    const d = asSha256(rawDigest);
    const digestVerified = d !== undefined && verifySelfDigests([obj]).results[0]?.verified === true;
    if (rawDigest === undefined) blockers.push('COMPONENT_DIGEST_MISSING');
    else if (d === undefined) blockers.push('COMPONENT_DIGEST_INVALID');
    else if (!digestVerified) blockers.push('COMPONENT_DIGEST_MISMATCH');
    if (digestVerified) boundDigests[spec.check] = d;
    const okState = spec.ok(obj);
    if (!okState) blockers.push(spec.notOk);
    return { check: spec.check, present: true, pass: okState && digestVerified };
  });

  const overall: ReviewAutomationReport['overall'] = blockers.length === 0 ? 'REVIEW_AUTOMATION_PASSED' : 'REVIEW_AUTOMATION_BLOCKED';
  const withoutDigest: Omit<ReviewAutomationReport, 'automationDigest'> = {
    report: 'phase-230-promotion-review-automation',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    automatedChecks,
    boundDigests,
    manualSteps: MANUAL_REVIEW_STEPS,
    blockers: [...new Set(blockers)],
    disclaimers: AUTOMATION_DISCLAIMERS,
  };
  return { ...withoutDigest, automationDigest: digest('phase-230-review-automation', JSON.stringify(withoutDigest)) };
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
