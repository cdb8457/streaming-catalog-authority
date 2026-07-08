export interface UnraidOperatorBundleItem {
  readonly id: string;
  readonly label: string;
  readonly sourcePhase: string;
  readonly requiredFor: 'operator-review' | 'deployment-planning' | 'production-gate';
  readonly status: 'included' | 'reference-only' | 'operator-provided';
  readonly redacted: boolean;
}

export interface UnraidOperatorReadinessBundle {
  readonly ok: true;
  readonly report: 'phase-120-unraid-operator-readiness-bundle';
  readonly version: 1;
  readonly code: 'UNRAID_OPERATOR_READINESS_BUNDLE';
  readonly purpose: 'summarize-closed-o4-o5-evidence-for-unraid-deployment-planning';
  readonly sourceO4Authorization: 'phase-116-sidecar-unraid-o4-final-authorization';
  readonly sourceO5Authorization: 'phase-119-o5-kek-final-authorization';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly serviceInstallApproved: false;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
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
  readonly bundleItems: readonly UnraidOperatorBundleItem[];
  readonly operatorNextSteps: readonly string[];
  readonly remainingProductionGates: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

export function buildUnraidOperatorReadinessBundle(): UnraidOperatorReadinessBundle {
  const bundleItems: UnraidOperatorBundleItem[] = [
    {
      id: 'o4-final-authorization',
      label: 'O4 managed sidecar custodian boundary authorization',
      sourcePhase: 'phase-116-sidecar-unraid-o4-final-authorization',
      requiredFor: 'deployment-planning',
      status: 'included',
      redacted: true,
    },
    {
      id: 'o5-final-authorization',
      label: 'O5 managed KEK custody authorization',
      sourcePhase: 'phase-119-o5-kek-final-authorization',
      requiredFor: 'deployment-planning',
      status: 'included',
      redacted: true,
    },
    {
      id: 'unraid-readonly-inspection-notes',
      label: 'Redacted Unraid read-only inspection notes',
      sourcePhase: 'operator-supplied-redacted-notes',
      requiredFor: 'operator-review',
      status: 'operator-provided',
      redacted: true,
    },
    {
      id: 'service-install-runbook',
      label: 'Future Unraid service install and rollback runbook',
      sourcePhase: 'future-phase',
      requiredFor: 'production-gate',
      status: 'reference-only',
      redacted: true,
    },
  ];

  return {
    ok: true,
    report: 'phase-120-unraid-operator-readiness-bundle',
    version: 1,
    code: 'UNRAID_OPERATOR_READINESS_BUNDLE',
    purpose: 'summarize-closed-o4-o5-evidence-for-unraid-deployment-planning',
    sourceO4Authorization: 'phase-116-sidecar-unraid-o4-final-authorization',
    sourceO5Authorization: 'phase-119-o5-kek-final-authorization',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    serviceInstallApproved: false,
    serviceInstalled: false,
    serviceStarted: false,
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
    bundleItems,
    operatorNextSteps: [
      'Confirm the redacted Unraid notes are sufficient for a human deployment plan review.',
      'Prepare a future service-install runbook with rollback and evidence capture before any service mutation.',
      'Keep provider, media-server, HTTP API, and playback work out of the Unraid foundation bundle.',
    ],
    remainingProductionGates: [
      'operator-approved-service-install-runbook-redacted',
      'operator-run-unraid-service-validation-redacted',
      'rollback-rehearsal-and-evidence-capture-redacted',
      'managed-custodian-production-adapter-selection-redacted',
    ],
    explicitNonGoals: [
      'No production readiness approval.',
      'No launch approval.',
      'No Unraid mutation.',
      'No service installation.',
      'No service start.',
      'No command execution.',
      'No live service contact.',
      'No provider mode.',
      'No KEK material inspection.',
      'No Docker, Compose, boot script, scheduler, provider adapter, media-server workflow, playback, downloading, scraping, API framework, or web UI expansion.',
    ],
  };
}

export function formatUnraidOperatorReadinessBundleJson(
  packet: UnraidOperatorReadinessBundle = buildUnraidOperatorReadinessBundle(),
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatUnraidOperatorReadinessBundleText(
  packet: UnraidOperatorReadinessBundle = buildUnraidOperatorReadinessBundle(),
): string {
  const lines = [
    'Phase 120 Unraid operator readiness bundle',
    `code: ${packet.code}`,
    `sourceO4Authorization: ${packet.sourceO4Authorization}`,
    `sourceO5Authorization: ${packet.sourceO5Authorization}`,
    `O4 status: ${packet.o4Status}`,
    `O5 status: ${packet.o5Status}`,
    `productionReady: ${packet.productionReady ? 'true' : 'false'}`,
    `serviceInstallApproved: ${packet.serviceInstallApproved ? 'true' : 'false'}`,
    `commandExecution: ${packet.commandExecution ? 'true' : 'false'}`,
    '',
    'Bundle items:',
  ];

  for (const item of packet.bundleItems) {
    lines.push(`- ${item.id}: ${item.status} source=${item.sourcePhase} redacted=${item.redacted ? 'true' : 'false'}`);
  }

  lines.push('', 'Remaining production gates:');
  for (const gate of packet.remainingProductionGates) lines.push(`- ${gate}`);

  lines.push('', 'Explicit non-goals:');
  for (const item of packet.explicitNonGoals) lines.push(`- ${item}`);

  return `${lines.join('\n')}\n`;
}
