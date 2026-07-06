export type LaunchDecisionRecordInputErrorCode =
  | 'LAUNCH_DECISION_INPUT_REQUIRED'
  | 'LAUNCH_DECISION_FILE_READ_FAILED'
  | 'LAUNCH_DECISION_FILE_TOO_LARGE'
  | 'LAUNCH_DECISION_JSON_MALFORMED'
  | 'LAUNCH_DECISION_OBJECT_REQUIRED';

export type LaunchDecisionDisposition = 'blocked' | 'deferred' | 'launch-candidate-requested';
export type ProductionSecurityDecision = 'blocked' | 'proven' | 'residual-risk-accepted';
export type OperatorSectionDecision = 'accepted' | 'blocked' | 'deferred';
export type ReviewerVerdict = 'GO' | 'HOLD' | 'NOT_REQUESTED';

export interface LaunchDecisionRecordFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field?: string;
  readonly message: string;
}

export interface LaunchDecisionRecordReport {
  readonly report: 'phase-85-launch-decision-record-preflight';
  readonly version: 1;
  readonly purpose: 'verify-redaction-safe-launch-decision-record';
  readonly source: 'single-operator-supplied-launch-decision-record-json-file';
  readonly sourcePacket: 'phase-84-operator-acceptance-packet';
  readonly redactionSafe: true;
  readonly recordValuesEchoed: false;
  readonly artifactContentsIncluded: false;
  readonly credentialValuesIncluded: false;
  readonly credentialPathsIncluded: false;
  readonly rawRefsIncluded: false;
  readonly providerPayloadsIncluded: false;
  readonly liveServiceContact: false;
  readonly commandExecution: false;
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred-or-operator-accepted-residual-risk';
  readonly o5Status: 'open/deferred-or-operator-accepted-residual-risk';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly disposition: LaunchDecisionDisposition | 'invalid';
  readonly launchCandidateReadiness: 'ready-for-review' | 'blocked';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly LaunchDecisionRecordFinding[];
}

const DISPOSITIONS = new Set<LaunchDecisionDisposition>([
  'blocked',
  'deferred',
  'launch-candidate-requested',
]);
const PRODUCTION_SECURITY_DECISIONS = new Set<ProductionSecurityDecision>([
  'blocked',
  'proven',
  'residual-risk-accepted',
]);
const OPERATOR_SECTION_DECISIONS = new Set<OperatorSectionDecision>([
  'accepted',
  'blocked',
  'deferred',
]);
const REVIEWER_VERDICTS = new Set<ReviewerVerdict>(['GO', 'HOLD', 'NOT_REQUESTED']);

export function buildLaunchDecisionRecordReport(record: Record<string, unknown>): LaunchDecisionRecordReport {
  const findings: LaunchDecisionRecordFinding[] = [];

  findings.push(...requiredLiteral(record, 'report', 'phase-85-launch-decision-record', 'LAUNCH_DECISION_RECORD_VALID'));
  findings.push(...requiredLiteral(record, 'sourcePacket', 'phase-84-operator-acceptance-packet', 'SOURCE_PACKET_PHASE_84'));
  findings.push(...requiredLiteral(record, 'redactionSafe', true, 'REDACTION_SAFE'));
  findings.push(...requiredLiteral(record, 'artifactContentsIncluded', false, 'NO_ARTIFACT_CONTENTS'));
  findings.push(...requiredLiteral(record, 'credentialValuesIncluded', false, 'NO_CREDENTIAL_VALUES'));
  findings.push(...requiredLiteral(record, 'credentialPathsIncluded', false, 'NO_CREDENTIAL_PATHS'));
  findings.push(...requiredLiteral(record, 'rawRefsIncluded', false, 'NO_RAW_REFS'));
  findings.push(...requiredLiteral(record, 'providerPayloadsIncluded', false, 'NO_PROVIDER_PAYLOADS'));
  findings.push(...requiredLiteral(record, 'liveServiceContact', false, 'NO_LIVE_SERVICE_CONTACT'));
  findings.push(...requiredLiteral(record, 'commandExecution', false, 'NO_COMMAND_EXECUTION'));
  findings.push(...requiredLiteral(record, 'launchApproved', false, 'NO_LAUNCH_APPROVAL'));
  findings.push(...requiredLiteral(record, 'productionReady', false, 'NO_PRODUCTION_READY_CLAIM'));
  findings.push(...requiredLiteral(record, 'closesO4', false, 'DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(record, 'closesO5', false, 'DOES_NOT_CLOSE_O5'));
  findings.push(...requiredLiteral(record, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));

  const disposition = enumField(record, 'disposition', DISPOSITIONS, 'LAUNCH_DECISION_DISPOSITION');
  findings.push(disposition.ok
    ? pass(`LAUNCH_DECISION_${disposition.value.toUpperCase().replace(/-/g, '_')}`, 'disposition', 'disposition has a fixed allowed value.')
    : fail('LAUNCH_DECISION_DISPOSITION_REQUIRED', 'disposition', 'disposition must be blocked, deferred, or launch-candidate-requested.'));

  const productionSecurity = enumField(record, 'productionSecurityDecision', PRODUCTION_SECURITY_DECISIONS, 'PRODUCTION_SECURITY_DECISION');
  findings.push(productionSecurity.ok
    ? pass(`PRODUCTION_SECURITY_${productionSecurity.value.toUpperCase().replace(/-/g, '_')}`, 'productionSecurityDecision', 'production security decision has a fixed allowed value.')
    : fail('PRODUCTION_SECURITY_DECISION_REQUIRED', 'productionSecurityDecision', 'productionSecurityDecision must be blocked, proven, or residual-risk-accepted.'));

  const rehearsal = enumField(record, 'unraidOperatorRehearsal', OPERATOR_SECTION_DECISIONS, 'UNRAID_OPERATOR_REHEARSAL');
  findings.push(rehearsal.ok
    ? pass(`UNRAID_REHEARSAL_${rehearsal.value.toUpperCase()}`, 'unraidOperatorRehearsal', 'operator rehearsal decision has a fixed allowed value.')
    : fail('UNRAID_OPERATOR_REHEARSAL_REQUIRED', 'unraidOperatorRehearsal', 'unraidOperatorRehearsal must be accepted, blocked, or deferred.'));

  const liveValidation = enumField(record, 'liveServiceValidation', OPERATOR_SECTION_DECISIONS, 'LIVE_SERVICE_VALIDATION');
  findings.push(liveValidation.ok
    ? pass(`LIVE_VALIDATION_${liveValidation.value.toUpperCase()}`, 'liveServiceValidation', 'live validation decision has a fixed allowed value.')
    : fail('LIVE_SERVICE_VALIDATION_REQUIRED', 'liveServiceValidation', 'liveServiceValidation must be accepted, blocked, or deferred.'));

  const reviewer = enumField(record, 'independentReviewerVerdict', REVIEWER_VERDICTS, 'INDEPENDENT_REVIEWER_VERDICT');
  findings.push(reviewer.ok
    ? pass(`INDEPENDENT_REVIEWER_${reviewer.value}`, 'independentReviewerVerdict', 'independent reviewer verdict has a fixed allowed value.')
    : fail('INDEPENDENT_REVIEWER_VERDICT_REQUIRED', 'independentReviewerVerdict', 'independentReviewerVerdict must be GO, HOLD, or NOT_REQUESTED.'));

  if (productionSecurity.ok && productionSecurity.value === 'residual-risk-accepted') {
    findings.push(warn('RESIDUAL_RISK_ACCEPTED_FOR_O4_OR_O5', 'productionSecurityDecision', 'Residual risk acceptance is recorded for review only and does not close O4 or O5.'));
  }
  if (productionSecurity.ok && productionSecurity.value === 'blocked') {
    findings.push(warn('PRODUCTION_SECURITY_STILL_BLOCKED', 'productionSecurityDecision', 'Production security remains blocked before any launch-candidate phase.'));
  }
  if (rehearsal.ok && rehearsal.value !== 'accepted') {
    findings.push(warn('OPERATOR_REHEARSAL_NOT_ACCEPTED', 'unraidOperatorRehearsal', 'Operator rehearsal is not accepted.'));
  }
  if (liveValidation.ok && liveValidation.value !== 'accepted') {
    findings.push(warn('LIVE_VALIDATION_NOT_ACCEPTED', 'liveServiceValidation', 'Live service validation is not accepted.'));
  }

  if (disposition.ok && disposition.value === 'launch-candidate-requested') {
    if (!reviewer.ok || reviewer.value !== 'GO') {
      findings.push(fail('LAUNCH_CANDIDATE_REQUIRES_REVIEWER_GO', 'independentReviewerVerdict', 'launch-candidate-requested requires independentReviewerVerdict GO.'));
    }
    if (!productionSecurity.ok || productionSecurity.value === 'blocked') {
      findings.push(fail('LAUNCH_CANDIDATE_REQUIRES_SECURITY_DECISION', 'productionSecurityDecision', 'launch-candidate-requested requires proven or residual-risk-accepted production security decision.'));
    }
    if (!rehearsal.ok || rehearsal.value !== 'accepted') {
      findings.push(fail('LAUNCH_CANDIDATE_REQUIRES_REHEARSAL_ACCEPTED', 'unraidOperatorRehearsal', 'launch-candidate-requested requires accepted operator rehearsal.'));
    }
    if (!liveValidation.ok || liveValidation.value !== 'accepted') {
      findings.push(fail('LAUNCH_CANDIDATE_REQUIRES_LIVE_VALIDATION_ACCEPTED', 'liveServiceValidation', 'launch-candidate-requested requires accepted live validation.'));
    }
  } else if (disposition.ok && disposition.value === 'blocked') {
    findings.push(warn('LAUNCH_DECISION_BLOCKED', 'disposition', 'The launch decision remains blocked.'));
  } else if (disposition.ok && disposition.value === 'deferred') {
    findings.push(warn('LAUNCH_DECISION_DEFERRED', 'disposition', 'The launch decision is deferred.'));
  }

  findings.push(warn('NO_LAUNCH_APPROVAL_GRANTED', 'launchApproved', 'This preflight never approves launch.'));
  findings.push(warn('O4_O5_REMAIN_VISIBLE', 'review', 'O4/O5 remain visible gates unless separately proven or explicitly accepted by the operator.'));

  return fromFindings(findings, disposition.ok ? disposition.value : 'invalid');
}

export function buildLaunchDecisionRecordInputErrorReport(code: LaunchDecisionRecordInputErrorCode): LaunchDecisionRecordReport {
  const messages: Record<LaunchDecisionRecordInputErrorCode, string> = {
    LAUNCH_DECISION_INPUT_REQUIRED: 'One launch decision record JSON file is required.',
    LAUNCH_DECISION_FILE_READ_FAILED: 'A supplied launch decision record JSON file could not be read.',
    LAUNCH_DECISION_FILE_TOO_LARGE: 'A supplied launch decision record JSON file exceeds the preflight input size limit.',
    LAUNCH_DECISION_JSON_MALFORMED: 'A supplied launch decision record input is not valid JSON.',
    LAUNCH_DECISION_OBJECT_REQUIRED: 'A supplied launch decision record JSON value must be an object, not an array or primitive.',
  };
  return fromFindings([fail(code, 'record', messages[code])], 'invalid');
}

export function parseLaunchDecisionRecordJson(jsonText: string): Record<string, unknown> | LaunchDecisionRecordInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'LAUNCH_DECISION_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'LAUNCH_DECISION_JSON_MALFORMED';
  }
}

export function formatLaunchDecisionRecordJson(report: LaunchDecisionRecordReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatLaunchDecisionRecordText(report: LaunchDecisionRecordReport): string {
  const lines = [
    'Phase 85 launch decision record preflight',
    '',
    `Disposition: ${report.disposition}`,
    `Launch candidate readiness: ${report.launchCandidateReadiness}`,
    `Launch approved: ${report.launchApproved ? 'true' : 'false'}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`,
    `Record values echoed: ${report.recordValuesEchoed ? 'yes' : 'no'}`,
    `Artifact contents included: ${report.artifactContentsIncluded ? 'true' : 'false'}`,
    `Live service contact: ${report.liveServiceContact ? 'true' : 'false'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
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

export function launchDecisionRecordHasFailures(report: LaunchDecisionRecordReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(
  findings: readonly LaunchDecisionRecordFinding[],
  disposition: LaunchDecisionRecordReport['disposition'],
): LaunchDecisionRecordReport {
  const summary = summarize(findings);
  return {
    report: 'phase-85-launch-decision-record-preflight',
    version: 1,
    purpose: 'verify-redaction-safe-launch-decision-record',
    source: 'single-operator-supplied-launch-decision-record-json-file',
    sourcePacket: 'phase-84-operator-acceptance-packet',
    redactionSafe: true,
    recordValuesEchoed: false,
    artifactContentsIncluded: false,
    credentialValuesIncluded: false,
    credentialPathsIncluded: false,
    rawRefsIncluded: false,
    providerPayloadsIncluded: false,
    liveServiceContact: false,
    commandExecution: false,
    launchApproved: false,
    productionReady: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred-or-operator-accepted-residual-risk',
    o5Status: 'open/deferred-or-operator-accepted-residual-risk',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    disposition,
    launchCandidateReadiness: summary.fail === 0 && disposition === 'launch-candidate-requested'
      ? 'ready-for-review'
      : 'blocked',
    summary,
    findings,
  };
}

function summarize(findings: readonly LaunchDecisionRecordFinding[]): LaunchDecisionRecordReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): LaunchDecisionRecordFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function enumField<T extends string>(
  object: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<T>,
  _code: string,
): { readonly ok: true; readonly value: T } | { readonly ok: false } {
  return typeof object[field] === 'string' && allowed.has(object[field] as T)
    ? { ok: true, value: object[field] as T }
    : { ok: false };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): LaunchDecisionRecordFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): LaunchDecisionRecordFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): LaunchDecisionRecordFinding {
  return { level: 'warn', code, field, message };
}
