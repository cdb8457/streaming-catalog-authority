import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Local, non-live coordinator review checklist v2. It aggregates the closure summary v3, the closure-input
// bundle audit, the live-boundary guard suite status, the full local test command labels, and the human-only
// remaining steps into ONE redaction-safe checklist for a human coordinator. It reads parsed JSON + the repo's
// package.json only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin,
// and `authorization` is the constant NONE with `status` PENDING. CHECKLIST_READY means the machine-side
// evidence is assembled for human review -- it is NOT an approval and does not authorize Phase 231.

export interface ReviewChecklistV2Input {
  readonly closureSummary?: unknown;  // phase-230-promotion-closure-summary-v3 (CLOSURE_SUMMARY_READY)
  readonly bundleAudit?: unknown;     // phase-230-promotion-closure-input-bundle-audit (CLOSURE_BUNDLE_VERIFIED)
}

export const REVIEW_CHECKLIST_V2_HUMAN_STEPS: readonly string[] = [
  'Human review of the reviewed commit range and diff.',
  'Human confirmation of the observed local state.',
  'Human run of the full `npm test` aggregate (legacy/live/CRLF/DB suites) if desired.',
  'Explicit coordinator ACCEPT recorded via the acceptance seal.',
  'The merge / tag / push-to-master action itself -- a human operator step NOT performed here.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const REVIEW_CHECKLIST_V2_DISCLAIMERS: readonly string[] = [
  'CHECKLIST_READY means the machine-side evidence is assembled for human review; it is NOT an approval.',
  'status is PENDING and authorization is NONE.',
  'It does NOT authorize Phase 231, live promotion, or any merge/tag/master action.',
  'No live Jellyfin call or real Movies write is implied or performed by this checklist.',
];

export interface ChecklistItem { readonly item: string; readonly ok: boolean }

export interface ReviewChecklistV2Report {
  readonly report: 'phase-230-promotion-coordinator-review-checklist-v2';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly status: 'PENDING';
  readonly overall: 'CHECKLIST_READY' | 'CHECKLIST_BLOCKED';
  readonly closureSummaryReady: boolean;
  readonly bundleAuditVerified: boolean;
  readonly liveBoundaryInLocalSuite: boolean;
  readonly localTestCommands: readonly string[];
  readonly machineChecks: readonly ChecklistItem[];
  readonly humanSteps: readonly string[];
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly checklistV2Digest: string;
}

export function buildReviewChecklistV2(projectRoot: string, input: ReviewChecklistV2Input): ReviewChecklistV2Report {
  const blockers: string[] = [];

  const closureSummaryReady = boundGreen(input.closureSummary, 'phase-230-promotion-closure-summary-v3', 'summaryV3Digest',
    (o) => o.overall === 'CLOSURE_SUMMARY_READY', 'CLOSURE_SUMMARY_MISSING', 'CLOSURE_SUMMARY_INVALID', 'CLOSURE_SUMMARY_NOT_READY', blockers);
  const bundleAuditVerified = boundGreen(input.bundleAudit, 'phase-230-promotion-closure-input-bundle-audit', 'auditDigest',
    (o) => o.overall === 'CLOSURE_BUNDLE_VERIFIED', 'BUNDLE_AUDIT_MISSING', 'BUNDLE_AUDIT_INVALID', 'BUNDLE_AUDIT_NOT_VERIFIED', blockers);

  // Local test command labels + live-boundary suite presence, from the repo's `test:phase230-local` gate.
  let gate = '';
  try { const pkg = JSON.parse(readFileSync(`${projectRoot}/package.json`, 'utf8')) as { scripts?: Record<string, string> }; gate = pkg.scripts?.['test:phase230-local'] ?? ''; } catch { gate = ''; }
  const localTestCommands = [...gate.matchAll(/tsx test\/([a-z0-9-]+)\.ts/g)].map((m) => m[1]!);
  if (localTestCommands.length === 0) blockers.push('NO_TEST_COMMANDS');
  const liveBoundaryInLocalSuite = localTestCommands.includes('promotion-live-boundary-guard');
  if (!liveBoundaryInLocalSuite) blockers.push('LIVE_BOUNDARY_SUITE_MISSING');

  const machineChecks: ChecklistItem[] = [
    { item: 'closure-summary-v3-ready', ok: closureSummaryReady },
    { item: 'closure-input-bundle-audit-verified', ok: bundleAuditVerified },
    { item: 'live-boundary-guard-in-local-suite', ok: liveBoundaryInLocalSuite },
    { item: 'local-test-commands-listed', ok: localTestCommands.length > 0 },
  ];

  const uniqueBlockers = [...new Set(blockers)];
  const overall: ReviewChecklistV2Report['overall'] = uniqueBlockers.length === 0 ? 'CHECKLIST_READY' : 'CHECKLIST_BLOCKED';
  const withoutDigest: Omit<ReviewChecklistV2Report, 'checklistV2Digest'> = {
    report: 'phase-230-promotion-coordinator-review-checklist-v2',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    status: 'PENDING',
    overall,
    closureSummaryReady,
    bundleAuditVerified,
    liveBoundaryInLocalSuite,
    localTestCommands,
    machineChecks,
    humanSteps: REVIEW_CHECKLIST_V2_HUMAN_STEPS,
    blockers: uniqueBlockers,
    disclaimers: REVIEW_CHECKLIST_V2_DISCLAIMERS,
  };
  return { ...withoutDigest, checklistV2Digest: digest('phase-230-review-checklist-v2', JSON.stringify(withoutDigest)) };
}

function boundGreen(value: unknown, reportId: string, digestField: string, green: (o: Record<string, unknown>) => boolean,
  missing: string, invalid: string, notOk: string, blockers: string[]): boolean {
  if (value === undefined) { blockers.push(missing); return false; }
  const o = asObject(value);
  if (o.report !== reportId) { blockers.push(invalid); return false; }
  const verified = asSha256(o[digestField]) !== undefined && verifySelfDigests([o]).results[0]?.verified === true;
  if (!verified) { blockers.push('COMPONENT_DIGEST_UNVERIFIED'); return false; }
  if (!green(o)) { blockers.push(notOk); return false; }
  return true;
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
