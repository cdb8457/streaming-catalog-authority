import {
  validateProductionCustodianDescriptor,
  type ProductionCustodianContractFinding,
  type ProductionCustodianDescriptor,
} from '../core/crypto/production-custodian-contract.js';

export type CustodianEvidencePreflightInputErrorCode =
  | 'DESCRIPTOR_FILE_READ_FAILED'
  | 'DESCRIPTOR_FILE_TOO_LARGE'
  | 'DESCRIPTOR_JSON_MALFORMED'
  | 'DESCRIPTOR_OBJECT_REQUIRED';

export interface CustodianEvidencePreflightSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly total: number;
}

export interface CustodianEvidencePreflightReport {
  readonly report: 'phase-29-custodian-evidence-preflight';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'prepare-o4-production-custodian-evidence-review';
  readonly descriptorInput: 'single-user-supplied-json-file';
  readonly descriptorValuesEchoed: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly closesO4: false;
  readonly reviewReadiness: 'ready-for-review' | 'not-ready-for-review';
  readonly findings: readonly ProductionCustodianContractFinding[];
  readonly summary: CustodianEvidencePreflightSummary;
}

export function buildCustodianEvidencePreflightReport(descriptor: Record<string, unknown>): CustodianEvidencePreflightReport {
  return fromFindings(validateProductionCustodianDescriptor(descriptor as ProductionCustodianDescriptor).findings);
}

export function buildCustodianEvidencePreflightInputErrorReport(
  code: CustodianEvidencePreflightInputErrorCode,
): CustodianEvidencePreflightReport {
  const messageByCode: Record<CustodianEvidencePreflightInputErrorCode, string> = {
    DESCRIPTOR_FILE_READ_FAILED: 'Descriptor JSON file could not be read from the supplied path.',
    DESCRIPTOR_FILE_TOO_LARGE: 'Descriptor JSON file exceeds the preflight size limit.',
    DESCRIPTOR_JSON_MALFORMED: 'Descriptor input is not valid JSON.',
    DESCRIPTOR_OBJECT_REQUIRED: 'Descriptor JSON must be an object, not an array or primitive.',
  };
  return fromFindings([{
    level: 'fail',
    code,
    field: 'descriptor',
    message: messageByCode[code],
  }]);
}

export function parseCustodianEvidenceDescriptorJson(jsonText: string): Record<string, unknown> | CustodianEvidencePreflightInputErrorCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingUtf8Bom(jsonText)) as unknown;
  } catch {
    return 'DESCRIPTOR_JSON_MALFORMED';
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'DESCRIPTOR_OBJECT_REQUIRED';
  }

  return parsed as Record<string, unknown>;
}

function stripLeadingUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

export function formatCustodianEvidencePreflightJson(report: CustodianEvidencePreflightReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatCustodianEvidencePreflightText(report: CustodianEvidencePreflightReport): string {
  const lines: string[] = [];
  lines.push('Phase 29 production custodian evidence preflight');
  lines.push('');
  lines.push('Purpose: prepare O4 production custodian evidence review');
  lines.push(`Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`);
  lines.push(`Descriptor values echoed: ${report.descriptorValuesEchoed ? 'yes' : 'no'}`);
  lines.push(`O4 status: ${report.o4Status}`);
  lines.push(`O5 status: ${report.o5Status}`);
  lines.push(`FileCustodian: ${report.fileCustodianStatus}`);
  lines.push(`Closes O4: ${report.closesO4 ? 'true' : 'false'}`);
  lines.push(`Review readiness: ${report.reviewReadiness}`);
  lines.push(`Summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`);
  lines.push('');
  lines.push('Findings:');
  for (const finding of report.findings) {
    const field = finding.field ? ` field=${finding.field}` : '';
    lines.push(`- ${finding.level.toUpperCase()} ${finding.code}${field}: ${finding.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export function reportHasFailures(report: CustodianEvidencePreflightReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly ProductionCustodianContractFinding[]): CustodianEvidencePreflightReport {
  const summary = summarize(findings);
  return {
    report: 'phase-29-custodian-evidence-preflight',
    version: 1,
    redactionSafe: true,
    purpose: 'prepare-o4-production-custodian-evidence-review',
    descriptorInput: 'single-user-supplied-json-file',
    descriptorValuesEchoed: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    closesO4: false,
    reviewReadiness: summary.fail === 0 ? 'ready-for-review' : 'not-ready-for-review',
    findings,
    summary,
  };
}

function summarize(findings: readonly ProductionCustodianContractFinding[]): CustodianEvidencePreflightSummary {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}
