export type UnraidProductionSwitchExecutionPacketInputErrorCode =
  | 'PRODUCTION_SWITCH_EXECUTION_INPUT_REQUIRED'
  | 'PRODUCTION_SWITCH_EXECUTION_FILE_READ_FAILED'
  | 'PRODUCTION_SWITCH_EXECUTION_FILE_TOO_LARGE'
  | 'PRODUCTION_SWITCH_EXECUTION_JSON_MALFORMED'
  | 'PRODUCTION_SWITCH_EXECUTION_OBJECT_REQUIRED';

export interface UnraidProductionSwitchExecutionPacketFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidProductionSwitchExecutionPacket {
  readonly report: 'phase-136-unraid-production-switch-execution-packet';
  readonly version: 1;
  readonly purpose: 'prepare-final-operator-production-switch-execution-without-running-it';
  readonly source: 'single-operator-supplied-phase-135-final-launch-approval-record-json-file';
  readonly sourceFinalLaunchApprovalRecord: 'phase-135-unraid-final-launch-approval-record';
  readonly requiredFinalLaunchApprovalStatus: 'ready-for-production-switch-execution-packet';
  readonly redactionSafe: true;
  readonly packetValuesEchoed: false;
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
  readonly launchApproved: true;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly executionPacketStatus: 'ready-for-real-unraid-production-switch' | 'not-ready-for-real-unraid-production-switch';
  readonly commandPlan: {
    readonly preflightDoctor: string;
    readonly startService: string;
    readonly postStartDoctor: string;
    readonly rollbackStop: string;
    readonly finalStatusCheck: string;
  };
  readonly evidencePlan: readonly string[];
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidProductionSwitchExecutionPacketFinding[];
}

export function buildUnraidProductionSwitchExecutionPacket(record: Record<string, unknown>): UnraidProductionSwitchExecutionPacket {
  const findings: UnraidProductionSwitchExecutionPacketFinding[] = [];
  findings.push(...requiredLiteral(record, 'report', 'phase-135-unraid-final-launch-approval-record', 'PHASE_135_APPROVAL_RECORD'));
  findings.push(...requiredLiteral(record, 'finalLaunchApprovalStatus', 'ready-for-production-switch-execution-packet', 'PHASE_135_READY_FOR_EXECUTION_PACKET'));
  findings.push(...requiredLiteral(record, 'sourceLaunchReadinessDecision', 'phase-134-unraid-launch-readiness-decision', 'PHASE_134_SOURCE_DECISION'));
  findings.push(...requiredLiteral(record, 'redactionSafe', true, 'PHASE_135_REDACTION_SAFE'));
  findings.push(...requiredLiteral(record, 'approvalValuesEchoed', false, 'PHASE_135_NO_APPROVAL_VALUES'));
  findings.push(...requiredLiteral(record, 'inputValuesEchoed', false, 'PHASE_135_NO_INPUT_VALUES'));
  findings.push(...requiredLiteral(record, 'commandExecution', false, 'PHASE_135_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(record, 'scriptGenerated', false, 'PHASE_135_NO_SCRIPT'));
  findings.push(...requiredLiteral(record, 'mutatesUnraid', false, 'PHASE_135_NO_MUTATION'));
  findings.push(...requiredLiteral(record, 'providerContactAllowed', false, 'PHASE_135_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(record, 'providerModeEnabled', false, 'PHASE_135_NO_PROVIDER_MODE'));
  findings.push(...requiredLiteral(record, 'serviceInstallApproved', true, 'PHASE_135_SERVICE_INSTALL_APPROVED'));
  findings.push(...requiredLiteral(record, 'serviceInstalled', false, 'PHASE_135_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(record, 'serviceStarted', false, 'PHASE_135_NO_SERVICE_START'));
  findings.push(...requiredLiteral(record, 'productionReady', false, 'PHASE_135_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(record, 'launchApproved', true, 'PHASE_135_LAUNCH_APPROVED'));
  findings.push(...requiredLiteral(record, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));
  findings.push(warn('EXECUTION_PACKET_DOES_NOT_RUN_COMMANDS', 'commandExecution', 'This packet prepares the real switch but does not run commands.'));
  findings.push(warn('REAL_SWITCH_REQUIRES_OPERATOR_ACTION', 'operator', 'The next step is the real Unraid production switch on the server.'));
  return fromFindings(findings);
}

export function buildUnraidProductionSwitchExecutionPacketInputError(code: UnraidProductionSwitchExecutionPacketInputErrorCode): UnraidProductionSwitchExecutionPacket {
  const messages: Record<UnraidProductionSwitchExecutionPacketInputErrorCode, string> = {
    PRODUCTION_SWITCH_EXECUTION_INPUT_REQUIRED: 'One Phase 135 final launch approval record JSON input is required.',
    PRODUCTION_SWITCH_EXECUTION_FILE_READ_FAILED: 'The supplied Phase 135 final launch approval record JSON file could not be read.',
    PRODUCTION_SWITCH_EXECUTION_FILE_TOO_LARGE: 'The supplied Phase 135 final launch approval record JSON file exceeds the input size limit.',
    PRODUCTION_SWITCH_EXECUTION_JSON_MALFORMED: 'The supplied Phase 135 final launch approval record input is not valid JSON.',
    PRODUCTION_SWITCH_EXECUTION_OBJECT_REQUIRED: 'The supplied Phase 135 final launch approval record JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseUnraidProductionSwitchExecutionPacketJson(jsonText: string): Record<string, unknown> | UnraidProductionSwitchExecutionPacketInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'PRODUCTION_SWITCH_EXECUTION_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'PRODUCTION_SWITCH_EXECUTION_JSON_MALFORMED';
  }
}

export function formatUnraidProductionSwitchExecutionPacketJson(packet: UnraidProductionSwitchExecutionPacket): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatUnraidProductionSwitchExecutionPacketText(packet: UnraidProductionSwitchExecutionPacket): string {
  const lines = [
    'Phase 136 Unraid production switch execution packet',
    `Execution packet status: ${packet.executionPacketStatus}`,
    `Launch approved: ${packet.launchApproved ? 'true' : 'false'}`,
    `Production ready: ${packet.productionReady ? 'true' : 'false'}`,
    `Command execution: ${packet.commandExecution ? 'true' : 'false'}`,
    `Service installed: ${packet.serviceInstalled ? 'true' : 'false'}`,
    `Service started: ${packet.serviceStarted ? 'true' : 'false'}`,
    `Findings: pass=${packet.summary.pass} warn=${packet.summary.warn} fail=${packet.summary.fail} total=${packet.summary.total}`,
    '',
    'Command plan:',
    `- preflightDoctor: ${packet.commandPlan.preflightDoctor}`,
    `- startService: ${packet.commandPlan.startService}`,
    `- postStartDoctor: ${packet.commandPlan.postStartDoctor}`,
    `- rollbackStop: ${packet.commandPlan.rollbackStop}`,
    `- finalStatusCheck: ${packet.commandPlan.finalStatusCheck}`,
    '',
    'Evidence plan:',
    ...packet.evidencePlan.map((item) => `- ${item}`),
    '',
    ...packet.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidProductionSwitchExecutionPacketHasFailures(packet: UnraidProductionSwitchExecutionPacket): boolean {
  return packet.summary.fail > 0;
}

function fromFindings(findings: readonly UnraidProductionSwitchExecutionPacketFinding[]): UnraidProductionSwitchExecutionPacket {
  const summary = summarize(findings);
  return {
    report: 'phase-136-unraid-production-switch-execution-packet',
    version: 1,
    purpose: 'prepare-final-operator-production-switch-execution-without-running-it',
    source: 'single-operator-supplied-phase-135-final-launch-approval-record-json-file',
    sourceFinalLaunchApprovalRecord: 'phase-135-unraid-final-launch-approval-record',
    requiredFinalLaunchApprovalStatus: 'ready-for-production-switch-execution-packet',
    redactionSafe: true,
    packetValuesEchoed: false,
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
    launchApproved: true,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    executionPacketStatus: summary.fail === 0
      ? 'ready-for-real-unraid-production-switch'
      : 'not-ready-for-real-unraid-production-switch',
    commandPlan: {
      preflightDoctor: 'docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml run --rm ops ops:doctor -- --json',
      startService: 'operator-run-only: start approved persistent catalog service on Unraid',
      postStartDoctor: 'docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml run --rm ops ops:doctor -- --json',
      rollbackStop: 'operator-run-only: stop persistent catalog service and run docker compose down --remove-orphans',
      finalStatusCheck: 'docker compose -f docker-compose.deploy.yml -f docker-compose.unraid-bind.yml ps -a',
    },
    evidencePlan: [
      'Capture redacted preflight doctor JSON before service start.',
      'Capture the exact operator command label used to start the approved service.',
      'Capture redacted post-start doctor JSON after service start.',
      'Capture final docker compose ps -a output with names/status only.',
      'If rollback is used, capture stop/down status and post-rollback doctor output.',
    ],
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidProductionSwitchExecutionPacketFinding[]): UnraidProductionSwitchExecutionPacket['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(object: Record<string, unknown>, field: string, expected: string | boolean, passCode: string): UnraidProductionSwitchExecutionPacketFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidProductionSwitchExecutionPacketFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidProductionSwitchExecutionPacketFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidProductionSwitchExecutionPacketFinding {
  return { level: 'warn', code, field, message };
}
