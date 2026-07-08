export interface UnraidInstallEvidenceCaptureReport {
  readonly report: 'phase-125-unraid-install-evidence-capture-gate';
  readonly version: 1;
  readonly sourceManifest: 'phase-124-unraid-install-evidence-manifest';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly rawCommandOutputIncluded: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly serviceInstallApproved: true;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly operatorReportedServiceInstalled: boolean;
  readonly operatorReportedServiceStarted: boolean;
  readonly mutatesUnraid: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly installEvidenceStatus: 'complete-ready-for-post-install-review' | 'not-ready';
  readonly missingEvidenceLabels: readonly string[];
  readonly findings: readonly string[];
}

const REQUIRED_LABELS = [
  'preinstall-state-capture-redacted',
  'operator-run-install-window-evidence-redacted',
  'service-install-result-redacted',
  'rollback-readiness-confirmation-redacted',
  'post-install-validation-plan-redacted',
] as const;

export function buildUnraidInstallEvidenceCaptureReport(
  manifest: Record<string, unknown>,
  evidence: Record<string, unknown>,
): UnraidInstallEvidenceCaptureReport {
  const labels = Array.isArray(evidence.capturedEvidenceLabels)
    ? evidence.capturedEvidenceLabels.filter((label): label is string => typeof label === 'string')
    : [];
  const missingEvidenceLabels = REQUIRED_LABELS.filter((label) => !labels.includes(label));
  const findings: string[] = [];
  const checks = [
    manifest.report === 'phase-124-unraid-install-evidence-manifest',
    manifest.evidenceManifestStatus === 'ready-for-operator-capture',
    manifest.serviceInstallApproved === true,
    manifest.commandExecution === false,
    manifest.serviceInstalled === false,
    manifest.serviceStarted === false,
    manifest.productionReady === false,
    evidence.record === 'phase-125-unraid-install-evidence-capture-record',
    evidence.redactionSafe === true,
    evidence.evidenceValuesEchoed === false,
    evidence.rawCommandOutputIncluded === false,
    evidence.commandExecution === false,
    evidence.providerContactAllowed === false,
    evidence.productionReady === false,
    missingEvidenceLabels.length === 0,
  ];
  checks.forEach((ok, index) => findings.push(`${ok ? 'PASS' : 'FAIL'}:phase125-check-${index + 1}`));
  const ready = checks.every(Boolean);
  return {
    report: 'phase-125-unraid-install-evidence-capture-gate',
    version: 1,
    sourceManifest: 'phase-124-unraid-install-evidence-manifest',
    redactionSafe: true,
    inputValuesEchoed: false,
    rawCommandOutputIncluded: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstallApproved: true,
    serviceInstalled: false,
    serviceStarted: false,
    operatorReportedServiceInstalled: evidence.operatorReportedServiceInstalled === true,
    operatorReportedServiceStarted: evidence.operatorReportedServiceStarted === true,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    installEvidenceStatus: ready ? 'complete-ready-for-post-install-review' : 'not-ready',
    missingEvidenceLabels,
    findings,
  };
}

export function sampleUnraidInstallEvidenceManifestForCapture(): Record<string, unknown> {
  return {
    report: 'phase-124-unraid-install-evidence-manifest',
    evidenceManifestStatus: 'ready-for-operator-capture',
    serviceInstallApproved: true,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    productionReady: false,
  };
}

export function sampleUnraidInstallEvidenceCaptureRecord(): Record<string, unknown> {
  return {
    record: 'phase-125-unraid-install-evidence-capture-record',
    redactionSafe: true,
    evidenceValuesEchoed: false,
    rawCommandOutputIncluded: false,
    commandExecution: false,
    providerContactAllowed: false,
    productionReady: false,
    operatorReportedServiceInstalled: true,
    operatorReportedServiceStarted: true,
    capturedEvidenceLabels: [...REQUIRED_LABELS],
  };
}

export function formatUnraidInstallEvidenceCaptureJson(report: UnraidInstallEvidenceCaptureReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
