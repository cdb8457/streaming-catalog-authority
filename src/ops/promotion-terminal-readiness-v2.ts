import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Local, non-live TERMINAL readiness manifest v2 -- the final local-only readiness record. Where the v1
// terminal closure (BL) tied together the review-evidence chain, v2 additionally consumes the pack
// component-integrity verifier (BM), the aggregator digest fail-open audit, the artifact generation/export
// manifest, the negative-evidence adversarial corpus, and the automation/watchdog hygiene report, and
// confirms final local-only readiness only when every one is present, valid, green, and carries a self-
// digest that RECOMPUTES against its body (delegated to the authoritative self-digest verifier). It fails
// closed on any missing, stale/not-green, or digest-mismatched input. It reads parsed JSON only; it performs
// no promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes nothing live.
// CONFIRMED means the full local evidence set is complete and self-consistent for coordinator review -- it
// is NOT an approval, a merge, or a Phase 231 / live-promotion authorization, and the human gates remain.

export interface TerminalReadinessV2Input {
  readonly terminalClosure?: unknown;
  readonly packComponentIntegrity?: unknown;
  readonly aggregatorDigestAudit?: unknown;
  readonly artifactExportManifest?: unknown;
  readonly negativeEvidenceCorpus?: unknown;
  readonly watchdogHygiene?: unknown;
}

export const READINESS_V2_HUMAN_GATES: readonly string[] = [
  'Human review of the commit range and diff.',
  'Running the full `npm test` aggregate (legacy/live/CRLF/DB suites) if desired.',
  'Explicit coordinator ACCEPT recorded via the acceptance seal.',
  'The merge / tag / push-to-master action itself -- a human operator step NOT performed or authorized here.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const READINESS_V2_BOUNDARY =
  'No deploy launcher run, no real media-library write, no live Jellyfin call, no merge/tag/push/master, and no Phase 231 or live-promotion authorization is implied or performed by this manifest.';

export const READINESS_V2_DISCLAIMERS: readonly string[] = [
  'CONFIRMED terminal readiness is NOT an approval, a merge, or a live promotion.',
  'This manifest does NOT authorize Phase 231.',
  'No live Jellyfin call or real media write is implied or performed by this manifest.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface ReadinessComponent { readonly component: string; readonly present: boolean; readonly ok: boolean; }

export interface TerminalReadinessV2Manifest {
  readonly report: 'phase-230-promotion-terminal-readiness-v2';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'TERMINAL_READINESS_V2_CONFIRMED' | 'TERMINAL_READINESS_V2_NOT_CONFIRMED';
  readonly components: readonly ReadinessComponent[];
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly humanGates: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly readinessV2Digest: string;
}

interface Spec {
  readonly key: keyof TerminalReadinessV2Input;
  readonly component: string;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly digestField: string;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
}

const SPECS: readonly Spec[] = [
  { key: 'terminalClosure', component: 'terminal-closure', report: 'phase-230-promotion-terminal-closure-manifest', ok: (o) => o.overall === 'TERMINAL_CLOSURE_CONFIRMED', digestField: 'terminalDigest', missing: 'TERMINAL_CLOSURE_MISSING', invalid: 'TERMINAL_CLOSURE_INVALID', notOk: 'TERMINAL_CLOSURE_NOT_CONFIRMED' },
  { key: 'packComponentIntegrity', component: 'pack-component-integrity', report: 'phase-230-promotion-pack-component-integrity', ok: (o) => o.overall === 'PACK_INTEGRITY_VERIFIED', digestField: 'integrityDigest', missing: 'PACK_INTEGRITY_MISSING', invalid: 'PACK_INTEGRITY_INVALID', notOk: 'PACK_INTEGRITY_NOT_VERIFIED' },
  { key: 'aggregatorDigestAudit', component: 'aggregator-digest-audit', report: 'phase-230-promotion-aggregator-digest-audit', ok: (o) => o.overall === 'AGGREGATOR_AUDIT_CLEAN', digestField: 'auditDigest', missing: 'AGGREGATOR_AUDIT_MISSING', invalid: 'AGGREGATOR_AUDIT_INVALID', notOk: 'AGGREGATOR_AUDIT_NOT_CLEAN' },
  { key: 'artifactExportManifest', component: 'artifact-export-manifest', report: 'phase-230-promotion-artifact-export-manifest', ok: (o) => o.overall === 'ARTIFACT_EXPORT_MANIFEST_COMPLETE', digestField: 'exportDigest', missing: 'ARTIFACT_EXPORT_MISSING', invalid: 'ARTIFACT_EXPORT_INVALID', notOk: 'ARTIFACT_EXPORT_NOT_COMPLETE' },
  { key: 'negativeEvidenceCorpus', component: 'negative-evidence-corpus', report: 'phase-230-promotion-negative-evidence-corpus', ok: (o) => o.overall === 'CORPUS_HELD', digestField: 'corpusDigest', missing: 'NEGATIVE_CORPUS_MISSING', invalid: 'NEGATIVE_CORPUS_INVALID', notOk: 'NEGATIVE_CORPUS_BREACHED' },
  { key: 'watchdogHygiene', component: 'watchdog-hygiene', report: 'phase-230-promotion-watchdog-hygiene', ok: (o) => o.overall === 'WATCHDOG_HYGIENE_CLEAN', digestField: 'watchdogDigest', missing: 'WATCHDOG_HYGIENE_MISSING', invalid: 'WATCHDOG_HYGIENE_INVALID', notOk: 'WATCHDOG_HYGIENE_VIOLATED' },
];

export function buildTerminalReadinessV2(input: TerminalReadinessV2Input): TerminalReadinessV2Manifest {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};
  const components: ReadinessComponent[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) { blockers.push(spec.missing); return { component: spec.component, present: false, ok: false }; }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { component: spec.component, present: true, ok: false }; }
    // Fail closed on the binding digest: every present input must carry a valid sha256 self-digest that
    // actually RECOMPUTES against its body. A green status paired with a well-formed but wrong digest -- a
    // tampered/forged body -- fails here.
    const rawDigest = obj[spec.digestField];
    const d = asSha256(rawDigest);
    const digestVerified = d !== undefined && verifySelfDigests([obj]).results[0]?.verified === true;
    if (rawDigest === undefined) blockers.push('COMPONENT_DIGEST_MISSING');
    else if (d === undefined) blockers.push('COMPONENT_DIGEST_INVALID');
    else if (!digestVerified) blockers.push('COMPONENT_DIGEST_MISMATCH');
    if (digestVerified) boundDigests[spec.component] = d;
    const okState = spec.ok(obj);
    if (!okState) blockers.push(spec.notOk);
    return { component: spec.component, present: true, ok: okState && digestVerified };
  });

  const uniqueBlockers = [...new Set(blockers)];
  const overall: TerminalReadinessV2Manifest['overall'] = uniqueBlockers.length === 0 ? 'TERMINAL_READINESS_V2_CONFIRMED' : 'TERMINAL_READINESS_V2_NOT_CONFIRMED';
  const withoutDigest: Omit<TerminalReadinessV2Manifest, 'readinessV2Digest'> = {
    report: 'phase-230-promotion-terminal-readiness-v2',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    components,
    boundDigests,
    humanGates: READINESS_V2_HUMAN_GATES,
    boundary: READINESS_V2_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: READINESS_V2_DISCLAIMERS,
  };
  return { ...withoutDigest, readinessV2Digest: digest('phase-230-terminal-readiness-v2', JSON.stringify(withoutDigest)) };
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
