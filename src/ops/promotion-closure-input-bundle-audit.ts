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

interface ReportMeta { readonly digestField: string; readonly green: (o: Record<string, unknown>) => boolean; readonly shape: (o: Record<string, unknown>) => boolean; }

const RA_KEYS = ['terminal-readiness-v2', 'terminal-closure', 'commit-range-closure', 'transcript-verification', 'review-matrix'];
const CR_KEYS = ['acceptance-preflight', 'failure-matrix', 'report-schema', 'boundary-audit', 'cli-ergonomics'];
const BT_KEYS = ['terminal-closure', 'pack-component-integrity', 'aggregator-digest-audit', 'artifact-export-manifest', 'negative-evidence-corpus', 'watchdog-hygiene'];
const TC_KEYS = ['transcript-verification', 'evidence-minimizer', 'commit-range-closure', 'regression-oracle', 'coordinator-readiness'];

// report id -> self-digest field, expected green overall, AND an authoritative-CONTENT shape check. A minimal
// self-sealed leaf { report, version, redactionSafe, authorization, overall, <digest> } carries no real
// content and fails `shape`, so a fully-fabricated deep green bundle cannot resolve the mesh. `green` alone is
// not enough.
const META: Readonly<Record<string, ReportMeta>> = {
  'phase-230-promotion-review-authorization': { digestField: 'authorizationDigest', green: (o) => o.overall === 'LOCAL_REVIEW_AUTHORIZED', shape: (o) => { const p = arr(o.placeholders); return o.evidenceValid === true && o.matrixValid === true && o.contextBound === true && posNum(o.reviewedCommitCount) && posNum(o.reviewedTestCount) && p !== null && p.length > 0 && p.every((r) => sha40(asObject(r).sha) && nonEmpty(asObject(r).tests)) && boundHas(o, RA_KEYS); } },
  'phase-230-promotion-coordinator-readiness-manifest': { digestField: 'readinessDigest', green: (o) => o.overall === 'COORDINATOR_READINESS_CONFIRMED', shape: (o) => componentsOk(o, CR_KEYS) && boundHas(o, CR_KEYS) },
  'phase-230-promotion-terminal-readiness-v2': { digestField: 'readinessV2Digest', green: (o) => o.overall === 'TERMINAL_READINESS_V2_CONFIRMED', shape: (o) => componentsOk(o, BT_KEYS) && boundHas(o, BT_KEYS) },
  'phase-230-promotion-terminal-closure-manifest': { digestField: 'terminalDigest', green: (o) => o.overall === 'TERMINAL_CLOSURE_CONFIRMED', shape: (o) => componentsOk(o, TC_KEYS) && boundHas(o, TC_KEYS) },
  'phase-230-promotion-commit-range-closure': { digestField: 'closureDigest', green: (o) => o.overall === 'RANGE_CLOSED', shape: (o) => { const r = arr(o.results); return sha40(o.base) && sha40(o.head) && r !== null && r.length > 0 && r.every((x) => sha40(asObject(x).sha) && typeof asObject(x).category === 'string') && asObject(r[r.length - 1]).sha === o.head; } },
  'phase-230-promotion-transcript-verification': { digestField: 'verificationDigest', green: (o) => o.overall === 'TRANSCRIPT_VERIFIED', shape: (o) => { const c = arr(o.commandResults); return sha40(o.head) && c !== null && c.length > 0 && c.every((x) => typeof asObject(x).command === 'string' && typeof asObject(x).passed === 'number' && typeof asObject(x).failed === 'number') && arr(o.checks) !== null; } },
  'phase-230-promotion-review-matrix': { digestField: 'reviewMatrixDigest', green: (o) => o.overall === 'REVIEW_MATRIX_READY', shape: (o) => { const r = arr(o.rows); return sha40(o.base) && sha40(o.head) && r !== null && r.length > 0 && r.every((x) => sha40(asObject(x).sha) && arr(asObject(x).tests) !== null) && asObject(r[r.length - 1]).sha === o.head; } },
  'phase-230-promotion-pack-component-integrity': { digestField: 'integrityDigest', green: (o) => o.overall === 'PACK_INTEGRITY_VERIFIED', shape: (o) => o.packVerified === true && nonEmpty(o.components) && posNum(o.verifiedCount) },
  'phase-230-promotion-aggregator-digest-audit': { digestField: 'auditDigest', green: (o) => o.overall === 'AGGREGATOR_AUDIT_CLEAN', shape: (o) => posNum(o.binderCount) && o.conformantCount === o.binderCount && nonEmpty(o.aggregators) },
  'phase-230-promotion-artifact-export-manifest': { digestField: 'exportDigest', green: (o) => o.overall === 'ARTIFACT_EXPORT_MANIFEST_COMPLETE', shape: (o) => posNum(o.artifactCount) && o.exportableCount === o.artifactCount && nonEmpty(o.artifacts) },
  'phase-230-promotion-negative-evidence-corpus': { digestField: 'corpusDigest', green: (o) => o.overall === 'CORPUS_HELD', shape: (o) => posNum(o.count) && nonEmpty(o.samples) },
  'phase-230-promotion-watchdog-hygiene': { digestField: 'watchdogDigest', green: (o) => o.overall === 'WATCHDOG_HYGIENE_CLEAN', shape: (o) => o.configSafe === true && posNum(o.queueCount) && nonEmpty(o.entries) },
  'phase-230-promotion-evidence-minimizer': { digestField: 'minimizerDigest', green: (o) => o.overall === 'MINIMIZED_CLEAN', shape: (o) => posNum(o.count) && nonEmpty(o.entries) && nonEmpty(o.packedKinds) },
  'phase-230-promotion-regression-oracle': { digestField: 'oracleDigest', green: (o) => o.overall === 'ORACLE_COMPLETE', shape: (o) => nonEmpty(o.entries) },
  'phase-230-promotion-acceptance-preflight': { digestField: 'preflightDigest', green: (o) => o.overall === 'PREFLIGHT_READY', shape: (o) => sha40(o.base) && sha40(o.head) && nonEmpty(o.requiredTests) && nonEmpty(o.machineGates) },
  'phase-230-promotion-failure-mode-matrix': { digestField: 'failureMatrixDigest', green: (o) => o.overall === 'FAILURE_MATRIX_COMPLETE', shape: (o) => posNum(o.codeCount) && nonEmpty(o.entries) },
  'phase-230-promotion-report-schema': { digestField: 'reportSchemaDigest', green: (o) => o.overall === 'REPORT_SCHEMA_OK', shape: (o) => posNum(o.count) && nonEmpty(o.results) },
  'phase-230-promotion-boundary-audit': { digestField: 'auditDigest', green: (o) => o.overall === 'BOUNDARY_AUDIT_CLEAN', shape: (o) => posNum(o.ruleCount) && nonEmpty(o.rules) && posNum(o.scannedSources) },
  'phase-230-promotion-cli-ergonomics': { digestField: 'ergonomicsDigest', green: (o) => o.overall === 'CLI_ERGONOMICS_OK', shape: (o) => posNum(o.cliCount) && nonEmpty(o.results) },
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
// Cross-report CONTENT consistency an aggregator must satisfy beyond digest-binding its children -- so a
// forged parent with genuine children (but fabricated/mismatched own content) is rejected. review-authorization
// surfaces the reviewed commit/test visibility, so its ordered placeholder shas must equal the authoritative
// commit-range-closure AND review-matrix ordered shas, and its placeholder test set must equal the transcript
// verification's commands.
const CROSS: Readonly<Record<string, (self: Record<string, unknown>, canon: (id: string) => Record<string, unknown> | undefined) => boolean>> = {
  'phase-230-promotion-review-authorization': (self, canon) => {
    const crc = canon('phase-230-promotion-commit-range-closure');
    const rm = canon('phase-230-promotion-review-matrix');
    const tv = canon('phase-230-promotion-transcript-verification');
    if (!crc || !rm || !tv) return false;
    const raShas = shaSeq(self.placeholders);
    const crcShas = shaSeq(crc.results);
    const rmShas = shaSeq(rm.rows);
    const raTests = placeholderTests(self.placeholders);
    const tvTests = commandSet(tv.commandResults);
    if (raShas.length === 0 || !sameOrdered(raShas, crcShas) || !sameOrdered(raShas, rmShas) || !sameSet(raTests, tvTests)) return false;
    const terminal = crcShas[crcShas.length - 1];
    // The transcript must have reviewed the SAME terminal commit, and the commit-range and review-matrix must
    // agree on the base -- so a transcript resealed onto a different head, or a base mismatch with matching
    // rows, is rejected.
    return sha40s(tv.head) !== undefined && sha40s(tv.head) === terminal
      && sha40s(crc.base) !== undefined && sha40s(crc.base) === sha40s(rm.base);
  },
};

// The roots that must be mesh-valid for the bundle to be VERIFIED.
export const BUNDLE_ROOTS: readonly string[] = ['phase-230-promotion-review-authorization', 'phase-230-promotion-coordinator-readiness-manifest', 'phase-230-promotion-terminal-readiness-v2'];

export interface BundleReportResult { readonly report: string; readonly meshValid: boolean; readonly duplicate: boolean; }

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

export interface MeshResult {
  // The recomputed self-DIGESTS (not report ids) of the reports that are mesh-valid. Consumers bind validity
  // to the EXACT supplied object's digest -- never to report-id membership -- so a genuine same-id anchor
  // cannot vouch for a different forged top-level object with the same id.
  readonly validDigests: ReadonlySet<string>;
  readonly validIds: ReadonlySet<string>;
  // report ids supplied more than once with CONFLICTING content (a second copy that is missing/not-green or
  // carries a different self-digest). Such ids are ambiguous and are never mesh-valid -- fail closed.
  readonly duplicateIds: readonly string[];
}

// Pure predicate used by both this op and its consumers.
export function meshValidReports(reports: readonly unknown[]): MeshResult {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of reports) {
    const o = asObject(r);
    const id = typeof o.report === 'string' ? o.report : '';
    if (!META[id]) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(o);
  }

  // Canonical report per id: usable only when EVERY supplied copy recomputes + is green AND they all carry
  // the same self-digest (identical copies are fine; a conflicting copy makes the id a duplicate).
  const canonicalObj = new Map<string, Record<string, unknown>>();
  const canonicalDigest = new Map<string, string>();
  const duplicateIds: string[] = [];
  for (const [id, objs] of groups) {
    const meta = META[id]!;
    const okCopies = objs.filter((o) => verifySelfDigests([o]).results[0]?.verified === true && meta.green(o) && meta.shape(o));
    const digests = new Set(okCopies.map((o) => asSha256(o[meta.digestField])).filter((d): d is string => d !== undefined));
    if (okCopies.length === objs.length && digests.size === 1) {
      canonicalObj.set(id, okCopies[0]!);
      canonicalDigest.set(id, [...digests][0]!);
    } else if (objs.length > 1) {
      duplicateIds.push(id); // ambiguous / conflicting duplicate -> fail closed
    }
  }

  const valid = new Map<string, boolean>();
  for (const id of canonicalObj.keys()) valid.set(id, !(id in CHILDREN));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of Object.keys(CHILDREN)) {
      if (!canonicalObj.has(id)) continue;
      const bd = asObject(canonicalObj.get(id)!.boundDigests);
      const childrenOk = CHILDREN[id]!.every((ch) => {
        const claimed = asSha256(bd[ch.key]);
        const childDigest = canonicalDigest.get(ch.childId);
        return claimed !== undefined && childDigest !== undefined && claimed === childDigest && valid.get(ch.childId) === true;
      });
      const cross = CROSS[id];
      const crossOk = cross === undefined || cross(canonicalObj.get(id)!, (cid) => canonicalObj.get(cid));
      const next = childrenOk && crossOk;
      if (valid.get(id) !== next) { valid.set(id, next); changed = true; }
    }
  }
  const validIds = new Set([...valid.entries()].filter(([, v]) => v).map(([k]) => k));
  const validDigests = new Set([...validIds].map((id) => canonicalDigest.get(id)).filter((d): d is string => d !== undefined));
  return { validDigests, validIds, duplicateIds };
}

export function buildClosureInputBundleAudit(input: ClosureInputBundleAuditInput): ClosureInputBundleAuditReport {
  const reports = Array.isArray(input.reports) ? input.reports : [];
  const ids: string[] = [];
  for (const r of reports) { const o = asObject(r); if (typeof o.report === 'string') ids.push(o.report); }
  const mesh = meshValidReports(reports);
  const duplicates = new Set(mesh.duplicateIds);

  const results: BundleReportResult[] = [...new Set(ids)].sort().map((report) => ({ report: report.replace(/^phase-230-promotion-/, ''), meshValid: mesh.validIds.has(report), duplicate: duplicates.has(report) }));
  const blockers: string[] = [];
  for (const root of BUNDLE_ROOTS) if (!mesh.validIds.has(root)) blockers.push('BUNDLE_ROOT_UNRESOLVED');
  if (mesh.duplicateIds.length > 0) blockers.push('DUPLICATE_REPORT_ID');
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
function sha40(value: unknown): boolean { return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value); }
function posNum(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function arr(value: unknown): unknown[] | null { return Array.isArray(value) ? value : null; }
function nonEmpty(value: unknown): boolean { return Array.isArray(value) && value.length > 0; }
function boundHas(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const bd = asObject(o.boundDigests);
  return keys.every((k) => asSha256(bd[k]) !== undefined);
}
function sha40s(value: unknown): string | undefined { return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined; }
// Ordered sha40 sequence from an array of { sha } records; returns [] with a marker if any element is not sha40.
function shaSeq(value: unknown): string[] {
  const a = arr(value);
  if (a === null) return [];
  const out: string[] = [];
  for (const x of a) { const s = sha40s(asObject(x).sha); if (s === undefined) return ['<invalid>']; out.push(s); }
  return out;
}
function placeholderTests(value: unknown): string[] {
  const a = arr(value);
  if (a === null) return [];
  const set = new Set<string>();
  for (const row of a) for (const t of (arr(asObject(row).tests) ?? [])) { const c = asObject(t).test; if (typeof c === 'string') set.add(c); }
  return [...set];
}
function commandSet(value: unknown): string[] {
  const a = arr(value);
  if (a === null) return [];
  const set = new Set<string>();
  for (const c of a) { const cmd = asObject(c).command; if (typeof cmd === 'string') set.add(cmd); }
  return [...set];
}
function sameOrdered(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]) && !a.includes('<invalid>');
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a); const sb = new Set(b);
  return sa.size > 0 && sa.size === sb.size && [...sa].every((x) => sb.has(x));
}
// Every expected component present + ok, for the aggregator manifests that carry a components[] list.
function componentsOk(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const comps = arr(o.components);
  if (comps === null) return false;
  const okByName = new Map<string, boolean>();
  for (const c of comps) { const co = asObject(c); if (typeof co.component === 'string') okByName.set(co.component, co.ok === true); }
  return keys.every((k) => okByName.get(k) === true);
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
