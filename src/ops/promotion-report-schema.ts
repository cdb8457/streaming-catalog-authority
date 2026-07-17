import { createHash } from 'node:crypto';

// Local, non-live report schema strictness pass for the AP-AZ report types. Every report is validated
// against a STRICT schema: the exact top-level key set (no missing keys, no unknown keys), the fixed
// literals (version 1, redactionSafe true, authorization NONE), the overall enum, and a well-formed sha256
// self-digest. This catches malformed-but-plausible reports that the green checks alone would accept. It
// reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
// Jellyfin, and authorizes nothing live.

interface ReportSchema {
  readonly keys: readonly string[];
  readonly overall: readonly string[];
  readonly digestField: string;
}

const BASE = ['report', 'version', 'redactionSafe', 'authorization'] as const;

// report id -> strict schema (exact key order-insensitive set).
const SCHEMAS: Readonly<Record<string, ReportSchema>> = {
  'phase-230-promotion-provenance-diff': { keys: [...BASE, 'overall', 'base', 'head', 'reviewedCommit', 'commitCount', 'checks', 'blockers', 'diffDigest'], overall: ['PROVENANCE_ALIGNED', 'PROVENANCE_MISALIGNED'], digestField: 'diffDigest' },
  'phase-230-promotion-gate-coverage': { keys: [...BASE, 'overall', 'opCount', 'gateNodeCount', 'blockerCodeCount', 'dimensions', 'gaps', 'coverageDigest'], overall: ['GATE_COVERAGE_COMPLETE', 'GATE_COVERAGE_INCOMPLETE'], digestField: 'coverageDigest' },
  'phase-230-promotion-artifact-chain-bundle': { keys: [...BASE, 'overall', 'components', 'bindings', 'blockers', 'chainDigest'], overall: ['CHAIN_BUNDLE_READY', 'CHAIN_BUNDLE_BLOCKED'], digestField: 'chainDigest' },
  'phase-230-promotion-redaction-corpus': { keys: [...BASE, 'overall', 'leakCount', 'safeCount', 'detectorCount', 'categories', 'leaks', 'safe', 'breaches', 'gaps', 'redactionDigest'], overall: ['REDACTION_CORPUS_HELD', 'REDACTION_CORPUS_BREACHED'], digestField: 'redactionDigest' },
  'phase-230-promotion-boundary-policy': { keys: [...BASE, 'overall', 'ruleCount', 'hookCount', 'scannedSources', 'scannedDocs', 'rules', 'violations', 'policyDigest'], overall: ['BOUNDARY_POLICY_ENFORCED', 'BOUNDARY_POLICY_VIOLATED'], digestField: 'policyDigest' },
  'phase-230-promotion-review-automation': { keys: [...BASE, 'overall', 'automatedChecks', 'boundDigests', 'manualSteps', 'blockers', 'disclaimers', 'automationDigest'], overall: ['REVIEW_AUTOMATION_PASSED', 'REVIEW_AUTOMATION_BLOCKED'], digestField: 'automationDigest' },
  'phase-230-promotion-merge-review-evidence-pack': { keys: [...BASE, 'overall', 'components', 'bindings', 'blockers', 'disclaimers', 'packDigest'], overall: ['REVIEWER_PACK_READY', 'REVIEWER_PACK_BLOCKED'], digestField: 'packDigest' },
  'phase-230-promotion-acceptance-preflight': { keys: [...BASE, 'approvalsGranted', 'overall', 'base', 'head', 'commitCount', 'requiredTests', 'machineGates', 'humanGatesRemaining', 'blockers', 'disclaimers', 'preflightDigest'], overall: ['PREFLIGHT_READY', 'PREFLIGHT_NOT_READY'], digestField: 'preflightDigest' },
  'phase-230-promotion-failure-mode-matrix': { keys: [...BASE, 'overall', 'codeCount', 'mappedCount', 'kinds', 'entries', 'gaps', 'failureMatrixDigest'], overall: ['FAILURE_MATRIX_COMPLETE', 'FAILURE_MATRIX_INCOMPLETE'], digestField: 'failureMatrixDigest' },
  'phase-230-promotion-cli-ergonomics': { keys: [...BASE, 'overall', 'cliCount', 'results', 'gaps', 'ergonomicsDigest'], overall: ['CLI_ERGONOMICS_OK', 'CLI_ERGONOMICS_GAP'], digestField: 'ergonomicsDigest' },
};

export const REPORT_SCHEMA_IDS: readonly string[] = Object.keys(SCHEMAS);

export interface ReportSchemaResult {
  readonly report: string;
  readonly valid: boolean;
  readonly problems: readonly string[];
}

export interface ReportSchemaReport {
  readonly report: 'phase-230-promotion-report-schema';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'REPORT_SCHEMA_OK' | 'REPORT_SCHEMA_VIOLATION' | 'NO_REPORTS';
  readonly count: number;
  readonly results: readonly ReportSchemaResult[];
  readonly violations: readonly string[];
  readonly reportSchemaDigest: string;
}

export function buildReportSchema(reports: readonly unknown[]): ReportSchemaReport {
  const results: ReportSchemaResult[] = reports.map((r) => {
    const obj = asObject(r);
    const id = typeof obj.report === 'string' ? obj.report : '<unknown>';
    const schema = SCHEMAS[id];
    if (!schema) return { report: id, valid: false, problems: ['REPORT_UNRECOGNIZED'] };
    const problems: string[] = [];
    const allowed = new Set(schema.keys);
    const present = new Set(Object.keys(obj));
    for (const k of schema.keys) if (!present.has(k)) { problems.push('REPORT_SHAPE_INVALID'); break; }
    for (const k of present) if (!allowed.has(k)) { problems.push('UNKNOWN_KEY'); break; }
    if (obj.version !== 1 || obj.redactionSafe !== true || obj.authorization !== 'NONE') problems.push('REPORT_SHAPE_INVALID');
    if (typeof obj.overall !== 'string' || !schema.overall.includes(obj.overall)) problems.push('REPORT_STATUS_INVALID');
    if (!isSha256(obj[schema.digestField])) problems.push('REPORT_DIGEST_INVALID');
    const unique = [...new Set(problems)];
    return { report: id, valid: unique.length === 0, problems: unique };
  });

  const violations = [...new Set(results.flatMap((r) => r.problems))];
  const overall: ReportSchemaReport['overall'] =
    reports.length === 0 ? 'NO_REPORTS' : violations.length > 0 ? 'REPORT_SCHEMA_VIOLATION' : 'REPORT_SCHEMA_OK';
  const withoutDigest: Omit<ReportSchemaReport, 'reportSchemaDigest'> = {
    report: 'phase-230-promotion-report-schema',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    count: reports.length,
    results,
    violations,
  };
  return { ...withoutDigest, reportSchemaDigest: digest('phase-230-report-schema', JSON.stringify(withoutDigest)) };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
