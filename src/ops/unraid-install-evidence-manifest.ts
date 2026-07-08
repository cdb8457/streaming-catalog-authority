export interface UnraidInstallEvidenceItem {
  readonly id: string;
  readonly label: string;
  readonly requiredFor: 'install-result' | 'rollback-readiness' | 'post-install-review';
  readonly status: 'required';
  readonly redacted: true;
}

export interface UnraidInstallEvidenceManifest {
  readonly ok: true;
  readonly report: 'phase-124-unraid-install-evidence-manifest';
  readonly version: 1;
  readonly code: 'UNRAID_INSTALL_EVIDENCE_MANIFEST';
  readonly purpose: 'define-redacted-evidence-required-after-authorized-operator-install-window';
  readonly sourceInstallAuthorization: 'phase-123-unraid-service-install-authorization';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly serviceInstallApproved: true;
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
  readonly evidenceManifestStatus: 'ready-for-operator-capture';
  readonly evidenceItems: readonly UnraidInstallEvidenceItem[];
  readonly acceptanceChecks: readonly string[];
  readonly remainingReviewGates: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

export function buildUnraidInstallEvidenceManifest(): UnraidInstallEvidenceManifest {
  const evidenceItems: UnraidInstallEvidenceItem[] = [
    {
      id: 'preinstall-state-capture',
      label: 'preinstall-state-capture-redacted',
      requiredFor: 'install-result',
      status: 'required',
      redacted: true,
    },
    {
      id: 'install-window-result',
      label: 'operator-run-install-window-evidence-redacted',
      requiredFor: 'install-result',
      status: 'required',
      redacted: true,
    },
    {
      id: 'service-install-result',
      label: 'service-install-result-redacted',
      requiredFor: 'install-result',
      status: 'required',
      redacted: true,
    },
    {
      id: 'rollback-readiness',
      label: 'rollback-readiness-confirmation-redacted',
      requiredFor: 'rollback-readiness',
      status: 'required',
      redacted: true,
    },
    {
      id: 'post-install-validation-plan',
      label: 'post-install-validation-plan-redacted',
      requiredFor: 'post-install-review',
      status: 'required',
      redacted: true,
    },
  ];

  return {
    ok: true,
    report: 'phase-124-unraid-install-evidence-manifest',
    version: 1,
    code: 'UNRAID_INSTALL_EVIDENCE_MANIFEST',
    purpose: 'define-redacted-evidence-required-after-authorized-operator-install-window',
    sourceInstallAuthorization: 'phase-123-unraid-service-install-authorization',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstallApproved: true,
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
    evidenceManifestStatus: 'ready-for-operator-capture',
    evidenceItems,
    acceptanceChecks: [
      'Captured evidence uses redacted labels only.',
      'No secret values, KEK material, host-specific tokens, private media titles, provider refs, or full paths are included.',
      'Install result distinguishes installed/not-installed without embedding command output.',
      'Rollback readiness is captured before any post-install validation is accepted.',
      'Post-install validation remains a future review input and does not approve production readiness.',
    ],
    remainingReviewGates: [
      'operator-install-evidence-capture-redacted',
      'post-install-validation-review-redacted',
      'rollback-rehearsal-or-rollback-readiness-review-redacted',
      'production-readiness-decision-redacted',
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
      'No provider adapter, media-server workflow, playback, downloading, scraping, API framework, or web UI expansion.',
    ],
  };
}

export function formatUnraidInstallEvidenceManifestJson(
  packet: UnraidInstallEvidenceManifest = buildUnraidInstallEvidenceManifest(),
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatUnraidInstallEvidenceManifestText(
  packet: UnraidInstallEvidenceManifest = buildUnraidInstallEvidenceManifest(),
): string {
  const lines = [
    'Phase 124 Unraid install evidence manifest',
    `code: ${packet.code}`,
    `sourceInstallAuthorization: ${packet.sourceInstallAuthorization}`,
    `evidenceManifestStatus: ${packet.evidenceManifestStatus}`,
    `serviceInstallApproved: ${packet.serviceInstallApproved ? 'true' : 'false'}`,
    `serviceInstalled: ${packet.serviceInstalled ? 'true' : 'false'}`,
    `serviceStarted: ${packet.serviceStarted ? 'true' : 'false'}`,
    `productionReady: ${packet.productionReady ? 'true' : 'false'}`,
    `commandExecution: ${packet.commandExecution ? 'true' : 'false'}`,
    '',
    'Evidence items:',
  ];

  for (const item of packet.evidenceItems) {
    lines.push(`- ${item.id}: ${item.label} requiredFor=${item.requiredFor}`);
  }

  lines.push('', 'Remaining review gates:');
  for (const gate of packet.remainingReviewGates) lines.push(`- ${gate}`);

  lines.push('', 'Explicit non-goals:');
  for (const item of packet.explicitNonGoals) lines.push(`- ${item}`);

  return `${lines.join('\n')}\n`;
}
