import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Local, non-live closure-input-bundle auditor. Self-sealing gives integrity, not authenticity: a report can
// recompute its own self-digest and still be forged. Even exact-equality of a parent's boundDigests to a
// supplied child fails if the child is itself a forged green self-sealed report. This auditor validates the
// whole input MESH once: a report is mesh-valid only when it recomputes, is green, AND -- for each aggregator
// -- every one of its declared child bindings EXACTLY equals the recomputed self-digest of a SUPPLIED child
// report that is ITSELF mesh-valid (a fixpoint over the bundle, no cycles). So a bundle that forges the
// aggregators but omits (or shallow-forges) their real children fails closed. It reads parsed JSON only; it
// performs no promotion, never touches the real Movies root, never contacts Jellyfin, and its `authorization`
// field is the constant NONE. It echoes only report short-names, booleans and counts -- never a raw path.
// VERIFIED is not an approval and does not authorize Phase 231. (A fully-consistent deep forgery of every
// report at every level is out of scope: without a trust root that is the signing problem.)

export interface ClosureInputBundleAuditInput { readonly reports?: unknown; }

interface ReportMeta { readonly digestField: string; readonly green: (o: Record<string, unknown>) => boolean; }
// report id -> its self-digest field + expected green overall.
const META: Readonly<Record<string, ReportMeta>> = {
  'phase-230-promotion-review-authorization': { digestField: 'authorizationDigest', green: (o) => o.overall === 'LOCAL_REVIEW_AUTHORIZED' },
  'phase-230-promotion-coordinator-readiness-manifest': { digestField: 'readinessDigest', green: (o) => o.overall === 'COORDINATOR_READINESS_CONFIRMED' },
  'phase-230-promotion-terminal-readiness-v2': { digestField: 'readinessV2Digest', green: (o) => o.overall === 'TERMINAL_READINESS_V2_CONFIRMED' },
  'phase-230-promotion-terminal-closure-manifest': { digestField: 'terminalDigest', green: (o) => o.overall === 'TERMINAL_CLOSURE_CONFIRMED' },
  'phase-230-promotion-commit-range-closure': { digestField: 'closureDigest', green: (o) => o.overall === 'RANGE_CLOSED' },
  'phase-230-promotion-transcript-verification': { digestField: 'verificationDigest', green: (o) => o.overall === 'TRANSCRIPT_VERIFIED' },
  'phase-230-promotion-review-matrix': { digestField: 'reviewMatrixDigest', green: (o) => o.overall === 'REVIEW_MATRIX_READY' },
  'phase-230-promotion-pack-component-integrity': { digestField: 'integrityDigest', green: (o) => o.overall === 'PACK_INTEGRITY_VERIFIED' },
  'phase-230-promotion-aggregator-digest-audit': { digestField: 'auditDigest', green: (o) => o.overall === 'AGGREGATOR_AUDIT_CLEAN' },
  'phase-230-promotion-artifact-export-manifest': { digestField: 'exportDigest', green: (o) => o.overall === 'ARTIFACT_EXPORT_MANIFEST_COMPLETE' },
  'phase-230-promotion-negative-evidence-corpus': { digestField: 'corpusDigest', green: (o) => o.overall === 'CORPUS_HELD' },
  'phase-230-promotion-watchdog-hygiene': { digestField: 'watchdogDigest', green: (o) => o.overall === 'WATCHDOG_HYGIENE_CLEAN' },
  'phase-230-promotion-evidence-minimizer': { digestField: 'minimizerDigest', green: (o) => o.overall === 'MINIMIZED_CLEAN' },
  'phase-230-promotion-regression-oracle': { digestField: 'oracleDigest', green: (o) => o.overall === 'ORACLE_COMPLETE' },
  'phase-230-promotion-acceptance-preflight': { digestField: 'preflightDigest', green: (o) => o.overall === 'PREFLIGHT_READY' },
  'phase-230-promotion-failure-mode-matrix': { digestField: 'failureMatrixDigest', green: (o) => o.overall === 'FAILURE_MATRIX_COMPLETE' },
  'phase-230-promotion-report-schema': { digestField: 'reportSchemaDigest', green: (o) => o.overall === 'REPORT_SCHEMA_OK' },
  'phase-230-promotion-boundary-audit': { digestField: 'auditDigest', green: (o) => o.overall === 'BOUNDARY_AUDIT_CLEAN' },
  'phase-230-promotion-cli-ergonomics': { digestField: 'ergonomicsDigest', green: (o) => o.overall === 'CLI_ERGONOMICS_OK' },
};
// aggregator report id -> its declared child bindings { boundDigests key -> child report id }.
const CHILDREN: Readonly<Record<string, ReadonlyArray<{ key: string; childId: string }>>> = {
  'phase-230-promotion-review-authorization': [
    { key: 'terminal-readiness-v2', childId: 'phase-230-promotion-terminal-readiness-v2' },
    { key: 'terminal-closure', childId: 'phase-230-promotion-terminal-closure-manifest' },
    { key: 'commit-range-closure', childId: 'phase-230-promotion-commit-range-closure' },
    { key: 'transcript-verification', childId: 'phase-230-promotion-transcript-verification' },
    { key: 'review-matrix', childId: 'phase-230-promotion-review-matrix' },
  ],
  'phase-230-promotion-terminal-readiness-v2': [
    { key: 'terminal-closure', childId: 'phase-230-promotion-terminal-closure-manifest' },
    { key: 'pack-component-integrity', childId: 'phase-230-promotion-pack-component-integrity' },
    { key: 'aggregator-digest-audit', childId: 'phase-230-promotion-aggregator-digest-audit' },
    { key: 'artifact-export-manifest', childId: 'phase-230-promotion-artifact-export-manifest' },
    { key: 'negative-evidence-corpus', childId: 'phase-230-promotion-negative-evidence-corpus' },
    { key: 'watchdog-hygiene', childId: 'phase-230-promotion-watchdog-hygiene' },
  ],
  'phase-230-promotion-terminal-closure-manifest': [
    { key: 'transcript-verification', childId: 'phase-230-promotion-transcript-verification' },
    { key: 'evidence-minimizer', childId: 'phase-230-promotion-evidence-minimizer' },
    { key: 'commit-range-closure', childId: 'phase-230-promotion-commit-range-closure' },
    { key: 'regression-oracle', childId: 'phase-230-promotion-regression-oracle' },
    { key: 'coordinator-readiness', childId: 'phase-230-promotion-coordinator-readiness-manifest' },
  ],
  'phase-230-promotion-coordinator-readiness-manifest': [
    { key: 'acceptance-preflight', childId: 'phase-230-promotion-acceptance-preflight' },
    { key: 'failure-matrix', childId: 'phase-230-promotion-failure-mode-matrix' },
    { key: 'report-schema', childId: 'phase-230-promotion-report-schema' },
    { key: 'boundary-audit', childId: 'phase-230-promotion-boundary-audit' },
    { key: 'cli-ergonomics', childId: 'phase-230-promotion-cli-ergonomics' },
  ],
};
// The roots that must be mesh-valid for the bundle to be VERIFIED.
export const BUNDLE_ROOTS: readonly string[] = ['phase-230-promotion-review-authorization', 'phase-230-promotion-coordinator-readiness-manifest', 'phase-230-promotion-terminal-readiness-v2'];

export interface BundleReportResult { readonly report: string; readonly meshValid: boolean; }

export interface ClosureInputBundleAuditReport {
  readonly report: 'phase-230-promotion-closure-input-bundle-audit';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'CLOSURE_BUNDLE_VERIFIED' | 'CLOSURE_BUNDLE_BROKEN';
  readonly reportCount: number;
  readonly meshValidCount: number;
  readonly results: readonly BundleReportResult[];
  readonly blockers: readonly string[];
  readonly auditDigest: string;
}

// Pure predicate used by both this op and its consumers: is the supplied bundle a genuine, fully-resolved
// mesh whose roots (RA, CR, terminal-readiness-v2) are all mesh-valid?
export function meshValidReports(reports: readonly unknown[]): Set<string> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of reports) { const o = asObject(r); if (typeof o.report === 'string') byId.set(o.report, o); }

  const recomputesGreen = (id: string): boolean => {
    const o = byId.get(id); const meta = META[id];
    if (!o || !meta) return false;
    return verifySelfDigests([o]).results[0]?.verified === true && meta.green(o);
  };
  const digestOf = (id: string): string | undefined => {
    const o = byId.get(id); const meta = META[id];
    return o && meta ? asSha256(o[meta.digestField]) : undefined;
  };

  const valid = new Map<string, boolean>();
  for (const id of byId.keys()) valid.set(id, recomputesGreen(id) && !(id in CHILDREN));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of Object.keys(CHILDREN)) {
      if (!byId.has(id)) continue;
      const bd = asObject(byId.get(id)!.boundDigests);
      const childrenOk = CHILDREN[id]!.every((ch) => {
        const claimed = asSha256(bd[ch.key]);
        const childDigest = digestOf(ch.childId);
        return claimed !== undefined && childDigest !== undefined && claimed === childDigest && valid.get(ch.childId) === true;
      });
      const next = recomputesGreen(id) && childrenOk;
      if (valid.get(id) !== next) { valid.set(id, next); changed = true; }
    }
  }
  return new Set([...valid.entries()].filter(([, v]) => v).map(([k]) => k));
}

export function buildClosureInputBundleAudit(input: ClosureInputBundleAuditInput): ClosureInputBundleAuditReport {
  const reports = Array.isArray(input.reports) ? input.reports : [];
  const ids: string[] = [];
  for (const r of reports) { const o = asObject(r); if (typeof o.report === 'string') ids.push(o.report); }
  const meshValid = meshValidReports(reports);

  const results: BundleReportResult[] = [...new Set(ids)].sort().map((report) => ({ report: report.replace(/^phase-230-promotion-/, ''), meshValid: meshValid.has(report) }));
  const blockers: string[] = [];
  for (const root of BUNDLE_ROOTS) if (!meshValid.has(root)) blockers.push('BUNDLE_ROOT_UNRESOLVED');
  if (results.length === 0) blockers.push('NO_REPORTS');

  const uniqueBlockers = [...new Set(blockers)];
  const overall: ClosureInputBundleAuditReport['overall'] = uniqueBlockers.length === 0 ? 'CLOSURE_BUNDLE_VERIFIED' : 'CLOSURE_BUNDLE_BROKEN';
  const withoutDigest: Omit<ClosureInputBundleAuditReport, 'auditDigest'> = {
    report: 'phase-230-promotion-closure-input-bundle-audit',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    reportCount: results.length,
    meshValidCount: results.filter((r) => r.meshValid).length,
    results,
    blockers: uniqueBlockers,
  };
  return { ...withoutDigest, auditDigest: digest('phase-230-closure-input-bundle-audit', JSON.stringify(withoutDigest)) };
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
