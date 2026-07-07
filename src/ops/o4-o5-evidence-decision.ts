import {
  buildCustodianEvidencePreflightInputErrorReport,
  buildCustodianEvidencePreflightReport,
  parseCustodianEvidenceDescriptorJson,
  reportHasFailures as custodianReportHasFailures,
  type CustodianEvidencePreflightInputErrorCode,
  type CustodianEvidencePreflightReport,
} from './custodian-evidence-preflight.js';
import {
  buildKekEvidencePreflightInputErrorReport,
  buildKekEvidencePreflightReport,
  parseKekEvidenceDescriptorJson,
  reportHasFailures as kekReportHasFailures,
  type KekEvidencePreflightInputErrorCode,
  type KekEvidencePreflightReport,
} from './kek-evidence-preflight.js';

export type O4O5EvidenceDecisionInputErrorCode =
  | 'DECISION_FILE_READ_FAILED'
  | 'DECISION_FILE_TOO_LARGE'
  | 'DECISION_JSON_MALFORMED'
  | 'DECISION_OBJECT_REQUIRED'
  | 'CUSTODIAN_DESCRIPTOR_FILE_READ_FAILED'
  | 'CUSTODIAN_DESCRIPTOR_FILE_TOO_LARGE'
  | 'KEK_DESCRIPTOR_FILE_READ_FAILED'
  | 'KEK_DESCRIPTOR_FILE_TOO_LARGE';

export type O4O5EvidenceDecisionFindingLevel = 'pass' | 'warn' | 'fail';

export interface O4O5ImplementationDecisionRecord {
  readonly decisionLabel?: string;
  readonly decisionStatus?: string;
  readonly o4CustodianDirection?: string;
  readonly o5CustodyDirection?: string;
  readonly unraidDeploymentMode?: string;
  readonly liveServiceContactAllowed?: boolean;
  readonly implementationScopeLabel?: string;
  readonly requiredEvidenceLabels?: readonly unknown[];
  readonly reviewerLabel?: string;
  readonly residualRiskLabel?: string;
  readonly closesO4?: boolean;
  readonly closesO5?: boolean;
}

export interface O4O5EvidenceDecisionFinding {
  readonly level: O4O5EvidenceDecisionFindingLevel;
  readonly code: string;
  readonly field: keyof O4O5ImplementationDecisionRecord | 'descriptor' | 'packet';
  readonly message: string;
}

export interface O4O5EvidenceDecisionSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly total: number;
}

export interface O4O5EvidenceDecisionReport {
  readonly report: 'phase-96-o4-o5-evidence-decision-packet';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'authorize-one-offline-o4-o5-evidence-contract-slice';
  readonly decisionInput: 'single-user-supplied-json-file';
  readonly descriptorInputs: 'one-o4-descriptor-and-one-o5-descriptor';
  readonly inputValuesEchoed: false;
  readonly authorizedScope: 'contract-harness-expansion-without-live-service-contact' | 'not-authorized';
  readonly liveServiceContactAllowed: false;
  readonly runtimeImplementationAuthorized: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly closesO4: false;
  readonly closesO5: false;
  readonly custodianPreflight: CustodianEvidencePreflightReport;
  readonly kekPreflight: KekEvidencePreflightReport;
  readonly reviewReadiness: 'ready-for-review' | 'not-ready-for-review';
  readonly findings: readonly O4O5EvidenceDecisionFinding[];
  readonly summary: O4O5EvidenceDecisionSummary;
}

const REQUIRED_EVIDENCE_LABELS = [
  'phase-95-review-handoff',
  'production-custodian-contract-existing',
  'custodian-acceptance-harness-existing',
  'custodian-preflight-report-redacted',
  'kek-preflight-report-redacted',
  'kek-rewrap-plan-redacted',
  'redaction-review-required',
] as const;

export function buildO4O5EvidenceDecisionPacket(
  decision: Record<string, unknown>,
  custodianDescriptor: Record<string, unknown> | CustodianEvidencePreflightInputErrorCode,
  kekDescriptor: Record<string, unknown> | KekEvidencePreflightInputErrorCode,
): O4O5EvidenceDecisionReport {
  const custodianPreflight = typeof custodianDescriptor === 'string'
    ? buildCustodianEvidencePreflightInputErrorReport(custodianDescriptor)
    : buildCustodianEvidencePreflightReport(custodianDescriptor);
  const kekPreflight = typeof kekDescriptor === 'string'
    ? buildKekEvidencePreflightInputErrorReport(kekDescriptor)
    : buildKekEvidencePreflightReport(kekDescriptor);
  const findings = validateDecision(decision as O4O5ImplementationDecisionRecord);

  if (custodianReportHasFailures(custodianPreflight)) {
    findings.push(fail('O4_PREFLIGHT_NOT_READY', 'descriptor', 'O4 custodian descriptor preflight must pass before this evidence packet is ready for review.'));
  } else {
    findings.push(pass('O4_PREFLIGHT_READY', 'descriptor', 'O4 custodian descriptor preflight is ready for review but does not close O4.'));
  }

  if (kekReportHasFailures(kekPreflight)) {
    findings.push(fail('O5_PREFLIGHT_NOT_READY', 'descriptor', 'O5 KEK descriptor preflight must pass before this evidence packet is ready for review.'));
  } else {
    findings.push(pass('O5_PREFLIGHT_READY', 'descriptor', 'O5 KEK descriptor preflight is ready for review but does not close O5.'));
  }

  findings.push(warn('O4_REMAINS_OPEN', 'packet', 'O4 remains open/deferred until real custodian evidence is separately reviewed.'));
  findings.push(warn('O5_REMAINS_OPEN', 'packet', 'O5 remains open/deferred until managed KEK custody and rotation evidence is separately reviewed.'));
  findings.push(warn('NO_LIVE_SERVICE_CONTACT', 'packet', 'This packet authorizes no live custodian, KMS, secret store, provider, or media-service contact.'));

  const summary = summarize(findings);
  const authorized = summary.fail === 0;
  return {
    report: 'phase-96-o4-o5-evidence-decision-packet',
    version: 1,
    redactionSafe: true,
    purpose: 'authorize-one-offline-o4-o5-evidence-contract-slice',
    decisionInput: 'single-user-supplied-json-file',
    descriptorInputs: 'one-o4-descriptor-and-one-o5-descriptor',
    inputValuesEchoed: false,
    authorizedScope: authorized ? 'contract-harness-expansion-without-live-service-contact' : 'not-authorized',
    liveServiceContactAllowed: false,
    runtimeImplementationAuthorized: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    closesO4: false,
    closesO5: false,
    custodianPreflight,
    kekPreflight,
    reviewReadiness: authorized ? 'ready-for-review' : 'not-ready-for-review',
    findings,
    summary,
  };
}

export function buildO4O5EvidenceDecisionInputErrorReport(code: O4O5EvidenceDecisionInputErrorCode): O4O5EvidenceDecisionReport {
  const custodianCode: CustodianEvidencePreflightInputErrorCode =
    code === 'CUSTODIAN_DESCRIPTOR_FILE_TOO_LARGE' ? 'DESCRIPTOR_FILE_TOO_LARGE' : 'DESCRIPTOR_FILE_READ_FAILED';
  const kekCode: KekEvidencePreflightInputErrorCode =
    code === 'KEK_DESCRIPTOR_FILE_TOO_LARGE' ? 'DESCRIPTOR_FILE_TOO_LARGE' : 'DESCRIPTOR_FILE_READ_FAILED';
  const custodianPreflight = code.startsWith('CUSTODIAN_')
    ? buildCustodianEvidencePreflightInputErrorReport(custodianCode)
    : buildCustodianEvidencePreflightInputErrorReport('DESCRIPTOR_OBJECT_REQUIRED');
  const kekPreflight = code.startsWith('KEK_')
    ? buildKekEvidencePreflightInputErrorReport(kekCode)
    : buildKekEvidencePreflightInputErrorReport('DESCRIPTOR_OBJECT_REQUIRED');
  const report = buildEmptyReport(custodianPreflight, kekPreflight, [fail(code, 'packet', inputErrorMessage(code))]);
  return report;
}

export function parseO4O5ImplementationDecisionJson(jsonText: string): Record<string, unknown> | O4O5EvidenceDecisionInputErrorCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingUtf8Bom(jsonText)) as unknown;
  } catch {
    return 'DECISION_JSON_MALFORMED';
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'DECISION_OBJECT_REQUIRED';
  }

  return parsed as Record<string, unknown>;
}

export function parseO4O5CustodianDescriptorJson(jsonText: string): Record<string, unknown> | CustodianEvidencePreflightInputErrorCode {
  return parseCustodianEvidenceDescriptorJson(jsonText);
}

export function parseO4O5KekDescriptorJson(jsonText: string): Record<string, unknown> | KekEvidencePreflightInputErrorCode {
  return parseKekEvidenceDescriptorJson(jsonText);
}

export function formatO4O5EvidenceDecisionJson(report: O4O5EvidenceDecisionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatO4O5EvidenceDecisionText(report: O4O5EvidenceDecisionReport): string {
  const lines = [
    'Phase 96 O4/O5 evidence decision packet',
    '',
    'Purpose: authorize one offline O4/O5 evidence contract slice',
    `Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`,
    `Input values echoed: ${report.inputValuesEchoed ? 'yes' : 'no'}`,
    `Authorized scope: ${report.authorizedScope}`,
    `Live service contact allowed: ${report.liveServiceContactAllowed ? 'true' : 'false'}`,
    `Runtime implementation authorized: ${report.runtimeImplementationAuthorized ? 'true' : 'false'}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `FileCustodian: ${report.fileCustodianStatus}`,
    `Closes O4: ${report.closesO4 ? 'true' : 'false'}`,
    `Closes O5: ${report.closesO5 ? 'true' : 'false'}`,
    `Review readiness: ${report.reviewReadiness}`,
    `Summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    'Findings:',
  ];
  for (const finding of report.findings) {
    lines.push(`- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`);
  }
  lines.push('');
  lines.push(`O4 preflight: ${report.custodianPreflight.reviewReadiness}; fail=${report.custodianPreflight.summary.fail}`);
  lines.push(`O5 preflight: ${report.kekPreflight.reviewReadiness}; fail=${report.kekPreflight.summary.fail}`);
  return `${lines.join('\n')}\n`;
}

export function o4O5EvidenceDecisionHasFailures(report: O4O5EvidenceDecisionReport): boolean {
  return report.summary.fail > 0 || custodianReportHasFailures(report.custodianPreflight) || kekReportHasFailures(report.kekPreflight);
}

function validateDecision(decision: O4O5ImplementationDecisionRecord): O4O5EvidenceDecisionFinding[] {
  const findings: O4O5EvidenceDecisionFinding[] = [];
  requireLabel(decision.decisionLabel, 'decisionLabel', 'DECISION_LABEL_REQUIRED', findings);
  requireEquals(decision.decisionStatus, 'authorize-one-slice', 'decisionStatus', 'DECISION_STATUS_AUTHORIZE_ONE_SLICE_REQUIRED', findings);
  requireAllowed(decision.o4CustodianDirection, ['defer'], 'o4CustodianDirection', 'O4_DIRECTION_DEFER_REQUIRED_FOR_THIS_SLICE', findings);
  requireAllowed(decision.o5CustodyDirection, ['defer'], 'o5CustodyDirection', 'O5_DIRECTION_DEFER_REQUIRED_FOR_THIS_SLICE', findings);
  requireEquals(decision.unraidDeploymentMode, 'catalog-one-shot-ops-bind-mounted', 'unraidDeploymentMode', 'UNRAID_DEPLOYMENT_MODE_REQUIRED', findings);
  requireEquals(decision.liveServiceContactAllowed, false, 'liveServiceContactAllowed', 'LIVE_SERVICE_CONTACT_MUST_BE_FALSE', findings);
  requireEquals(decision.implementationScopeLabel, 'contract-harness-expansion-without-live-service-contact', 'implementationScopeLabel', 'IMPLEMENTATION_SCOPE_NOT_AUTHORIZED', findings);
  requireLabel(decision.reviewerLabel, 'reviewerLabel', 'REVIEWER_LABEL_REQUIRED', findings);
  requireLabel(decision.residualRiskLabel, 'residualRiskLabel', 'RESIDUAL_RISK_LABEL_REQUIRED', findings);
  requireEquals(decision.closesO4, false, 'closesO4', 'CLOSES_O4_MUST_BE_FALSE', findings);
  requireEquals(decision.closesO5, false, 'closesO5', 'CLOSES_O5_MUST_BE_FALSE', findings);
  validateEvidenceLabels(decision.requiredEvidenceLabels, findings);
  return findings;
}

function validateEvidenceLabels(values: readonly unknown[] | undefined, findings: O4O5EvidenceDecisionFinding[]): void {
  if (!Array.isArray(values)) {
    findings.push(fail('REQUIRED_EVIDENCE_LABELS_REQUIRED', 'requiredEvidenceLabels', 'Required evidence labels must be present as an array.'));
    return;
  }

  const labels = new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0));
  for (const required of REQUIRED_EVIDENCE_LABELS) {
    if (labels.has(required)) findings.push(pass(`${required.replaceAll('-', '_').toUpperCase()}_LABEL_PRESENT`, 'requiredEvidenceLabels', `${required} label is present.`));
    else findings.push(fail(`${required.replaceAll('-', '_').toUpperCase()}_LABEL_REQUIRED`, 'requiredEvidenceLabels', `${required} label is required.`));
  }
}

function requireLabel(
  value: unknown,
  field: keyof O4O5ImplementationDecisionRecord,
  code: string,
  findings: O4O5EvidenceDecisionFinding[],
): void {
  if (typeof value === 'string' && value.trim().length > 0) findings.push(pass(`${code.replace('_REQUIRED', '')}_PRESENT`, field, `${field} is present.`));
  else findings.push(fail(code, field, `${field} is required.`));
}

function requireEquals(
  actual: unknown,
  expected: unknown,
  field: keyof O4O5ImplementationDecisionRecord,
  code: string,
  findings: O4O5EvidenceDecisionFinding[],
): void {
  if (actual === expected) findings.push(pass(`${code.replace('_REQUIRED', '').replace('_MUST_BE_FALSE', '')}_PASS`, field, `${field} has the required value.`));
  else findings.push(fail(code, field, `${field} does not match the required value for this slice.`));
}

function requireAllowed(
  actual: unknown,
  allowed: readonly string[],
  field: keyof O4O5ImplementationDecisionRecord,
  code: string,
  findings: O4O5EvidenceDecisionFinding[],
): void {
  if (typeof actual === 'string' && allowed.includes(actual)) findings.push(pass(`${code.replace('_REQUIRED_FOR_THIS_SLICE', '')}_PASS`, field, `${field} is allowed for this slice.`));
  else findings.push(fail(code, field, `${field} is not allowed for this offline evidence slice.`));
}

function buildEmptyReport(
  custodianPreflight: CustodianEvidencePreflightReport,
  kekPreflight: KekEvidencePreflightReport,
  findings: readonly O4O5EvidenceDecisionFinding[],
): O4O5EvidenceDecisionReport {
  const summary = summarize(findings);
  return {
    report: 'phase-96-o4-o5-evidence-decision-packet',
    version: 1,
    redactionSafe: true,
    purpose: 'authorize-one-offline-o4-o5-evidence-contract-slice',
    decisionInput: 'single-user-supplied-json-file',
    descriptorInputs: 'one-o4-descriptor-and-one-o5-descriptor',
    inputValuesEchoed: false,
    authorizedScope: 'not-authorized',
    liveServiceContactAllowed: false,
    runtimeImplementationAuthorized: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    closesO4: false,
    closesO5: false,
    custodianPreflight,
    kekPreflight,
    reviewReadiness: 'not-ready-for-review',
    findings,
    summary,
  };
}

function inputErrorMessage(code: O4O5EvidenceDecisionInputErrorCode): string {
  const messages: Record<O4O5EvidenceDecisionInputErrorCode, string> = {
    DECISION_FILE_READ_FAILED: 'Decision JSON file could not be read from the supplied path.',
    DECISION_FILE_TOO_LARGE: 'Decision JSON file exceeds the preflight size limit.',
    DECISION_JSON_MALFORMED: 'Decision input is not valid JSON.',
    DECISION_OBJECT_REQUIRED: 'Decision JSON must be an object, not an array or primitive.',
    CUSTODIAN_DESCRIPTOR_FILE_READ_FAILED: 'O4 custodian descriptor JSON file could not be read.',
    CUSTODIAN_DESCRIPTOR_FILE_TOO_LARGE: 'O4 custodian descriptor JSON file exceeds the preflight size limit.',
    KEK_DESCRIPTOR_FILE_READ_FAILED: 'O5 KEK descriptor JSON file could not be read.',
    KEK_DESCRIPTOR_FILE_TOO_LARGE: 'O5 KEK descriptor JSON file exceeds the preflight size limit.',
  };
  return messages[code];
}

function summarize(findings: readonly O4O5EvidenceDecisionFinding[]): O4O5EvidenceDecisionSummary {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function stripLeadingUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function pass(code: string, field: O4O5EvidenceDecisionFinding['field'], message: string): O4O5EvidenceDecisionFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: O4O5EvidenceDecisionFinding['field'], message: string): O4O5EvidenceDecisionFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: O4O5EvidenceDecisionFinding['field'], message: string): O4O5EvidenceDecisionFinding {
  return { level: 'warn', code, field, message };
}

