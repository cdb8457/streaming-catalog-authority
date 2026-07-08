export type UnraidProductionDispositionVerdict = 'GO' | 'HOLD';
export type UnraidProductionDispositionInputErrorCode =
  | 'PRODUCTION_DISPOSITION_INPUT_REQUIRED'
  | 'PRODUCTION_DISPOSITION_FILE_READ_FAILED'
  | 'PRODUCTION_DISPOSITION_FILE_TOO_LARGE'
  | 'PRODUCTION_DISPOSITION_JSON_MALFORMED'
  | 'PRODUCTION_DISPOSITION_OBJECT_REQUIRED';

export interface UnraidProductionDispositionFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidProductionDisposition {
  readonly report: 'phase-133-unraid-production-disposition';
  readonly version: 1;
  readonly purpose: 'record-operator-production-disposition-without-approving-launch';
  readonly source: 'single-operator-supplied-unraid-production-disposition-json-file';
  readonly sourceEvidenceReview: 'phase-132-unraid-switch-evidence-review';
  readonly redactionSafe: true;
  readonly dispositionValuesEchoed: false;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly mutatesUnraid: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly verdict: UnraidProductionDispositionVerdict | 'invalid';
  readonly dispositionStatus: 'ready-for-launch-readiness-decision' | 'not-ready-for-launch-readiness-decision';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidProductionDispositionFinding[];
}

const VERDICTS = new Set<UnraidProductionDispositionVerdict>(['GO', 'HOLD']);

export function buildUnraidProductionDisposition(record: Record<string, unknown>): UnraidProductionDisposition {
  const findings: UnraidProductionDispositionFinding[] = [];
  findings.push(...requiredLiteral(record, 'record', 'phase-133-unraid-production-disposition-record', 'PRODUCTION_DISPOSITION_RECORD_LABEL'));
  findings.push(...requiredLiteral(record, 'sourceEvidenceReview', 'phase-132-unraid-switch-evidence-review', 'SOURCE_EVIDENCE_REVIEW'));
  findings.push(...requiredLiteral(record, 'sourceEvidenceReviewStatus', 'ready-for-final-production-disposition', 'SOURCE_EVIDENCE_REVIEW_READY'));
  findings.push(...requiredLiteral(record, 'serviceEvidenceStatus', 'service-evidence-present', 'SERVICE_EVIDENCE_PRESENT'));
  findings.push(...requiredLiteral(record, 'redactionSafe', true, 'PRODUCTION_DISPOSITION_REDACTION_SAFE'));
  findings.push(...requiredLiteral(record, 'dispositionValuesEchoed', false, 'PRODUCTION_DISPOSITION_NO_VALUES'));
  findings.push(...requiredLiteral(record, 'inputValuesEchoed', false, 'PRODUCTION_DISPOSITION_NO_INPUT_VALUES'));
  findings.push(...requiredLiteral(record, 'commandExecution', false, 'PRODUCTION_DISPOSITION_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(record, 'scriptGenerated', false, 'PRODUCTION_DISPOSITION_NO_SCRIPT'));
  findings.push(...requiredLiteral(record, 'mutatesUnraid', false, 'PRODUCTION_DISPOSITION_NO_MUTATION'));
  findings.push(...requiredLiteral(record, 'providerContactAllowed', false, 'PRODUCTION_DISPOSITION_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(record, 'providerModeEnabled', false, 'PRODUCTION_DISPOSITION_NO_PROVIDER_MODE'));
  findings.push(...requiredLiteral(record, 'productionReady', false, 'PRODUCTION_DISPOSITION_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(record, 'launchApproved', false, 'PRODUCTION_DISPOSITION_NOT_LAUNCH_APPROVED'));
  findings.push(...requiredLiteral(record, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));

  const verdict = typeof record.verdict === 'string' && VERDICTS.has(record.verdict as UnraidProductionDispositionVerdict)
    ? record.verdict as UnraidProductionDispositionVerdict
    : 'invalid';
  findings.push(verdict === 'invalid'
    ? fail('PRODUCTION_DISPOSITION_VERDICT_REQUIRED', 'verdict', 'verdict must be GO or HOLD.')
    : pass(`PRODUCTION_DISPOSITION_VERDICT_${verdict}`, 'verdict', 'verdict has a fixed allowed value.'));

  if (verdict === 'GO') {
    findings.push(pass('PRODUCTION_DISPOSITION_GO_READY_FOR_LAUNCH_DECISION', 'verdict', 'operator GO can proceed to a separate launch-readiness decision.'));
  } else if (verdict === 'HOLD') {
    findings.push(warn('PRODUCTION_DISPOSITION_HOLD', 'verdict', 'operator HOLD blocks launch-readiness decision.'));
  }
  findings.push(warn('DISPOSITION_DOES_NOT_APPROVE_PRODUCTION', 'productionReady', 'This disposition does not set productionReady true.'));
  findings.push(warn('DISPOSITION_DOES_NOT_APPROVE_LAUNCH', 'launchApproved', 'This disposition does not set launchApproved true.'));
  return fromFindings(findings, verdict);
}

export function buildUnraidProductionDispositionInputError(code: UnraidProductionDispositionInputErrorCode): UnraidProductionDisposition {
  const messages: Record<UnraidProductionDispositionInputErrorCode, string> = {
    PRODUCTION_DISPOSITION_INPUT_REQUIRED: 'One Unraid production disposition JSON input is required.',
    PRODUCTION_DISPOSITION_FILE_READ_FAILED: 'The supplied Unraid production disposition JSON file could not be read.',
    PRODUCTION_DISPOSITION_FILE_TOO_LARGE: 'The supplied Unraid production disposition JSON file exceeds the input size limit.',
    PRODUCTION_DISPOSITION_JSON_MALFORMED: 'The supplied Unraid production disposition input is not valid JSON.',
    PRODUCTION_DISPOSITION_OBJECT_REQUIRED: 'The supplied Unraid production disposition JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])], 'invalid');
}

export function parseUnraidProductionDispositionJson(jsonText: string): Record<string, unknown> | UnraidProductionDispositionInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'PRODUCTION_DISPOSITION_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'PRODUCTION_DISPOSITION_JSON_MALFORMED';
  }
}

export function formatUnraidProductionDispositionJson(report: UnraidProductionDisposition): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatUnraidProductionDispositionText(report: UnraidProductionDisposition): string {
  const lines = [
    'Phase 133 Unraid production disposition',
    `Verdict: ${report.verdict}`,
    `Disposition status: ${report.dispositionStatus}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Launch approved: ${report.launchApproved ? 'true' : 'false'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidProductionDispositionHasFailures(report: UnraidProductionDisposition): boolean {
  return report.summary.fail > 0;
}

function fromFindings(
  findings: readonly UnraidProductionDispositionFinding[],
  verdict: UnraidProductionDisposition['verdict'],
): UnraidProductionDisposition {
  const summary = summarize(findings);
  const ready = summary.fail === 0 && verdict === 'GO';
  return {
    report: 'phase-133-unraid-production-disposition',
    version: 1,
    purpose: 'record-operator-production-disposition-without-approving-launch',
    source: 'single-operator-supplied-unraid-production-disposition-json-file',
    sourceEvidenceReview: 'phase-132-unraid-switch-evidence-review',
    redactionSafe: true,
    dispositionValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    verdict,
    dispositionStatus: ready ? 'ready-for-launch-readiness-decision' : 'not-ready-for-launch-readiness-decision',
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidProductionDispositionFinding[]): UnraidProductionDisposition['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(object: Record<string, unknown>, field: string, expected: string | boolean, passCode: string): UnraidProductionDispositionFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidProductionDispositionFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidProductionDispositionFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidProductionDispositionFinding {
  return { level: 'warn', code, field, message };
}
