export interface UnraidProductionReadinessDecisionReport {
  readonly report: 'phase-127-unraid-production-readiness-decision';
  readonly version: 1;
  readonly sourceValidationReview: 'phase-126-unraid-post-install-validation-review';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly rawDecisionNotesIncluded: false;
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
  readonly productionReadinessDecisionStatus: 'ready-for-final-human-production-approval' | 'not-ready';
  readonly findings: readonly string[];
}

export function buildUnraidProductionReadinessDecisionReport(
  validationReview: Record<string, unknown>,
  decision: Record<string, unknown>,
): UnraidProductionReadinessDecisionReport {
  const checks = [
    validationReview.report === 'phase-126-unraid-post-install-validation-review',
    validationReview.postInstallValidationStatus === 'ready-for-production-readiness-decision',
    validationReview.productionReady === false,
    decision.record === 'phase-127-unraid-production-readiness-decision-record',
    decision.verdict === 'GO',
    decision.scope === 'unraid-foundation-production-readiness-decision-only',
    decision.redactionSafe === true,
    decision.decisionValuesEchoed === false,
    decision.rawDecisionNotesIncluded === false,
    decision.commandExecution === false,
    decision.providerContactAllowed === false,
    decision.productionReady === false,
    decision.launchApproved === false,
  ];
  const ready = checks.every(Boolean);
  return {
    report: 'phase-127-unraid-production-readiness-decision',
    version: 1,
    sourceValidationReview: 'phase-126-unraid-post-install-validation-review',
    redactionSafe: true,
    inputValuesEchoed: false,
    rawDecisionNotesIncluded: false,
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
    productionReadinessDecisionStatus: ready ? 'ready-for-final-human-production-approval' : 'not-ready',
    findings: checks.map((ok, index) => `${ok ? 'PASS' : 'FAIL'}:phase127-check-${index + 1}`),
  };
}

export function sampleUnraidPostInstallValidationReviewReport(): Record<string, unknown> {
  return {
    report: 'phase-126-unraid-post-install-validation-review',
    postInstallValidationStatus: 'ready-for-production-readiness-decision',
    productionReady: false,
  };
}

export function sampleUnraidProductionReadinessDecisionRecord(): Record<string, unknown> {
  return {
    record: 'phase-127-unraid-production-readiness-decision-record',
    verdict: 'GO',
    scope: 'unraid-foundation-production-readiness-decision-only',
    redactionSafe: true,
    decisionValuesEchoed: false,
    rawDecisionNotesIncluded: false,
    commandExecution: false,
    providerContactAllowed: false,
    productionReady: false,
    launchApproved: false,
  };
}

export function formatUnraidProductionReadinessDecisionJson(report: UnraidProductionReadinessDecisionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
