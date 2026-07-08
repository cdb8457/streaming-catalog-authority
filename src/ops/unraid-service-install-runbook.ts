export interface UnraidServiceRunbookStep {
  readonly id: string;
  readonly label: string;
  readonly operatorAction: string;
  readonly rollbackCheckpoint: string;
  readonly evidenceLabel: string;
  readonly status: 'planned' | 'operator-review-required' | 'blocked';
}

export interface UnraidServiceInstallRunbook {
  readonly ok: true;
  readonly report: 'phase-121-unraid-service-install-runbook';
  readonly version: 1;
  readonly code: 'UNRAID_SERVICE_INSTALL_RUNBOOK';
  readonly purpose: 'prepare-reviewed-unraid-service-install-and-rollback-plan-without-mutation';
  readonly sourceReadinessBundle: 'phase-120-unraid-operator-readiness-bundle';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly serviceInstallApproved: false;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly mutatesUnraid: false;
  readonly liveServiceContact: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'closed/authorized';
  readonly o5Status: 'closed/authorized';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly runbookReviewStatus: 'draft-pending-operator-review';
  readonly installBlockedUntil: readonly string[];
  readonly runbookSteps: readonly UnraidServiceRunbookStep[];
  readonly rollbackEvidenceRequired: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

export function buildUnraidServiceInstallRunbook(): UnraidServiceInstallRunbook {
  const runbookSteps: UnraidServiceRunbookStep[] = [
    {
      id: 'preinstall-review',
      label: 'Review redacted readiness bundle and Unraid notes',
      operatorAction: 'human review of redacted evidence labels and host assumptions',
      rollbackCheckpoint: 'no host mutation has occurred',
      evidenceLabel: 'phase-121-preinstall-review-redacted',
      status: 'operator-review-required',
    },
    {
      id: 'layout-plan',
      label: 'Confirm appdata layout and owner-only permissions',
      operatorAction: 'record intended directories, ownership, and permission model without creating them',
      rollbackCheckpoint: 'discard draft layout before any file creation',
      evidenceLabel: 'phase-121-layout-plan-redacted',
      status: 'planned',
    },
    {
      id: 'service-wrapper-plan',
      label: 'Review service wrapper entrypoints and stop behavior',
      operatorAction: 'review planned start, stop, stale-socket, log, and state-retention behavior',
      rollbackCheckpoint: 'service wrapper is not installed and can be revised offline',
      evidenceLabel: 'phase-121-service-wrapper-plan-redacted',
      status: 'planned',
    },
    {
      id: 'rollback-plan',
      label: 'Confirm rollback and evidence capture',
      operatorAction: 'record removal, stop, socket cleanup, state retention, and evidence labels',
      rollbackCheckpoint: 'rollback instructions remain draft-only until operator approval',
      evidenceLabel: 'phase-121-rollback-plan-redacted',
      status: 'operator-review-required',
    },
    {
      id: 'install-approval',
      label: 'Hold before service install approval',
      operatorAction: 'do not install or start service until a future approval packet exists',
      rollbackCheckpoint: 'installation remains blocked',
      evidenceLabel: 'phase-121-install-approval-hold-redacted',
      status: 'blocked',
    },
  ];

  return {
    ok: true,
    report: 'phase-121-unraid-service-install-runbook',
    version: 1,
    code: 'UNRAID_SERVICE_INSTALL_RUNBOOK',
    purpose: 'prepare-reviewed-unraid-service-install-and-rollback-plan-without-mutation',
    sourceReadinessBundle: 'phase-120-unraid-operator-readiness-bundle',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstallApproved: false,
    serviceInstalled: false,
    serviceStarted: false,
    mutatesUnraid: false,
    liveServiceContact: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'closed/authorized',
    o5Status: 'closed/authorized',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    runbookReviewStatus: 'draft-pending-operator-review',
    installBlockedUntil: [
      'operator-approves-service-install-runbook-redacted',
      'rollback-plan-reviewed-redacted',
      'host-specific-secret-placement-reviewed-redacted',
      'service-validation-window-approved-redacted',
    ],
    runbookSteps,
    rollbackEvidenceRequired: [
      'preinstall-state-capture-redacted',
      'service-stop-proof-redacted',
      'stale-socket-cleanup-proof-redacted',
      'state-retention-or-removal-decision-redacted',
      'post-rollback-health-review-redacted',
    ],
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
      'No boot-time modification, scheduler change, provider adapter, media-server workflow, playback, downloading, scraping, API framework, or web UI expansion.',
    ],
  };
}

export function formatUnraidServiceInstallRunbookJson(
  packet: UnraidServiceInstallRunbook = buildUnraidServiceInstallRunbook(),
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatUnraidServiceInstallRunbookText(
  packet: UnraidServiceInstallRunbook = buildUnraidServiceInstallRunbook(),
): string {
  const lines = [
    'Phase 121 Unraid service install runbook',
    `code: ${packet.code}`,
    `sourceReadinessBundle: ${packet.sourceReadinessBundle}`,
    `runbookReviewStatus: ${packet.runbookReviewStatus}`,
    `productionReady: ${packet.productionReady ? 'true' : 'false'}`,
    `serviceInstallApproved: ${packet.serviceInstallApproved ? 'true' : 'false'}`,
    `serviceInstalled: ${packet.serviceInstalled ? 'true' : 'false'}`,
    `serviceStarted: ${packet.serviceStarted ? 'true' : 'false'}`,
    `commandExecution: ${packet.commandExecution ? 'true' : 'false'}`,
    `scriptGenerated: ${packet.scriptGenerated ? 'true' : 'false'}`,
    '',
    'Runbook steps:',
  ];

  for (const step of packet.runbookSteps) {
    lines.push(`- ${step.id}: ${step.status} evidence=${step.evidenceLabel}`);
  }

  lines.push('', 'Install blocked until:');
  for (const blocker of packet.installBlockedUntil) lines.push(`- ${blocker}`);

  lines.push('', 'Rollback evidence required:');
  for (const evidence of packet.rollbackEvidenceRequired) lines.push(`- ${evidence}`);

  lines.push('', 'Explicit non-goals:');
  for (const item of packet.explicitNonGoals) lines.push(`- ${item}`);

  return `${lines.join('\n')}\n`;
}
