export type UnraidProductionSwitchRunbookInputErrorCode =
  | 'PRODUCTION_SWITCH_INPUT_REQUIRED'
  | 'PRODUCTION_SWITCH_FILE_READ_FAILED'
  | 'PRODUCTION_SWITCH_FILE_TOO_LARGE'
  | 'PRODUCTION_SWITCH_JSON_MALFORMED'
  | 'PRODUCTION_SWITCH_OBJECT_REQUIRED';

export interface UnraidProductionSwitchRunbookFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidProductionSwitchRunbook {
  readonly report: 'phase-130-unraid-production-switch-runbook';
  readonly version: 1;
  readonly purpose: 'prepare-operator-production-switch-runbook-without-mutating-unraid';
  readonly source: 'single-operator-supplied-phase-129-final-human-approval-record-preflight-json-file';
  readonly sourceApprovalPreflight: 'phase-129-unraid-final-human-approval-record-preflight';
  readonly requiredApprovalRecordStatus: 'ready-for-operator-production-switch';
  readonly requiredLiveEvidence: 'unraid-live-operating-test-2026-07-08.redacted.md';
  readonly composeOverrideFile: 'docker-compose.unraid-bind.yml';
  readonly redactionSafe: true;
  readonly recordValuesEchoed: false;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly mutatesUnraid: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly serviceInstallApproved: true;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly switchReadiness: 'ready-for-explicit-operator-window' | 'not-ready-for-explicit-operator-window';
  readonly operatorChecklist: readonly string[];
  readonly commandPlan: {
    readonly preflightDoctor: string;
    readonly installOrStartService: string;
    readonly postStartDoctor: string;
    readonly rollbackStop: string;
    readonly cleanupCheck: string;
  };
  readonly evidencePlan: readonly string[];
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidProductionSwitchRunbookFinding[];
}

export function buildUnraidProductionSwitchRunbook(
  approvalPreflight: Record<string, unknown>,
): UnraidProductionSwitchRunbook {
  const findings: UnraidProductionSwitchRunbookFinding[] = [];
  findings.push(...requiredLiteral(approvalPreflight, 'report', 'phase-129-unraid-final-human-approval-record-preflight', 'PHASE_129_PREFLIGHT_REPORT'));
  findings.push(...requiredLiteral(approvalPreflight, 'approvalRecordStatus', 'ready-for-operator-production-switch', 'PHASE_129_READY_FOR_SWITCH'));
  findings.push(...requiredLiteral(approvalPreflight, 'verdict', 'GO', 'PHASE_129_VERDICT_GO'));
  findings.push(...requiredLiteral(approvalPreflight, 'redactionSafe', true, 'PHASE_129_REDACTION_SAFE'));
  findings.push(...requiredLiteral(approvalPreflight, 'recordValuesEchoed', false, 'PHASE_129_NO_RECORD_VALUES'));
  findings.push(...requiredLiteral(approvalPreflight, 'inputValuesEchoed', false, 'PHASE_129_NO_INPUT_VALUES'));
  findings.push(...requiredLiteral(approvalPreflight, 'commandExecution', false, 'PHASE_129_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(approvalPreflight, 'scriptGenerated', false, 'PHASE_129_NO_SCRIPT'));
  findings.push(...requiredLiteral(approvalPreflight, 'serviceInstallApproved', true, 'PHASE_129_INSTALL_WINDOW_APPROVED'));
  findings.push(...requiredLiteral(approvalPreflight, 'serviceInstalled', false, 'PHASE_129_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(approvalPreflight, 'serviceStarted', false, 'PHASE_129_NO_SERVICE_START'));
  findings.push(...requiredLiteral(approvalPreflight, 'mutatesUnraid', false, 'PHASE_129_NO_UNRAID_MUTATION'));
  findings.push(...requiredLiteral(approvalPreflight, 'providerContactAllowed', false, 'PHASE_129_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(approvalPreflight, 'providerModeEnabled', false, 'PHASE_129_NO_PROVIDER_MODE'));
  findings.push(...requiredLiteral(approvalPreflight, 'productionReady', false, 'PHASE_129_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(approvalPreflight, 'launchApproved', false, 'PHASE_129_NOT_LAUNCH_APPROVED'));
  findings.push(...requiredLiteral(approvalPreflight, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));
  findings.push(pass('LIVE_UNRAID_OPERATING_TEST_REQUIRED', 'liveEvidence', 'operator must retain unraid-live-operating-test-2026-07-08.redacted.md before the switch window.'));
  findings.push(warn('RUNBOOK_DOES_NOT_MUTATE_UNRAID', 'commandExecution', 'This packet documents commands but never executes them.'));
  findings.push(warn('RUNBOOK_DOES_NOT_APPROVE_LAUNCH', 'launchApproved', 'This packet does not flip launchApproved to true.'));
  return fromFindings(findings);
}

export function buildUnraidProductionSwitchRunbookInputError(
  code: UnraidProductionSwitchRunbookInputErrorCode,
): UnraidProductionSwitchRunbook {
  const messages: Record<UnraidProductionSwitchRunbookInputErrorCode, string> = {
    PRODUCTION_SWITCH_INPUT_REQUIRED: 'One Phase 129 final human approval preflight JSON input is required.',
    PRODUCTION_SWITCH_FILE_READ_FAILED: 'The supplied Phase 129 final human approval preflight JSON file could not be read.',
    PRODUCTION_SWITCH_FILE_TOO_LARGE: 'The supplied Phase 129 final human approval preflight JSON file exceeds the input size limit.',
    PRODUCTION_SWITCH_JSON_MALFORMED: 'The supplied Phase 129 final human approval preflight input is not valid JSON.',
    PRODUCTION_SWITCH_OBJECT_REQUIRED: 'The supplied Phase 129 final human approval preflight JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseUnraidProductionSwitchRunbookJson(
  jsonText: string,
): Record<string, unknown> | UnraidProductionSwitchRunbookInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'PRODUCTION_SWITCH_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'PRODUCTION_SWITCH_JSON_MALFORMED';
  }
}

export function formatUnraidProductionSwitchRunbookJson(packet: UnraidProductionSwitchRunbook): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatUnraidProductionSwitchRunbookText(packet: UnraidProductionSwitchRunbook): string {
  const lines = [
    'Phase 130 Unraid production switch runbook',
    `Switch readiness: ${packet.switchReadiness}`,
    `Compose override: ${packet.composeOverrideFile}`,
    `Command execution: ${packet.commandExecution ? 'true' : 'false'}`,
    `Service installed: ${packet.serviceInstalled ? 'true' : 'false'}`,
    `Service started: ${packet.serviceStarted ? 'true' : 'false'}`,
    `Production ready: ${packet.productionReady ? 'true' : 'false'}`,
    `Launch approved: ${packet.launchApproved ? 'true' : 'false'}`,
    `Findings: pass=${packet.summary.pass} warn=${packet.summary.warn} fail=${packet.summary.fail} total=${packet.summary.total}`,
    '',
    'Operator checklist:',
    ...packet.operatorChecklist.map((item) => `- ${item}`),
    '',
    'Command plan:',
    `- preflightDoctor: ${packet.commandPlan.preflightDoctor}`,
    `- installOrStartService: ${packet.commandPlan.installOrStartService}`,
    `- postStartDoctor: ${packet.commandPlan.postStartDoctor}`,
    `- rollbackStop: ${packet.commandPlan.rollbackStop}`,
    `- cleanupCheck: ${packet.commandPlan.cleanupCheck}`,
    '',
    'Evidence plan:',
    ...packet.evidencePlan.map((item) => `- ${item}`),
    '',
    ...packet.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidProductionSwitchRunbookHasFailures(packet: UnraidProductionSwitchRunbook): boolean {
  return packet.summary.fail > 0;
}

function fromFindings(findings: readonly UnraidProductionSwitchRunbookFinding[]): UnraidProductionSwitchRunbook {
  const summary = summarize(findings);
  return {
    report: 'phase-130-unraid-production-switch-runbook',
    version: 1,
    purpose: 'prepare-operator-production-switch-runbook-without-mutating-unraid',
    source: 'single-operator-supplied-phase-129-final-human-approval-record-preflight-json-file',
    sourceApprovalPreflight: 'phase-129-unraid-final-human-approval-record-preflight',
    requiredApprovalRecordStatus: 'ready-for-operator-production-switch',
    requiredLiveEvidence: 'unraid-live-operating-test-2026-07-08.redacted.md',
    composeOverrideFile: 'docker-compose.unraid-bind.yml',
    redactionSafe: true,
    recordValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    serviceInstallApproved: true,
    serviceInstalled: false,
    serviceStarted: false,
    productionReady: false,
    launchApproved: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    switchReadiness: summary.fail === 0 ? 'ready-for-explicit-operator-window' : 'not-ready-for-explicit-operator-window',
    operatorChecklist: [
      'Confirm Phase 129 approvalRecordStatus is ready-for-operator-production-switch.',
      'Confirm live Unraid evidence note unraid-live-operating-test-2026-07-08.redacted.md is retained locally.',
      'Confirm deployed compose override is docker-compose.unraid-bind.yml.',
      'Confirm no provider, media server, scraping, downloading, playback, API framework, or UI scope is being opened.',
      'Confirm rollback command is visible before starting any persistent service.',
    ],
    commandPlan: {
      preflightDoctor: 'docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml run --rm ops ops:doctor -- --json',
      installOrStartService: 'operator-run-only: install/start persistent catalog service from approved Unraid service script packet',
      postStartDoctor: 'docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml run --rm ops ops:doctor -- --json',
      rollbackStop: 'operator-run-only: stop and disable persistent catalog service, then run docker compose down --remove-orphans',
      cleanupCheck: 'docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml ps -a',
    },
    evidencePlan: [
      'Record redacted preflight doctor result.',
      'Record exact service install/start command label after the operator runs it.',
      'Record redacted post-start doctor result.',
      'Record rollback/stop evidence if rollback is used.',
      'Do not record secret file contents, DB URLs, passphrases, KEKs, DEKs, raw logs, titles, provider tokens, or backup contents.',
    ],
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidProductionSwitchRunbookFinding[]): UnraidProductionSwitchRunbook['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): UnraidProductionSwitchRunbookFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidProductionSwitchRunbookFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidProductionSwitchRunbookFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidProductionSwitchRunbookFinding {
  return { level: 'warn', code, field, message };
}
