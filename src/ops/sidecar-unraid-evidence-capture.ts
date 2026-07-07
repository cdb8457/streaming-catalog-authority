export type SidecarUnraidEvidenceCaptureStatus = 'captured' | 'missing' | 'failed';

export interface SidecarUnraidEvidenceBundle {
  readonly report?: string;
  readonly version?: number;
  readonly redactionSafe?: boolean;
  readonly source?: string;
  readonly valuesEchoed?: boolean;
  readonly commandExecutionByReviewGate?: boolean;
  readonly operatorRunLabel?: string;
  readonly setupPermissions?: SidecarUnraidEvidenceCaptureStatus;
  readonly localSocketHealth?: SidecarUnraidEvidenceCaptureStatus;
  readonly restartPersistence?: SidecarUnraidEvidenceCaptureStatus;
  readonly restoreMismatchFailClosed?: SidecarUnraidEvidenceCaptureStatus;
  readonly logRedaction?: SidecarUnraidEvidenceCaptureStatus;
  readonly tcpListenerObserved?: boolean;
  readonly httpApiObserved?: boolean;
  readonly lanExposureObserved?: boolean;
  readonly reverseProxyObserved?: boolean;
  readonly providerContactObserved?: boolean;
  readonly serviceInstalledByPacket?: boolean;
  readonly closesO4?: boolean;
  readonly closesO5?: boolean;
}

export interface SidecarUnraidEvidenceCapturePacket {
  readonly ok: true;
  readonly code: 'SIDECAR_UNRAID_EVIDENCE_CAPTURE_PACKET';
  readonly report: 'phase-107-sidecar-unraid-evidence-capture-packet';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'define-redacted-unraid-sidecar-operator-evidence-bundle';
  readonly commandExecution: false;
  readonly evidenceValuesEchoed: false;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly reviewGateInput: 'single-redacted-sidecar-unraid-evidence-json-file';
  readonly requiredEvidenceFields: readonly (keyof SidecarUnraidEvidenceBundle)[];
  readonly expectedBundleTemplate: SidecarUnraidEvidenceBundle;
  readonly forbiddenEvidenceValues: readonly string[];
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
}

const REQUIRED_EVIDENCE_FIELDS = [
  'operatorRunLabel',
  'setupPermissions',
  'localSocketHealth',
  'restartPersistence',
  'restoreMismatchFailClosed',
  'logRedaction',
  'tcpListenerObserved',
  'httpApiObserved',
  'lanExposureObserved',
  'reverseProxyObserved',
  'providerContactObserved',
  'serviceInstalledByPacket',
  'closesO4',
  'closesO5',
] as const satisfies readonly (keyof SidecarUnraidEvidenceBundle)[];

const FORBIDDEN_EVIDENCE_VALUES = [
  'raw key material',
  'raw completion secret',
  'KEK value',
  'database URL',
  'secret file path',
  'socket path containing host-specific secrets',
  'provider reference',
  'media title',
  'Jellyfin or Plex token',
  'live service response body',
  'backup archive contents',
  'raw log lines',
] as const;

export function buildSidecarUnraidEvidenceCapturePacket(): SidecarUnraidEvidenceCapturePacket {
  return {
    ok: true,
    code: 'SIDECAR_UNRAID_EVIDENCE_CAPTURE_PACKET',
    report: 'phase-107-sidecar-unraid-evidence-capture-packet',
    version: 1,
    redactionSafe: true,
    purpose: 'define-redacted-unraid-sidecar-operator-evidence-bundle',
    commandExecution: false,
    evidenceValuesEchoed: false,
    serviceInstalled: false,
    serviceStarted: false,
    reviewGateInput: 'single-redacted-sidecar-unraid-evidence-json-file',
    requiredEvidenceFields: [...REQUIRED_EVIDENCE_FIELDS],
    expectedBundleTemplate: completeSidecarUnraidEvidenceBundleTemplate(),
    forbiddenEvidenceValues: [...FORBIDDEN_EVIDENCE_VALUES],
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
  };
}

export function completeSidecarUnraidEvidenceBundleTemplate(): SidecarUnraidEvidenceBundle {
  return {
    report: 'phase-107-sidecar-unraid-operator-evidence-bundle',
    version: 1,
    redactionSafe: true,
    source: 'operator-run-redacted-unraid-sidecar-evidence',
    valuesEchoed: false,
    commandExecutionByReviewGate: false,
    operatorRunLabel: 'phase-107-operator-run-redacted',
    setupPermissions: 'captured',
    localSocketHealth: 'captured',
    restartPersistence: 'captured',
    restoreMismatchFailClosed: 'captured',
    logRedaction: 'captured',
    tcpListenerObserved: false,
    httpApiObserved: false,
    lanExposureObserved: false,
    reverseProxyObserved: false,
    providerContactObserved: false,
    serviceInstalledByPacket: false,
    closesO4: false,
    closesO5: false,
  };
}

export function formatSidecarUnraidEvidenceCapturePacketText(packet: SidecarUnraidEvidenceCapturePacket = buildSidecarUnraidEvidenceCapturePacket()): string {
  const lines = [
    'Phase 107 Sidecar Unraid Evidence Capture Packet',
    `code: ${packet.code}`,
    `report: ${packet.report}`,
    `redactionSafe: ${packet.redactionSafe ? 'true' : 'false'}`,
    `commandExecution: ${packet.commandExecution ? 'true' : 'false'}`,
    `evidenceValuesEchoed: ${packet.evidenceValuesEchoed ? 'true' : 'false'}`,
    `serviceInstalled: ${packet.serviceInstalled ? 'true' : 'false'}`,
    `serviceStarted: ${packet.serviceStarted ? 'true' : 'false'}`,
    `reviewGateInput: ${packet.reviewGateInput}`,
    `closesO4: ${packet.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${packet.closesO5 ? 'true' : 'false'}`,
    `O4 status: ${packet.o4Status}`,
    `O5 status: ${packet.o5Status}`,
    `FileCustodian: ${packet.fileCustodianStatus}`,
    '',
    'Required evidence fields:',
  ];
  for (const field of packet.requiredEvidenceFields) lines.push(`- ${field}`);
  lines.push('', 'Forbidden evidence values:');
  for (const value of packet.forbiddenEvidenceValues) lines.push(`- ${value}`);
  return `${lines.join('\n')}\n`;
}
