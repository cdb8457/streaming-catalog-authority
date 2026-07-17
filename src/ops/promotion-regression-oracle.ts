import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { BLOCKER_CODES } from './promotion-blocker-taxonomy.js';

// Local, non-live regression oracle index. It maps every coordinator-discovered regression finding to the
// blocker code that now guards it and the test that reproduces it, and confirms each mapping is live: the
// blocker is catalogued in the taxonomy, the repro test exists, and the finding carries a slug. It reads
// files + the shared registry only; it performs no promotion, never touches the real Movies root, never
// contacts Jellyfin, and authorizes nothing live. It fails closed on an uncatalogued blocker, a missing
// repro test, or a finding without a repro.

export interface OracleFinding { readonly finding: string; readonly blocker: string; readonly test: string; }

// The regressions surfaced by coordinator review across this line of work, each pinned to its guard + repro.
const FINDINGS: readonly OracleFinding[] = [
  { finding: 'fail-open-release-checklist-digest', blocker: 'REQUIRED_DIGEST_MISSING', test: 'test/promotion-release-checklist.ts' },
  { finding: 'an-ao-mixed-run-binding', blocker: 'COMMIT_BINDING_MISMATCH', test: 'test/promotion-release-checklist.ts' },
  { finding: 'final-summary-unsubstantiated-commit', blocker: 'REVIEWED_COMMIT_INVALID', test: 'test/promotion-final-summary.ts' },
  { finding: 'final-summary-empty-test-results', blocker: 'TEST_RESULTS_INVALID', test: 'test/promotion-final-summary.ts' },
  { finding: 'report-schema-wrong-but-valid-digest', blocker: 'REPORT_DIGEST_MISMATCH', test: 'test/promotion-report-schema.ts' },
  { finding: 'reviewer-pack-forged-self-digest', blocker: 'REVIEWER_PACK_DIGEST_MISMATCH', test: 'test/promotion-acceptance-preflight.ts' },
  { finding: 'reviewer-pack-incomplete-components', blocker: 'PACK_COMPONENT_INCOMPLETE', test: 'test/promotion-acceptance-preflight.ts' },
  { finding: 'reviewer-pack-failing-binding', blocker: 'PACK_BINDING_FAILED', test: 'test/promotion-acceptance-preflight.ts' },
  { finding: 'preflight-context-not-bound', blocker: 'CONTEXT_HEAD_MISMATCH', test: 'test/promotion-acceptance-preflight.ts' },
  { finding: 'preflight-commit-range-mismatch', blocker: 'CONTEXT_COMMITS_MISMATCH', test: 'test/promotion-acceptance-preflight.ts' },
  { finding: 'archive-fail-open-cross-check', blocker: 'EVIDENCE_LEDGER_MISMATCH', test: 'test/promotion-archive-manifest.ts' },
  { finding: 'review-bundle-stitched-archive', blocker: 'ARCHIVE_EVIDENCE_MISMATCH', test: 'test/promotion-review-bundle.ts' },
];

export const REGRESSION_FINDING_COUNT = FINDINGS.length;

export interface OracleEntry { readonly finding: string; readonly blocker: string; readonly test: string; readonly mapped: boolean; }

export interface RegressionOracleReport {
  readonly report: 'phase-230-promotion-regression-oracle';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'ORACLE_COMPLETE' | 'ORACLE_INCOMPLETE';
  readonly count: number;
  readonly entries: readonly OracleEntry[];
  readonly gaps: readonly string[];
  readonly oracleDigest: string;
}

export function buildRegressionOracle(projectRoot: string, extra: readonly OracleFinding[] = []): RegressionOracleReport {
  const catalogued = new Set(BLOCKER_CODES);
  const gaps: string[] = [];
  const entries: OracleEntry[] = [...FINDINGS, ...extra].map((f) => {
    let mapped = true;
    if (typeof f.finding !== 'string' || f.finding.length === 0) { gaps.push('FINDING_WITHOUT_REPRO'); mapped = false; }
    if (!catalogued.has(f.blocker)) { gaps.push('BLOCKER_UNCATALOGUED'); mapped = false; }
    if (!(typeof f.test === 'string' && f.test.startsWith('test/') && existsSync(`${projectRoot}/${f.test}`))) { gaps.push('REPRO_MISSING_TEST'); mapped = false; }
    return { finding: f.finding, blocker: f.blocker, test: f.test, mapped };
  });

  const uniqueGaps = [...new Set(gaps)];
  const overall: RegressionOracleReport['overall'] = uniqueGaps.length === 0 ? 'ORACLE_COMPLETE' : 'ORACLE_INCOMPLETE';
  const withoutDigest: Omit<RegressionOracleReport, 'oracleDigest'> = {
    report: 'phase-230-promotion-regression-oracle',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    count: entries.length,
    entries,
    gaps: uniqueGaps,
  };
  return { ...withoutDigest, oracleDigest: digest('phase-230-regression-oracle', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
