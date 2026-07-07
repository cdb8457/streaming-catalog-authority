export interface SidecarUnraidProductionGateBlocker {
  readonly id: string;
  readonly gate: 'O4' | 'O5' | 'Unraid-service' | 'independent-review';
  readonly status: 'blocked';
  readonly requiredEvidenceLabel: string;
  readonly blockerReason: string;
}

export interface SidecarUnraidProductionGateBlockersPacket {
  readonly ok: true;
  readonly report: 'phase-112-sidecar-unraid-production-gate-blockers';
  readonly version: 1;
  readonly code: 'SIDECAR_UNRAID_PRODUCTION_GATE_BLOCKERS';
  readonly purpose: 'enumerate-unresolved-production-gate-blockers-after-sidecar-unraid-review-handoff';
  readonly sourceHandoff: 'phase-111-sidecar-unraid-review-handoff';
  readonly redactionSafe: true;
  readonly commandExecution: false;
  readonly inputValuesEchoed: false;
  readonly serviceInstallApproved: false;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly providerModeEnabled: false;
  readonly liveServiceContact: false;
  readonly providerContactAllowed: false;
  readonly tcpListenerAllowed: false;
  readonly httpApiAllowed: false;
  readonly lanExposureAllowed: false;
  readonly reverseProxyAllowed: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly blockers: readonly SidecarUnraidProductionGateBlocker[];
  readonly requiredNextEvidenceLabels: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

export function buildSidecarUnraidProductionGateBlockersPacket(): SidecarUnraidProductionGateBlockersPacket {
  const blockers: SidecarUnraidProductionGateBlocker[] = [
    {
      id: 'o4-managed-custodian-boundary',
      gate: 'O4',
      status: 'blocked',
      requiredEvidenceLabel: 'managed-custodian-sidecar-boundary-attestation-redacted',
      blockerReason: 'O4 still requires external/managed custodian boundary evidence beyond FileCustodian reference-harness behavior.',
    },
    {
      id: 'o4-independent-review-verdict',
      gate: 'independent-review',
      status: 'blocked',
      requiredEvidenceLabel: 'independent-reviewer-go-for-sidecar-custodian-redacted',
      blockerReason: 'Phase 111 only prepared a handoff; an independent reviewer verdict is not recorded here.',
    },
    {
      id: 'o5-managed-kek-custody',
      gate: 'O5',
      status: 'blocked',
      requiredEvidenceLabel: 'managed-kek-custody-and-rotation-attestation-redacted',
      blockerReason: 'O5 still requires managed KEK custody, rotation, and recovery evidence outside the local reference harness.',
    },
    {
      id: 'unraid-service-live-validation',
      gate: 'Unraid-service',
      status: 'blocked',
      requiredEvidenceLabel: 'operator-run-unraid-sidecar-service-validation-redacted',
      blockerReason: 'No packet in this chain installs, starts, or live-validates an Unraid service.',
    },
  ];

  return {
    ok: true,
    report: 'phase-112-sidecar-unraid-production-gate-blockers',
    version: 1,
    code: 'SIDECAR_UNRAID_PRODUCTION_GATE_BLOCKERS',
    purpose: 'enumerate-unresolved-production-gate-blockers-after-sidecar-unraid-review-handoff',
    sourceHandoff: 'phase-111-sidecar-unraid-review-handoff',
    redactionSafe: true,
    commandExecution: false,
    inputValuesEchoed: false,
    serviceInstallApproved: false,
    serviceInstalled: false,
    serviceStarted: false,
    productionReady: false,
    launchApproved: false,
    providerModeEnabled: false,
    liveServiceContact: false,
    providerContactAllowed: false,
    tcpListenerAllowed: false,
    httpApiAllowed: false,
    lanExposureAllowed: false,
    reverseProxyAllowed: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    blockers,
    requiredNextEvidenceLabels: blockers.map((blocker) => blocker.requiredEvidenceLabel),
    explicitNonGoals: [
      'No production readiness approval.',
      'No launch approval.',
      'No service install approval.',
      'No Unraid mutation.',
      'No O4 closure.',
      'No O5 closure.',
      'No provider mode.',
      'No network calls or live service contact.',
      'No Docker, Compose, boot script, scheduler, provider adapter, media-server workflow, playback, downloading, scraping, API framework, or web UI expansion.',
    ],
  };
}

export function formatSidecarUnraidProductionGateBlockersJson(
  packet: SidecarUnraidProductionGateBlockersPacket = buildSidecarUnraidProductionGateBlockersPacket(),
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatSidecarUnraidProductionGateBlockersText(
  packet: SidecarUnraidProductionGateBlockersPacket = buildSidecarUnraidProductionGateBlockersPacket(),
): string {
  const lines = [
    'Phase 112 sidecar Unraid production gate blockers',
    `code: ${packet.code}`,
    `sourceHandoff: ${packet.sourceHandoff}`,
    `productionReady: ${packet.productionReady ? 'true' : 'false'}`,
    `serviceInstallApproved: ${packet.serviceInstallApproved ? 'true' : 'false'}`,
    `providerModeEnabled: ${packet.providerModeEnabled ? 'true' : 'false'}`,
    `commandExecution: ${packet.commandExecution ? 'true' : 'false'}`,
    `closesO4: ${packet.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${packet.closesO5 ? 'true' : 'false'}`,
    `O4 status: ${packet.o4Status}`,
    `O5 status: ${packet.o5Status}`,
    '',
    'Blockers:',
  ];

  for (const blocker of packet.blockers) {
    lines.push(`- ${blocker.id}: gate=${blocker.gate} status=${blocker.status} evidence=${blocker.requiredEvidenceLabel}`);
  }

  lines.push('', 'Explicit non-goals:');
  for (const item of packet.explicitNonGoals) lines.push(`- ${item}`);

  return `${lines.join('\n')}\n`;
}
