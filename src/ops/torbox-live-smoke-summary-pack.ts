import {
  buildTorBoxLiveSmokeEvidencePreflightReport,
  parseTorBoxLiveSmokeEvidenceJson,
  type TorBoxLiveSmokeEvidencePreflightReport,
  type TorBoxLiveSmokeEvidenceSummary,
} from './torbox-live-smoke-evidence-preflight.js';
import {
  fixedTorBoxLiveSmokeCategory,
  fixedTorBoxLiveSmokeOperation,
  fixedTorBoxLiveSmokeProbe,
} from './torbox-live-smoke-labels.js';

export type TorBoxLiveSmokeSummaryInputErrorCode =
  | 'SUMMARY_FILE_READ_FAILED'
  | 'SUMMARY_FILE_TOO_LARGE'
  | 'SUMMARY_JSON_MALFORMED'
  | 'SUMMARY_OBJECT_REQUIRED'
  | 'SUMMARY_TOO_MANY_INPUTS'
  | 'SUMMARY_INPUT_REQUIRED';

export interface TorBoxLiveSmokeSummaryFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field?: string;
  readonly message: string;
}

export interface TorBoxLiveSmokeSummaryProbe {
  readonly ordinal: number;
  readonly probe: string;
  readonly operation: string;
  readonly category: string;
  readonly ok: boolean;
  readonly reviewReadiness: TorBoxLiveSmokeEvidencePreflightReport['reviewReadiness'];
  readonly preflightSummary: TorBoxLiveSmokeEvidenceSummary;
}

export interface TorBoxLiveSmokeSummaryPack {
  readonly report: 'phase-49-torbox-live-smoke-summary-pack';
  readonly version: 1;
  readonly purpose: 'redaction-safe-live-smoke-summary-pack';
  readonly source: 'explicit-operator-supplied-json-files';
  readonly redactionSafe: true;
  readonly evidenceValuesEchoed: false;
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
  readonly probes: readonly TorBoxLiveSmokeSummaryProbe[];
  readonly aggregate: {
    readonly totalReports: number;
    readonly readyForReview: number;
    readonly notReadyForReview: number;
    readonly okReports: number;
    readonly failedReports: number;
    readonly passFindings: number;
    readonly warnFindings: number;
    readonly failFindings: number;
  };
  readonly findings: readonly TorBoxLiveSmokeSummaryFinding[];
}

export const TORBOX_LIVE_SMOKE_SUMMARY_MAX_INPUTS = 8;

export function buildTorBoxLiveSmokeSummaryPack(
  evidenceReports: readonly Record<string, unknown>[],
): TorBoxLiveSmokeSummaryPack {
  if (evidenceReports.length === 0) {
    return fromFindings([], [fail('SUMMARY_INPUT_REQUIRED', 'inputs', 'At least one Phase 43 evidence report is required.')]);
  }
  if (evidenceReports.length > TORBOX_LIVE_SMOKE_SUMMARY_MAX_INPUTS) {
    return fromFindings([], [fail('SUMMARY_TOO_MANY_INPUTS', 'inputs', 'Too many Phase 43 evidence reports were supplied.')]);
  }

  const probes: TorBoxLiveSmokeSummaryProbe[] = [];
  const findings: TorBoxLiveSmokeSummaryFinding[] = [];
  const seen = new Set<string>();

  evidenceReports.forEach((report, index) => {
    const preflight = buildTorBoxLiveSmokeEvidencePreflightReport(report);
    const probe = fixedTorBoxLiveSmokeProbe(report.probe);
    const operation = fixedTorBoxLiveSmokeOperation(report.operation);
    const category = fixedTorBoxLiveSmokeCategory(report.category);
    const key = `${probe}\0${operation}`;
    if (seen.has(key)) {
      findings.push(warn('DUPLICATE_PROBE_OPERATION', 'inputs', 'A duplicate probe/operation pair is present.'));
    }
    seen.add(key);

    probes.push({
      ordinal: index + 1,
      probe,
      operation,
      category,
      ok: report.ok === true,
      reviewReadiness: preflight.reviewReadiness,
      preflightSummary: preflight.summary,
    });

    if (preflight.summary.fail === 0) {
      findings.push(pass('PREFLIGHT_READY', 'inputs', 'A supplied evidence report is ready for review.'));
    } else {
      findings.push(fail('PREFLIGHT_NOT_READY', 'inputs', 'A supplied evidence report is not ready for review.'));
    }
  });

  findings.push(warn('OPERATOR_REVIEW_STILL_REQUIRED', 'summary', 'This summary does not close live-smoke review.'));
  findings.push(warn('O4_REMAINS_DEFERRED', 'summary', 'O4 production file custodian acceptance remains open/deferred.'));
  findings.push(warn('O5_REMAINS_DEFERRED', 'summary', 'O5 managed KEK custody/scheduling remains open/deferred.'));
  findings.push(warn('FILE_CUSTODIAN_NOT_PRODUCTION_KMS', 'summary', 'FileCustodian remains a hardened reference harness, not production KMS.'));

  return fromFindings(probes, findings);
}

export function buildTorBoxLiveSmokeSummaryInputErrorPack(
  code: TorBoxLiveSmokeSummaryInputErrorCode,
): TorBoxLiveSmokeSummaryPack {
  const messages: Record<TorBoxLiveSmokeSummaryInputErrorCode, string> = {
    SUMMARY_FILE_READ_FAILED: 'A supplied evidence JSON file could not be read.',
    SUMMARY_FILE_TOO_LARGE: 'A supplied evidence JSON file exceeds the summary input size limit.',
    SUMMARY_JSON_MALFORMED: 'A supplied evidence input is not valid JSON.',
    SUMMARY_OBJECT_REQUIRED: 'A supplied evidence JSON value must be an object, not an array or primitive.',
    SUMMARY_TOO_MANY_INPUTS: 'Too many evidence inputs were supplied.',
    SUMMARY_INPUT_REQUIRED: 'At least one evidence input is required.',
  };
  return fromFindings([], [fail(code, 'inputs', messages[code])]);
}

export function parseTorBoxLiveSmokeSummaryEvidenceJson(
  jsonText: string,
): Record<string, unknown> | TorBoxLiveSmokeSummaryInputErrorCode {
  const parsed = parseTorBoxLiveSmokeEvidenceJson(jsonText);
  if (parsed === 'EVIDENCE_FILE_READ_FAILED') return 'SUMMARY_FILE_READ_FAILED';
  if (parsed === 'EVIDENCE_FILE_TOO_LARGE') return 'SUMMARY_FILE_TOO_LARGE';
  if (parsed === 'EVIDENCE_JSON_MALFORMED') return 'SUMMARY_JSON_MALFORMED';
  if (parsed === 'EVIDENCE_OBJECT_REQUIRED') return 'SUMMARY_OBJECT_REQUIRED';
  return parsed;
}

export function formatTorBoxLiveSmokeSummaryPackJson(report: TorBoxLiveSmokeSummaryPack): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatTorBoxLiveSmokeSummaryPackText(report: TorBoxLiveSmokeSummaryPack): string {
  const lines = [
    'Phase 49 TorBox live smoke summary pack',
    '',
    `Review readiness: ${report.reviewReadiness}`,
    `Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`,
    `Evidence values echoed: ${report.evidenceValuesEchoed ? 'yes' : 'no'}`,
    `Live TorBox contact: ${report.liveTorBoxContact ? 'true' : 'false'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Closes live smoke review: ${report.closesLiveSmokeReview ? 'true' : 'false'}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `FileCustodian: ${report.fileCustodianStatus}`,
    `Aggregate: total=${report.aggregate.totalReports} ready=${report.aggregate.readyForReview} notReady=${report.aggregate.notReadyForReview} ok=${report.aggregate.okReports} failed=${report.aggregate.failedReports} pass=${report.aggregate.passFindings} warn=${report.aggregate.warnFindings} fail=${report.aggregate.failFindings}`,
    '',
    'Probes:',
    ...report.probes.map((probe) => `- #${probe.ordinal} probe=${probe.probe} operation=${probe.operation} category=${probe.category} ok=${probe.ok} readiness=${probe.reviewReadiness} preflightPass=${probe.preflightSummary.pass} preflightWarn=${probe.preflightSummary.warn} preflightFail=${probe.preflightSummary.fail}`),
    '',
    'Findings:',
    ...report.findings.map((finding) => {
      const field = finding.field ? ` field=${finding.field}` : '';
      return `- ${finding.level.toUpperCase()} ${finding.code}${field}: ${finding.message}`;
    }),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function torBoxLiveSmokeSummaryPackHasFailures(report: TorBoxLiveSmokeSummaryPack): boolean {
  return report.aggregate.failFindings > 0;
}

function fromFindings(
  probes: readonly TorBoxLiveSmokeSummaryProbe[],
  findings: readonly TorBoxLiveSmokeSummaryFinding[],
): TorBoxLiveSmokeSummaryPack {
  const aggregate = {
    totalReports: probes.length,
    readyForReview: probes.filter((probe) => probe.reviewReadiness === 'ready-for-review').length,
    notReadyForReview: probes.filter((probe) => probe.reviewReadiness !== 'ready-for-review').length,
    okReports: probes.filter((probe) => probe.ok).length,
    failedReports: probes.filter((probe) => !probe.ok).length,
    passFindings: sum(probes, (probe) => probe.preflightSummary.pass) + findings.filter((finding) => finding.level === 'pass').length,
    warnFindings: sum(probes, (probe) => probe.preflightSummary.warn) + findings.filter((finding) => finding.level === 'warn').length,
    failFindings: sum(probes, (probe) => probe.preflightSummary.fail) + findings.filter((finding) => finding.level === 'fail').length,
  };
  return {
    report: 'phase-49-torbox-live-smoke-summary-pack',
    version: 1,
    purpose: 'redaction-safe-live-smoke-summary-pack',
    source: 'explicit-operator-supplied-json-files',
    redactionSafe: true,
    evidenceValuesEchoed: false,
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
    reviewReadiness: aggregate.failFindings === 0 ? 'ready-for-review' : 'not-ready-for-review',
    probes,
    aggregate,
    findings,
  };
}

function sum<T>(items: readonly T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function pass(code: string, field: string, message: string): TorBoxLiveSmokeSummaryFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): TorBoxLiveSmokeSummaryFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): TorBoxLiveSmokeSummaryFinding {
  return { level: 'warn', code, field, message };
}
