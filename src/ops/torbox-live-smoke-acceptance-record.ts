export type TorBoxLiveSmokeAcceptanceInputErrorCode =
  | 'ACCEPTANCE_FILE_READ_FAILED'
  | 'ACCEPTANCE_FILE_TOO_LARGE'
  | 'ACCEPTANCE_JSON_MALFORMED'
  | 'ACCEPTANCE_OBJECT_REQUIRED'
  | 'ACCEPTANCE_INPUT_REQUIRED';

export type TorBoxLiveSmokeAcceptanceDecision = 'accepted' | 'rejected' | 'deferred';

export interface TorBoxLiveSmokeAcceptanceFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field?: string;
  readonly message: string;
}

export interface TorBoxLiveSmokeAcceptanceReport {
  readonly report: 'phase-54-torbox-live-smoke-acceptance-preflight';
  readonly version: 1;
  readonly purpose: 'verify-redaction-safe-live-smoke-acceptance-record';
  readonly source: 'single-operator-supplied-acceptance-record-json-file';
  readonly redactionSafe: true;
  readonly recordValuesEchoed: false;
  readonly artifactContentsIncluded: false;
  readonly credentialValuesIncluded: false;
  readonly credentialPathsIncluded: false;
  readonly rawRefsIncluded: false;
  readonly providerPayloadsIncluded: false;
  readonly liveTorBoxContact: false;
  readonly commandExecution: false;
  readonly enablesProviderMode: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly decision: TorBoxLiveSmokeAcceptanceDecision | 'invalid';
  readonly reviewReadiness: 'ready-for-review' | 'not-ready-for-review';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly TorBoxLiveSmokeAcceptanceFinding[];
}

const ACCEPTANCE_DECISIONS = new Set<TorBoxLiveSmokeAcceptanceDecision>(['accepted', 'rejected', 'deferred']);

export function buildTorBoxLiveSmokeAcceptanceReport(record: Record<string, unknown>): TorBoxLiveSmokeAcceptanceReport {
  const findings: TorBoxLiveSmokeAcceptanceFinding[] = [];
  findings.push(...requiredLiteral(record, 'report', 'phase-54-torbox-live-smoke-acceptance-record', 'ACCEPTANCE_RECORD_VALID'));
  findings.push(...requiredLiteral(record, 'redactionSafe', true, 'ACCEPTANCE_REDACTION_SAFE'));
  findings.push(...requiredLiteral(record, 'artifactContentsIncluded', false, 'ACCEPTANCE_NO_ARTIFACT_CONTENTS'));
  findings.push(...requiredLiteral(record, 'credentialValuesIncluded', false, 'ACCEPTANCE_NO_CREDENTIAL_VALUES'));
  findings.push(...requiredLiteral(record, 'credentialPathsIncluded', false, 'ACCEPTANCE_NO_CREDENTIAL_PATHS'));
  findings.push(...requiredLiteral(record, 'rawRefsIncluded', false, 'ACCEPTANCE_NO_RAW_REFS'));
  findings.push(...requiredLiteral(record, 'providerPayloadsIncluded', false, 'ACCEPTANCE_NO_PROVIDER_PAYLOADS'));
  findings.push(...requiredLiteral(record, 'liveTorBoxContact', false, 'ACCEPTANCE_NON_LIVE'));
  findings.push(...requiredLiteral(record, 'commandExecution', false, 'ACCEPTANCE_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(record, 'enablesProviderMode', false, 'ACCEPTANCE_DOES_NOT_ENABLE_PROVIDER_MODE'));
  findings.push(...requiredLiteral(record, 'closesO4', false, 'ACCEPTANCE_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(record, 'closesO5', false, 'ACCEPTANCE_DOES_NOT_CLOSE_O5'));
  findings.push(...requiredLiteral(record, 'o4Status', 'open/deferred', 'O4_STILL_OPEN'));
  findings.push(...requiredLiteral(record, 'o5Status', 'open/deferred', 'O5_STILL_OPEN'));
  findings.push(...requiredLiteral(record, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));

  const decision = typeof record.decision === 'string' && ACCEPTANCE_DECISIONS.has(record.decision as TorBoxLiveSmokeAcceptanceDecision)
    ? record.decision as TorBoxLiveSmokeAcceptanceDecision
    : 'invalid';
  findings.push(decision === 'invalid'
    ? fail('ACCEPTANCE_DECISION_REQUIRED', 'decision', 'decision must be accepted, rejected, or deferred.')
    : pass(`ACCEPTANCE_DECISION_${decision.toUpperCase()}`, 'decision', 'decision has a fixed allowed value.'));

  findings.push(...requiredLiteral(record, 'packetManifestPreflight', 'ready-for-review', 'PACKET_MANIFEST_READY'));
  if (decision === 'accepted') {
    findings.push(...requiredLiteral(record, 'independentReviewerVerdict', 'GO', 'INDEPENDENT_REVIEWER_GO'));
  } else if (decision === 'rejected') {
    findings.push(warn('ACCEPTANCE_REJECTED', 'decision', 'live-smoke evidence is rejected; provider mode must remain disabled.'));
  } else if (decision === 'deferred') {
    findings.push(warn('ACCEPTANCE_DEFERRED', 'decision', 'live-smoke evidence remains deferred; provider mode must remain disabled.'));
  }

  findings.push(warn('PROVIDER_MODE_STILL_DISABLED', 'provider-mode', 'This record does not enable TorBox provider mode.'));
  findings.push(warn('O4_REMAINS_DEFERRED', 'review', 'O4 production file custodian acceptance remains open/deferred.'));
  findings.push(warn('O5_REMAINS_DEFERRED', 'review', 'O5 managed KEK custody/scheduling remains open/deferred.'));

  return fromFindings(findings, decision);
}

export function buildTorBoxLiveSmokeAcceptanceInputErrorReport(
  code: TorBoxLiveSmokeAcceptanceInputErrorCode,
): TorBoxLiveSmokeAcceptanceReport {
  const messages: Record<TorBoxLiveSmokeAcceptanceInputErrorCode, string> = {
    ACCEPTANCE_FILE_READ_FAILED: 'A supplied acceptance record JSON file could not be read.',
    ACCEPTANCE_FILE_TOO_LARGE: 'A supplied acceptance record JSON file exceeds the preflight input size limit.',
    ACCEPTANCE_JSON_MALFORMED: 'A supplied acceptance record input is not valid JSON.',
    ACCEPTANCE_OBJECT_REQUIRED: 'A supplied acceptance record JSON value must be an object, not an array or primitive.',
    ACCEPTANCE_INPUT_REQUIRED: 'One acceptance record input is required.',
  };
  return fromFindings([fail(code, 'record', messages[code])], 'invalid');
}

export function parseTorBoxLiveSmokeAcceptanceJson(
  jsonText: string,
): Record<string, unknown> | TorBoxLiveSmokeAcceptanceInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'ACCEPTANCE_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'ACCEPTANCE_JSON_MALFORMED';
  }
}

export function formatTorBoxLiveSmokeAcceptanceJson(report: TorBoxLiveSmokeAcceptanceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatTorBoxLiveSmokeAcceptanceText(report: TorBoxLiveSmokeAcceptanceReport): string {
  const lines = [
    'Phase 54 TorBox live smoke acceptance preflight',
    '',
    `Decision: ${report.decision}`,
    `Review readiness: ${report.reviewReadiness}`,
    `Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`,
    `Record values echoed: ${report.recordValuesEchoed ? 'yes' : 'no'}`,
    `Artifact contents included: ${report.artifactContentsIncluded ? 'true' : 'false'}`,
    `Live TorBox contact: ${report.liveTorBoxContact ? 'true' : 'false'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Enables provider mode: ${report.enablesProviderMode ? 'true' : 'false'}`,
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

export function torBoxLiveSmokeAcceptanceHasFailures(report: TorBoxLiveSmokeAcceptanceReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(
  findings: readonly TorBoxLiveSmokeAcceptanceFinding[],
  decision: TorBoxLiveSmokeAcceptanceReport['decision'],
): TorBoxLiveSmokeAcceptanceReport {
  const summary = summarize(findings);
  return {
    report: 'phase-54-torbox-live-smoke-acceptance-preflight',
    version: 1,
    purpose: 'verify-redaction-safe-live-smoke-acceptance-record',
    source: 'single-operator-supplied-acceptance-record-json-file',
    redactionSafe: true,
    recordValuesEchoed: false,
    artifactContentsIncluded: false,
    credentialValuesIncluded: false,
    credentialPathsIncluded: false,
    rawRefsIncluded: false,
    providerPayloadsIncluded: false,
    liveTorBoxContact: false,
    commandExecution: false,
    enablesProviderMode: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    decision,
    reviewReadiness: summary.fail === 0 ? 'ready-for-review' : 'not-ready-for-review',
    summary,
    findings,
  };
}

function summarize(findings: readonly TorBoxLiveSmokeAcceptanceFinding[]): TorBoxLiveSmokeAcceptanceReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): TorBoxLiveSmokeAcceptanceFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): TorBoxLiveSmokeAcceptanceFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): TorBoxLiveSmokeAcceptanceFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): TorBoxLiveSmokeAcceptanceFinding {
  return { level: 'warn', code, field, message };
}
