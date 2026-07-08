export interface UnraidSwitchEvidenceCapturePacket {
  readonly ok: true;
  readonly report: 'phase-131-unraid-switch-evidence-capture';
  readonly version: 1;
  readonly purpose: 'define-redacted-evidence-required-after-explicit-operator-production-switch';
  readonly sourceRunbook: 'phase-130-unraid-production-switch-runbook';
  readonly requiredSwitchReadiness: 'ready-for-explicit-operator-window';
  readonly requiredApprovalPreflight: 'phase-129-unraid-final-human-approval-record-preflight';
  readonly requiredLiveEvidence: 'unraid-live-operating-test-2026-07-08.redacted.md';
  readonly composeOverrideFile: 'docker-compose.unraid-bind.yml';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly mutatesUnraid: false;
  readonly serviceInstallApproved: true;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly captureReadiness: 'ready-for-operator-capture-after-switch';
  readonly requiredEvidenceLabels: readonly string[];
  readonly requiredRedactions: readonly string[];
  readonly forbiddenEvidence: readonly string[];
  readonly postSwitchChecks: readonly string[];
}

export function buildUnraidSwitchEvidenceCapturePacket(): UnraidSwitchEvidenceCapturePacket {
  return {
    ok: true,
    report: 'phase-131-unraid-switch-evidence-capture',
    version: 1,
    purpose: 'define-redacted-evidence-required-after-explicit-operator-production-switch',
    sourceRunbook: 'phase-130-unraid-production-switch-runbook',
    requiredSwitchReadiness: 'ready-for-explicit-operator-window',
    requiredApprovalPreflight: 'phase-129-unraid-final-human-approval-record-preflight',
    requiredLiveEvidence: 'unraid-live-operating-test-2026-07-08.redacted.md',
    composeOverrideFile: 'docker-compose.unraid-bind.yml',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    serviceInstallApproved: true,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    captureReadiness: 'ready-for-operator-capture-after-switch',
    requiredEvidenceLabels: [
      'pre-switch-doctor-redacted-json',
      'operator-switch-command-label',
      'service-status-after-switch-label',
      'post-switch-doctor-redacted-json',
      'compose-ps-after-switch-label',
      'rollback-status-label-if-used',
    ],
    requiredRedactions: [
      'secret file contents',
      'database URLs',
      'passphrases',
      'KEKs',
      'DEKs',
      'provider tokens',
      'raw logs',
      'titles',
      'backup contents',
      'raw evidence note bodies',
    ],
    forbiddenEvidence: [
      'No raw secret files.',
      'No database URL values.',
      'No KEK or DEK material.',
      'No provider credentials or provider payloads.',
      'No raw backup artifact contents.',
      'No title or user-content identity values.',
    ],
    postSwitchChecks: [
      'Confirm the persistent service status label is captured after the operator switch.',
      'Run a redacted post-switch doctor check with docker-compose.unraid-bind.yml.',
      'Capture compose ps -a labels without raw secrets.',
      'If rollback is used, capture stop/disable status and cleanup check labels.',
      'Keep productionReady and launchApproved false until a separate reviewed launch disposition.',
    ],
  };
}

export function formatUnraidSwitchEvidenceCaptureJson(
  packet: UnraidSwitchEvidenceCapturePacket = buildUnraidSwitchEvidenceCapturePacket(),
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatUnraidSwitchEvidenceCaptureText(
  packet: UnraidSwitchEvidenceCapturePacket = buildUnraidSwitchEvidenceCapturePacket(),
): string {
  const lines = [
    'Phase 131 Unraid switch evidence capture',
    `sourceRunbook: ${packet.sourceRunbook}`,
    `captureReadiness: ${packet.captureReadiness}`,
    `composeOverrideFile: ${packet.composeOverrideFile}`,
    `commandExecution: ${packet.commandExecution ? 'true' : 'false'}`,
    `serviceInstalled: ${packet.serviceInstalled ? 'true' : 'false'}`,
    `serviceStarted: ${packet.serviceStarted ? 'true' : 'false'}`,
    `productionReady: ${packet.productionReady ? 'true' : 'false'}`,
    `launchApproved: ${packet.launchApproved ? 'true' : 'false'}`,
    '',
    'Required evidence labels:',
    ...packet.requiredEvidenceLabels.map((item) => `- ${item}`),
    '',
    'Post-switch checks:',
    ...packet.postSwitchChecks.map((item) => `- ${item}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}
