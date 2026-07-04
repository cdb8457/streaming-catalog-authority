import {
  parseTorBoxLiveSmokeSummaryEvidenceJson,
  type TorBoxLiveSmokeSummaryPack,
} from './torbox-live-smoke-summary-pack.js';

export type TorBoxLiveSmokeReviewGateInputErrorCode =
  | 'REVIEW_GATE_FILE_READ_FAILED'
  | 'REVIEW_GATE_FILE_TOO_LARGE'
  | 'REVIEW_GATE_JSON_MALFORMED'
  | 'REVIEW_GATE_OBJECT_REQUIRED'
  | 'REVIEW_GATE_INPUT_REQUIRED';

export interface TorBoxLiveSmokeReviewGateFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field?: string;
  readonly message: string;
}

export interface TorBoxLiveSmokeReviewGateReport {
  readonly report: 'phase-51-torbox-live-smoke-review-gate';
  readonly version: 1;
  readonly purpose: 'prepare-redaction-safe-live-smoke-review';
  readonly source: 'single-phase-49-summary-pack-json-file';
  readonly redactionSafe: true;
  readonly summaryValuesEchoed: false;
  readonly credentialValuesIncluded: false;
  readonly credentialPathsIncluded: false;
  readonly rawRefsIncluded: false;
  readonly providerPayloadsIncluded: false;
  readonly liveTorBoxContact: false;
  readonly commandExecution: false;
  readonly closesLiveSmokeReview: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly reviewReadiness: 'ready-for-review' | 'not-ready-for-review';
  readonly requiredProbes: readonly ['service-status', 'hoster-metadata'];
  readonly optionalProbes: readonly ['cache-availability'];
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly TorBoxLiveSmokeReviewGateFinding[];
}

export function buildTorBoxLiveSmokeReviewGateReport(
  summaryPack: Record<string, unknown>,
): TorBoxLiveSmokeReviewGateReport {
  const findings: TorBoxLiveSmokeReviewGateFinding[] = [];
  findings.push(...requiredLiteral(summaryPack, 'report', 'phase-49-torbox-live-smoke-summary-pack', 'SUMMARY_REPORT_VALID'));
  findings.push(...requiredLiteral(summaryPack, 'redactionSafe', true, 'SUMMARY_REDACTION_SAFE'));
  findings.push(...requiredLiteral(summaryPack, 'evidenceValuesEchoed', false, 'SUMMARY_EVIDENCE_SILENT'));
  findings.push(...requiredLiteral(summaryPack, 'credentialValuesIncluded', false, 'SUMMARY_NO_CREDENTIAL_VALUES'));
  findings.push(...requiredLiteral(summaryPack, 'credentialPathsIncluded', false, 'SUMMARY_NO_CREDENTIAL_PATHS'));
  findings.push(...requiredLiteral(summaryPack, 'rawRefsIncluded', false, 'SUMMARY_NO_RAW_REFS'));
  findings.push(...requiredLiteral(summaryPack, 'providerPayloadsIncluded', false, 'SUMMARY_NO_PROVIDER_PAYLOADS'));
  findings.push(...requiredLiteral(summaryPack, 'liveTorBoxContact', false, 'SUMMARY_NON_LIVE'));
  findings.push(...requiredLiteral(summaryPack, 'commandExecution', false, 'SUMMARY_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(summaryPack, 'closesLiveSmokeReview', false, 'SUMMARY_DOES_NOT_CLOSE_REVIEW'));
  findings.push(...requiredLiteral(summaryPack, 'o4Status', 'open/deferred', 'O4_STILL_OPEN'));
  findings.push(...requiredLiteral(summaryPack, 'o5Status', 'open/deferred', 'O5_STILL_OPEN'));
  findings.push(...requiredLiteral(summaryPack, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));
  findings.push(...requiredLiteral(summaryPack, 'reviewReadiness', 'ready-for-review', 'SUMMARY_READY_FOR_REVIEW'));

  const probes = Array.isArray(summaryPack.probes) ? summaryPack.probes : null;
  findings.push(probes ? pass('SUMMARY_PROBES_ARRAY_PRESENT', 'probes', 'summary has a probes array.') : fail('SUMMARY_PROBES_ARRAY_REQUIRED', 'probes', 'summary must have a probes array.'));
  findings.push(...probeReadinessFindings(probes));

  findings.push(warn('REVIEWER_STILL_REQUIRED', 'review', 'This gate prepares review and does not close live-smoke review.'));
  findings.push(warn('O4_REMAINS_DEFERRED', 'review', 'O4 production file custodian acceptance remains open/deferred.'));
  findings.push(warn('O5_REMAINS_DEFERRED', 'review', 'O5 managed KEK custody/scheduling remains open/deferred.'));
  findings.push(warn('FILE_CUSTODIAN_NOT_PRODUCTION_KMS', 'review', 'FileCustodian remains a hardened reference harness, not production KMS.'));

  return fromFindings(findings);
}

export function buildTorBoxLiveSmokeReviewGateInputErrorReport(
  code: TorBoxLiveSmokeReviewGateInputErrorCode,
): TorBoxLiveSmokeReviewGateReport {
  const messages: Record<TorBoxLiveSmokeReviewGateInputErrorCode, string> = {
    REVIEW_GATE_FILE_READ_FAILED: 'A supplied Phase 49 summary JSON file could not be read.',
    REVIEW_GATE_FILE_TOO_LARGE: 'A supplied Phase 49 summary JSON file exceeds the review gate input size limit.',
    REVIEW_GATE_JSON_MALFORMED: 'A supplied Phase 49 summary input is not valid JSON.',
    REVIEW_GATE_OBJECT_REQUIRED: 'A supplied Phase 49 summary JSON value must be an object, not an array or primitive.',
    REVIEW_GATE_INPUT_REQUIRED: 'One Phase 49 summary input is required.',
  };
  return fromFindings([fail(code, 'summary', messages[code])]);
}

export function parseTorBoxLiveSmokeReviewGateSummaryJson(
  jsonText: string,
): Record<string, unknown> | TorBoxLiveSmokeReviewGateInputErrorCode {
  const parsed = parseTorBoxLiveSmokeSummaryEvidenceJson(jsonText);
  if (parsed === 'SUMMARY_FILE_READ_FAILED') return 'REVIEW_GATE_FILE_READ_FAILED';
  if (parsed === 'SUMMARY_FILE_TOO_LARGE') return 'REVIEW_GATE_FILE_TOO_LARGE';
  if (parsed === 'SUMMARY_JSON_MALFORMED') return 'REVIEW_GATE_JSON_MALFORMED';
  if (parsed === 'SUMMARY_OBJECT_REQUIRED') return 'REVIEW_GATE_OBJECT_REQUIRED';
  if (parsed === 'SUMMARY_TOO_MANY_INPUTS') return 'REVIEW_GATE_OBJECT_REQUIRED';
  if (parsed === 'SUMMARY_INPUT_REQUIRED') return 'REVIEW_GATE_INPUT_REQUIRED';
  return parsed;
}

export function formatTorBoxLiveSmokeReviewGateJson(report: TorBoxLiveSmokeReviewGateReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatTorBoxLiveSmokeReviewGateText(report: TorBoxLiveSmokeReviewGateReport): string {
  const lines = [
    'Phase 51 TorBox live smoke review gate',
    '',
    `Review readiness: ${report.reviewReadiness}`,
    `Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`,
    `Summary values echoed: ${report.summaryValuesEchoed ? 'yes' : 'no'}`,
    `Live TorBox contact: ${report.liveTorBoxContact ? 'true' : 'false'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Closes live smoke review: ${report.closesLiveSmokeReview ? 'true' : 'false'}`,
    `Required probes: ${report.requiredProbes.join(',')}`,
    `Optional probes: ${report.optionalProbes.join(',')}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `FileCustodian: ${report.fileCustodianStatus}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => {
      const field = finding.field ? ` field=${finding.field}` : '';
      return `- ${finding.level.toUpperCase()} ${finding.code}${field}: ${finding.message}`;
    }),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function torBoxLiveSmokeReviewGateHasFailures(report: TorBoxLiveSmokeReviewGateReport): boolean {
  return report.summary.fail > 0;
}

function probeReadinessFindings(probes: unknown[] | null): TorBoxLiveSmokeReviewGateFinding[] {
  const findings: TorBoxLiveSmokeReviewGateFinding[] = [];
  findings.push(probePresentReady(probes, 'service-status'));
  findings.push(probePresentReady(probes, 'hoster-metadata'));
  if (probePresent(probes, 'cache-availability')) {
    findings.push(probePresentReady(probes, 'cache-availability'));
  } else {
    findings.push(warn('OPTIONAL_CACHE_AVAILABILITY_ABSENT', 'probes', 'optional cache-availability probe is absent.'));
  }
  return findings;
}

function probePresentReady(probes: unknown[] | null, probeName: 'service-status' | 'hoster-metadata' | 'cache-availability'): TorBoxLiveSmokeReviewGateFinding {
  if (!probes) return fail(`${codeName(probeName)}_PROBE_REQUIRED`, 'probes', `${probeName} probe is required.`);
  const matches = probes.filter((probe) => isProbeRecord(probe) && probe.probe === probeName);
  if (matches.length !== 1) return fail(`${codeName(probeName)}_PROBE_REQUIRED`, 'probes', `${probeName} probe must be present exactly once.`);
  const probe = matches[0] as TorBoxLiveSmokeSummaryPack['probes'][number];
  if (probe.reviewReadiness !== 'ready-for-review') return fail(`${codeName(probeName)}_PROBE_NOT_READY`, 'probes', `${probeName} probe is not ready for review.`);
  if (probe.preflightSummary.fail !== 0) return fail(`${codeName(probeName)}_PREFLIGHT_FAILED`, 'probes', `${probeName} preflight contains failures.`);
  return pass(`${codeName(probeName)}_PROBE_READY`, 'probes', `${probeName} probe is ready for review.`);
}

function probePresent(probes: unknown[] | null, probeName: 'cache-availability'): boolean {
  return probes?.some((probe) => isProbeRecord(probe) && probe.probe === probeName) ?? false;
}

function isProbeRecord(value: unknown): value is TorBoxLiveSmokeSummaryPack['probes'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const probe = value as Partial<TorBoxLiveSmokeSummaryPack['probes'][number]>;
  return (probe.probe === 'service-status' || probe.probe === 'hoster-metadata' || probe.probe === 'cache-availability')
    && (probe.reviewReadiness === 'ready-for-review' || probe.reviewReadiness === 'not-ready-for-review')
    && typeof probe.preflightSummary === 'object'
    && probe.preflightSummary !== null
    && !Array.isArray(probe.preflightSummary)
    && typeof probe.preflightSummary.fail === 'number';
}

function codeName(probeName: string): string {
  return probeName.toUpperCase().replace(/-/g, '_');
}

function fromFindings(findings: readonly TorBoxLiveSmokeReviewGateFinding[]): TorBoxLiveSmokeReviewGateReport {
  const summary = summarize(findings);
  return {
    report: 'phase-51-torbox-live-smoke-review-gate',
    version: 1,
    purpose: 'prepare-redaction-safe-live-smoke-review',
    source: 'single-phase-49-summary-pack-json-file',
    redactionSafe: true,
    summaryValuesEchoed: false,
    credentialValuesIncluded: false,
    credentialPathsIncluded: false,
    rawRefsIncluded: false,
    providerPayloadsIncluded: false,
    liveTorBoxContact: false,
    commandExecution: false,
    closesLiveSmokeReview: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    reviewReadiness: summary.fail === 0 ? 'ready-for-review' : 'not-ready-for-review',
    requiredProbes: ['service-status', 'hoster-metadata'],
    optionalProbes: ['cache-availability'],
    summary,
    findings,
  };
}

function summarize(findings: readonly TorBoxLiveSmokeReviewGateFinding[]): TorBoxLiveSmokeReviewGateReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): TorBoxLiveSmokeReviewGateFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function pass(code: string, field: string, message: string): TorBoxLiveSmokeReviewGateFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): TorBoxLiveSmokeReviewGateFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): TorBoxLiveSmokeReviewGateFinding {
  return { level: 'warn', code, field, message };
}
