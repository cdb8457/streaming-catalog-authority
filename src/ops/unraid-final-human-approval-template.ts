export interface UnraidFinalHumanApprovalTemplate {
  readonly ok: true;
  readonly report: 'phase-128-unraid-final-human-approval-template';
  readonly version: 1;
  readonly code: 'UNRAID_FINAL_HUMAN_APPROVAL_TEMPLATE';
  readonly purpose: 'prepare-explicit-human-production-approval-record-without-approving-production';
  readonly sourceProductionReadinessDecision: 'phase-127-unraid-production-readiness-decision';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly serviceInstallApproved: true;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly mutatesUnraid: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly finalHumanApprovalStatus: 'awaiting-explicit-human-approval';
  readonly requiredApprovalRecord: {
    readonly record: 'phase-128-unraid-final-human-production-approval-record';
    readonly requiredVerdict: 'GO';
    readonly requiredScope: 'unraid-foundation-final-human-production-approval-only';
    readonly requiredRedactionSafe: true;
    readonly mustExcludeRawNotes: true;
  };
  readonly explicitNonGoals: readonly string[];
}

export function buildUnraidFinalHumanApprovalTemplate(): UnraidFinalHumanApprovalTemplate {
  return {
    ok: true,
    report: 'phase-128-unraid-final-human-approval-template',
    version: 1,
    code: 'UNRAID_FINAL_HUMAN_APPROVAL_TEMPLATE',
    purpose: 'prepare-explicit-human-production-approval-record-without-approving-production',
    sourceProductionReadinessDecision: 'phase-127-unraid-production-readiness-decision',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstallApproved: true,
    serviceInstalled: false,
    serviceStarted: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    finalHumanApprovalStatus: 'awaiting-explicit-human-approval',
    requiredApprovalRecord: {
      record: 'phase-128-unraid-final-human-production-approval-record',
      requiredVerdict: 'GO',
      requiredScope: 'unraid-foundation-final-human-production-approval-only',
      requiredRedactionSafe: true,
      mustExcludeRawNotes: true,
    },
    explicitNonGoals: [
      'No production readiness approval.',
      'No launch approval.',
      'No Unraid mutation.',
      'No service installation.',
      'No service start.',
      'No command execution.',
      'No generated shell script.',
      'No live service contact.',
      'No provider mode.',
      'No KEK material inspection.',
      'No provider adapter, media-server workflow, playback, downloading, scraping, API framework, or web UI expansion.',
    ],
  };
}

export function formatUnraidFinalHumanApprovalTemplateJson(
  packet: UnraidFinalHumanApprovalTemplate = buildUnraidFinalHumanApprovalTemplate(),
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatUnraidFinalHumanApprovalTemplateText(
  packet: UnraidFinalHumanApprovalTemplate = buildUnraidFinalHumanApprovalTemplate(),
): string {
  const lines = [
    'Phase 128 Unraid final human approval template',
    `code: ${packet.code}`,
    `sourceProductionReadinessDecision: ${packet.sourceProductionReadinessDecision}`,
    `finalHumanApprovalStatus: ${packet.finalHumanApprovalStatus}`,
    `productionReady: ${packet.productionReady ? 'true' : 'false'}`,
    `launchApproved: ${packet.launchApproved ? 'true' : 'false'}`,
    `commandExecution: ${packet.commandExecution ? 'true' : 'false'}`,
    '',
    'Required approval record:',
    `- record: ${packet.requiredApprovalRecord.record}`,
    `- verdict: ${packet.requiredApprovalRecord.requiredVerdict}`,
    `- scope: ${packet.requiredApprovalRecord.requiredScope}`,
    '',
    'Explicit non-goals:',
  ];
  for (const item of packet.explicitNonGoals) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}
