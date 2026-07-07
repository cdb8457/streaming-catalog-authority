export type OperatorValidationRunSheetReport = 'phase-94-operator-validation-run-sheet';
export type OperatorValidationRunSheetCode = 'OPERATOR_VALIDATION_RUN_SHEET_RECORDED';
export type OperatorValidationRunSheetStatus = 'ready-for-operator-validation';

export interface OperatorValidationStep {
  readonly id: string;
  readonly label: string;
  readonly commandShape: string;
  readonly evidenceLabel: string;
  readonly retain: readonly string[];
  readonly neverRetain: readonly string[];
  readonly requiredForSemiLaunchGo: true;
}

export interface OperatorValidationRunSheet {
  readonly ok: true;
  readonly report: OperatorValidationRunSheetReport;
  readonly version: 1;
  readonly code: OperatorValidationRunSheetCode;
  readonly status: OperatorValidationRunSheetStatus;
  readonly launchCandidateTagLabel: 'launch-candidate-1';
  readonly sourceValidationPacket: 'phase-93-semi-launch-validation-packet';
  readonly operatorActionRequired: true;
  readonly semiLaunchCandidateGo: false;
  readonly operatorEvidenceCollected: false;
  readonly independentReviewRequired: true;
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly releaseCandidateApproved: false;
  readonly releaseApproved: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly allowedClaim: 'operator validation run sheet ready; semi-launch GO awaits retained evidence';
  readonly forbiddenClaim: 'operator validation complete';
  readonly runOrder: readonly OperatorValidationStep[];
  readonly refChecks: readonly string[];
  readonly reviewerHandoffLabels: readonly string[];
  readonly holdTriggers: readonly string[];
  readonly forbiddenMaterial: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

const NEVER_RETAIN_COMMON = [
  'secret values',
  'credential contents',
  'credential paths',
  'API keys or tokens',
  'KEKs, DEKs, wrapping keys, private keys, or completion secrets',
  'database URLs',
  'raw environment dumps',
  'request or response bodies',
  'provider payloads',
  'raw provider refs',
  'infohashes or magnet links',
  'media titles or user library identity',
  'server URLs',
  'backup contents',
  'artifact contents',
  'raw logs',
  'patch contents',
  'actual evidence values beyond fixed labels, counts, statuses, and timestamps',
] as const;

export const OPERATOR_VALIDATION_RUN_SHEET: OperatorValidationRunSheet = {
  ok: true,
  report: 'phase-94-operator-validation-run-sheet',
  version: 1,
  code: 'OPERATOR_VALIDATION_RUN_SHEET_RECORDED',
  status: 'ready-for-operator-validation',
  launchCandidateTagLabel: 'launch-candidate-1',
  sourceValidationPacket: 'phase-93-semi-launch-validation-packet',
  operatorActionRequired: true,
  semiLaunchCandidateGo: false,
  operatorEvidenceCollected: false,
  independentReviewRequired: true,
  launchApproved: false,
  productionReady: false,
  releaseCandidateApproved: false,
  releaseApproved: false,
  closesO4: false,
  closesO5: false,
  allowedClaim: 'operator validation run sheet ready; semi-launch GO awaits retained evidence',
  forbiddenClaim: 'operator validation complete',
  runOrder: [
    {
      id: 'ref-check',
      label: 'Verify launch-candidate refs',
      commandShape: 'git fetch --prune origin && git rev-parse master origin/master phase-92 launch-candidate-1',
      evidenceLabel: 'ref-alignment-result-label',
      retain: ['commit equality status', 'tag names checked', 'timestamp'],
      neverRetain: [...NEVER_RETAIN_COMMON],
      requiredForSemiLaunchGo: true,
    },
    {
      id: 'clean-checkout-ci',
      label: 'Run clean checkout repository validation',
      commandShape: 'git switch --detach launch-candidate-1 && npm ci && npm run ci',
      evidenceLabel: 'clean-checkout-ci-result-label',
      retain: ['pass/fail status', 'test command names', 'timestamp'],
      neverRetain: [...NEVER_RETAIN_COMMON],
      requiredForSemiLaunchGo: true,
    },
    {
      id: 'doctor',
      label: 'Run production doctor evidence',
      commandShape: 'npm run --silent ops:doctor -- -- --json',
      evidenceLabel: 'ops-doctor-json-result-label',
      retain: ['PASS count', 'WARN count', 'FAIL count', 'O4/O5 warning labels', 'timestamp'],
      neverRetain: [...NEVER_RETAIN_COMMON],
      requiredForSemiLaunchGo: true,
    },
    {
      id: 'backup-verify',
      label: 'Run backup and verification evidence',
      commandShape: 'npm run ops:backup -- --output <backup-file> && npm run ops:verify-backup -- --input <backup-file>',
      evidenceLabel: 'backup-verify-result-label',
      retain: ['backup-created status', 'verify status', 'timestamp'],
      neverRetain: [...NEVER_RETAIN_COMMON],
      requiredForSemiLaunchGo: true,
    },
    {
      id: 'restore-rehearsal',
      label: 'Run restore rehearsal evidence',
      commandShape: 'npm run ops:rehearse-restore -- --backup <backup-file> --database-url <rehearsal-db-url-file>',
      evidenceLabel: 'restore-rehearsal-result-label',
      retain: ['rehearsal pass/fail status', 'timestamp'],
      neverRetain: [...NEVER_RETAIN_COMMON],
      requiredForSemiLaunchGo: true,
    },
    {
      id: 'kek-plan',
      label: 'Run KEK rewrap plan evidence',
      commandShape: 'npm run ops:rewrap-kek -- --plan --json',
      evidenceLabel: 'kek-rewrap-plan-result-label',
      retain: ['plan status', 'needsRewrap count', 'alreadyCurrent count', 'total count', 'timestamp'],
      neverRetain: [...NEVER_RETAIN_COMMON],
      requiredForSemiLaunchGo: true,
    },
    {
      id: 'schedule-retention',
      label: 'Record scheduler and retention evidence',
      commandShape: 'operator records Unraid User Scripts / cron cadence labels only',
      evidenceLabel: 'scheduler-retention-evidence-label',
      retain: ['schedule installed status', 'retention target label', 'alerting status', 'timestamp'],
      neverRetain: [...NEVER_RETAIN_COMMON],
      requiredForSemiLaunchGo: true,
    },
    {
      id: 'provider-live-smoke',
      label: 'Record provider live-smoke acceptance evidence',
      commandShape: 'operator records retained provider live-smoke acceptance label only',
      evidenceLabel: 'provider-live-smoke-acceptance-label',
      retain: ['acceptance status', 'review label', 'timestamp'],
      neverRetain: [...NEVER_RETAIN_COMMON],
      requiredForSemiLaunchGo: true,
    },
    {
      id: 'media-server-validation',
      label: 'Record media-server validation evidence',
      commandShape: 'operator records retained media-server validation label only',
      evidenceLabel: 'media-server-validation-evidence-label',
      retain: ['validation status', 'review label', 'timestamp'],
      neverRetain: [...NEVER_RETAIN_COMMON],
      requiredForSemiLaunchGo: true,
    },
    {
      id: 'deferred-risk',
      label: 'Record O4/O5 deferred-risk acceptance',
      commandShape: 'operator records O4/O5 deferred-risk acceptance labels',
      evidenceLabel: 'o4-o5-deferred-risk-acceptance-label',
      retain: ['O4 accepted-deferred-risk label', 'O5 accepted-deferred-risk label', 'timestamp'],
      neverRetain: [...NEVER_RETAIN_COMMON],
      requiredForSemiLaunchGo: true,
    },
  ],
  refChecks: [
    'master equals origin/master before validation',
    'launch-candidate-1 points at the Phase 92 seal commit',
    'phase-93 points at the validation packet commit',
    'phase-94 points at this run-sheet commit after seal',
  ],
  reviewerHandoffLabels: [
    'ref-alignment-result-label',
    'clean-checkout-ci-result-label',
    'ops-doctor-json-result-label',
    'backup-verify-result-label',
    'restore-rehearsal-result-label',
    'kek-rewrap-plan-result-label',
    'scheduler-retention-evidence-label',
    'provider-live-smoke-acceptance-label',
    'media-server-validation-evidence-label',
    'o4-o5-deferred-risk-acceptance-label',
  ],
  holdTriggers: [
    'Hold if any run-sheet evidence label is missing.',
    'Hold if any command result is not retained as a redaction-safe status/count/timestamp label.',
    'Hold if O4 or O5 are described as closed.',
    'Hold if reviewer GO is missing after evidence collection.',
    'Hold if any retained material includes secrets, raw identity, provider payloads, raw refs, URLs, raw logs, artifact contents, or actual evidence values.',
  ],
  forbiddenMaterial: [...NEVER_RETAIN_COMMON],
  explicitNonGoals: [
    'No operator evidence collection by this command.',
    'No semi-launch GO.',
    'No launch approval.',
    'No production-readiness approval.',
    'No release-candidate approval.',
    'No production release approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No DB reads or writes.',
    'No credential, environment, evidence-content, artifact-content, backup-content, provider-payload, raw-ref, URL, or media-identity reads.',
    'No network calls or live service contact.',
    'No provider mode, playback, downloading, scraping, media-server writes, frontend framework, API framework, externally bound web UI expansion, scheduler, Docker change, or background runtime work.',
  ],
};

export function buildOperatorValidationRunSheet(): OperatorValidationRunSheet {
  return {
    ...OPERATOR_VALIDATION_RUN_SHEET,
    runOrder: OPERATOR_VALIDATION_RUN_SHEET.runOrder.map((step) => ({
      ...step,
      retain: [...step.retain],
      neverRetain: [...step.neverRetain],
    })),
    refChecks: [...OPERATOR_VALIDATION_RUN_SHEET.refChecks],
    reviewerHandoffLabels: [...OPERATOR_VALIDATION_RUN_SHEET.reviewerHandoffLabels],
    holdTriggers: [...OPERATOR_VALIDATION_RUN_SHEET.holdTriggers],
    forbiddenMaterial: [...OPERATOR_VALIDATION_RUN_SHEET.forbiddenMaterial],
    explicitNonGoals: [...OPERATOR_VALIDATION_RUN_SHEET.explicitNonGoals],
  };
}

export function formatOperatorValidationRunSheetJson(
  sheet: OperatorValidationRunSheet = buildOperatorValidationRunSheet(),
): string {
  return `${JSON.stringify(sheet, null, 2)}\n`;
}

export function formatOperatorValidationRunSheetText(
  sheet: OperatorValidationRunSheet = buildOperatorValidationRunSheet(),
): string {
  const lines = [
    'Phase 94 operator validation run sheet',
    `code: ${sheet.code}`,
    `status: ${sheet.status}`,
    `launchCandidateTagLabel: ${sheet.launchCandidateTagLabel}`,
    `operatorActionRequired: ${sheet.operatorActionRequired ? 'true' : 'false'}`,
    `semiLaunchCandidateGo: ${sheet.semiLaunchCandidateGo ? 'true' : 'false'}`,
    `operatorEvidenceCollected: ${sheet.operatorEvidenceCollected ? 'true' : 'false'}`,
    `independentReviewRequired: ${sheet.independentReviewRequired ? 'true' : 'false'}`,
    `launchApproved: ${sheet.launchApproved ? 'true' : 'false'}`,
    `productionReady: ${sheet.productionReady ? 'true' : 'false'}`,
    `releaseCandidateApproved: ${sheet.releaseCandidateApproved ? 'true' : 'false'}`,
    `releaseApproved: ${sheet.releaseApproved ? 'true' : 'false'}`,
    `closesO4: ${sheet.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${sheet.closesO5 ? 'true' : 'false'}`,
    `allowedClaim: ${sheet.allowedClaim}`,
    `forbiddenClaim: ${sheet.forbiddenClaim}`,
    '',
    'Run order:',
  ];

  for (const step of sheet.runOrder) {
    lines.push(`- ${step.id}: ${step.label}`);
    lines.push(`  commandShape: ${step.commandShape}`);
    lines.push(`  evidenceLabel: ${step.evidenceLabel}`);
    lines.push('  retain:');
    for (const item of step.retain) lines.push(`  - ${item}`);
    lines.push('  never retain:');
    for (const item of step.neverRetain) lines.push(`  - ${item}`);
  }

  lines.push('', 'Reviewer handoff labels:');
  for (const label of sheet.reviewerHandoffLabels) lines.push(`- ${label}`);

  lines.push('', 'Hold triggers:');
  for (const trigger of sheet.holdTriggers) lines.push(`- ${trigger}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of sheet.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}
