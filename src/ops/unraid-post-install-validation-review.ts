export interface UnraidPostInstallValidationReviewReport {
  readonly report: 'phase-126-unraid-post-install-validation-review';
  readonly version: 1;
  readonly sourceEvidenceGate: 'phase-125-unraid-install-evidence-capture-gate';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly rawReviewerNotesIncluded: false;
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
  readonly postInstallValidationStatus: 'ready-for-production-readiness-decision' | 'not-ready';
  readonly findings: readonly string[];
}

export function buildUnraidPostInstallValidationReviewReport(
  evidenceGate: Record<string, unknown>,
  review: Record<string, unknown>,
): UnraidPostInstallValidationReviewReport {
  const checks = [
    evidenceGate.report === 'phase-125-unraid-install-evidence-capture-gate',
    evidenceGate.installEvidenceStatus === 'complete-ready-for-post-install-review',
    evidenceGate.productionReady === false,
    review.record === 'phase-126-unraid-post-install-validation-review-record',
    review.verdict === 'GO',
    review.scope === 'post-install-validation-review-only',
    review.redactionSafe === true,
    review.reviewValuesEchoed === false,
    review.rawReviewerNotesIncluded === false,
    review.commandExecution === false,
    review.providerContactAllowed === false,
    review.productionReady === false,
  ];
  const ready = checks.every(Boolean);
  return {
    report: 'phase-126-unraid-post-install-validation-review',
    version: 1,
    sourceEvidenceGate: 'phase-125-unraid-install-evidence-capture-gate',
    redactionSafe: true,
    inputValuesEchoed: false,
    rawReviewerNotesIncluded: false,
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
    postInstallValidationStatus: ready ? 'ready-for-production-readiness-decision' : 'not-ready',
    findings: checks.map((ok, index) => `${ok ? 'PASS' : 'FAIL'}:phase126-check-${index + 1}`),
  };
}

export function sampleUnraidInstallEvidenceCaptureGateReport(): Record<string, unknown> {
  return {
    report: 'phase-125-unraid-install-evidence-capture-gate',
    installEvidenceStatus: 'complete-ready-for-post-install-review',
    productionReady: false,
  };
}

export function sampleUnraidPostInstallValidationReviewRecord(): Record<string, unknown> {
  return {
    record: 'phase-126-unraid-post-install-validation-review-record',
    verdict: 'GO',
    scope: 'post-install-validation-review-only',
    redactionSafe: true,
    reviewValuesEchoed: false,
    rawReviewerNotesIncluded: false,
    commandExecution: false,
    providerContactAllowed: false,
    productionReady: false,
  };
}

export function formatUnraidPostInstallValidationReviewJson(report: UnraidPostInstallValidationReviewReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
