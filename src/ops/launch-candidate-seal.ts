export type LaunchCandidateSealReport = 'phase-92-launch-candidate-seal';
export type LaunchCandidateSealCode = 'LAUNCH_CANDIDATE_SEAL_RECORDED';
export type LaunchCandidateSealStatus = 'sealed-for-launch-candidate-review';

export interface LaunchCandidateSeal {
  readonly ok: true;
  readonly report: LaunchCandidateSealReport;
  readonly version: 1;
  readonly code: LaunchCandidateSealCode;
  readonly status: LaunchCandidateSealStatus;
  readonly launchCandidateTagLabel: 'launch-candidate-1';
  readonly phaseTagLabel: 'phase-92';
  readonly launchCandidateSealed: true;
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly releaseCandidateApproved: false;
  readonly releaseApproved: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly residualRiskAccepted: true;
  readonly sourceProductionDecision: 'phase-91-production-time-decision';
  readonly sourceFinalDisposition: 'phase-90-final-launch-disposition';
  readonly sourceReviewHandoff: 'phase-89-launch-candidate-review-handoff';
  readonly allowedClaim: 'launch candidate sealed for review; O4/O5 deferred risk explicitly accepted';
  readonly forbiddenClaim: 'production release approved';
  readonly requiredRefChecks: readonly string[];
  readonly requiredValidationChecks: readonly string[];
  readonly launchCandidateBoundaries: readonly string[];
  readonly remainingProductionIssues: readonly string[];
  readonly forbiddenMaterial: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

export const LAUNCH_CANDIDATE_SEAL: LaunchCandidateSeal = {
  ok: true,
  report: 'phase-92-launch-candidate-seal',
  version: 1,
  code: 'LAUNCH_CANDIDATE_SEAL_RECORDED',
  status: 'sealed-for-launch-candidate-review',
  launchCandidateTagLabel: 'launch-candidate-1',
  phaseTagLabel: 'phase-92',
  launchCandidateSealed: true,
  launchApproved: false,
  productionReady: false,
  releaseCandidateApproved: false,
  releaseApproved: false,
  closesO4: false,
  closesO5: false,
  residualRiskAccepted: true,
  sourceProductionDecision: 'phase-91-production-time-decision',
  sourceFinalDisposition: 'phase-90-final-launch-disposition',
  sourceReviewHandoff: 'phase-89-launch-candidate-review-handoff',
  allowedClaim: 'launch candidate sealed for review; O4/O5 deferred risk explicitly accepted',
  forbiddenClaim: 'production release approved',
  requiredRefChecks: [
    'master and origin/master point at the launch-candidate seal commit',
    'phase-92 points at the launch-candidate seal commit',
    'launch-candidate-1 points at the launch-candidate seal commit',
    'working tree is clean after seal',
  ],
  requiredValidationChecks: [
    'npm run test:launch-candidate-seal',
    'npm run test:deploy',
    'npm run typecheck',
    'npm run ci',
    'git diff --check',
    'source boundary grep for runtime, provider, network, and approval drift',
  ],
  launchCandidateBoundaries: [
    'Launch candidate only; not a production release.',
    'O4 remains open/deferred and accepted only as launch-candidate residual risk.',
    'O5 remains open/deferred and accepted only as launch-candidate residual risk.',
    'FileCustodian remains a hardened reference harness, not production KMS.',
    'No runtime behavior is added by this seal.',
    'No provider mode, playback, downloading, scraping, externally bound UI, or scheduler is enabled by this seal.',
  ],
  remainingProductionIssues: [
    'O4 still needs real external custodian/KMS evidence before production closure.',
    'O5 still needs managed KEK custody and rotation scheduling evidence before production closure.',
    'Operator-run evidence still must be retained outside the repo using redaction-safe templates.',
  ],
  forbiddenMaterial: [
    'secret values',
    'credential contents or paths',
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
    'actual evidence values',
  ],
  explicitNonGoals: [
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

export function buildLaunchCandidateSeal(): LaunchCandidateSeal {
  return {
    ...LAUNCH_CANDIDATE_SEAL,
    requiredRefChecks: [...LAUNCH_CANDIDATE_SEAL.requiredRefChecks],
    requiredValidationChecks: [...LAUNCH_CANDIDATE_SEAL.requiredValidationChecks],
    launchCandidateBoundaries: [...LAUNCH_CANDIDATE_SEAL.launchCandidateBoundaries],
    remainingProductionIssues: [...LAUNCH_CANDIDATE_SEAL.remainingProductionIssues],
    forbiddenMaterial: [...LAUNCH_CANDIDATE_SEAL.forbiddenMaterial],
    explicitNonGoals: [...LAUNCH_CANDIDATE_SEAL.explicitNonGoals],
  };
}

export function formatLaunchCandidateSealJson(
  seal: LaunchCandidateSeal = buildLaunchCandidateSeal(),
): string {
  return `${JSON.stringify(seal, null, 2)}\n`;
}

export function formatLaunchCandidateSealText(
  seal: LaunchCandidateSeal = buildLaunchCandidateSeal(),
): string {
  const lines = [
    'Phase 92 launch candidate seal',
    `code: ${seal.code}`,
    `status: ${seal.status}`,
    `phaseTagLabel: ${seal.phaseTagLabel}`,
    `launchCandidateTagLabel: ${seal.launchCandidateTagLabel}`,
    `launchCandidateSealed: ${seal.launchCandidateSealed ? 'true' : 'false'}`,
    `launchApproved: ${seal.launchApproved ? 'true' : 'false'}`,
    `productionReady: ${seal.productionReady ? 'true' : 'false'}`,
    `releaseCandidateApproved: ${seal.releaseCandidateApproved ? 'true' : 'false'}`,
    `releaseApproved: ${seal.releaseApproved ? 'true' : 'false'}`,
    `closesO4: ${seal.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${seal.closesO5 ? 'true' : 'false'}`,
    `residualRiskAccepted: ${seal.residualRiskAccepted ? 'true' : 'false'}`,
    `allowedClaim: ${seal.allowedClaim}`,
    `forbiddenClaim: ${seal.forbiddenClaim}`,
    '',
    'Required ref checks:',
  ];

  for (const check of seal.requiredRefChecks) lines.push(`- ${check}`);

  lines.push('', 'Required validation checks:');
  for (const check of seal.requiredValidationChecks) lines.push(`- ${check}`);

  lines.push('', 'Launch candidate boundaries:');
  for (const boundary of seal.launchCandidateBoundaries) lines.push(`- ${boundary}`);

  lines.push('', 'Remaining production issues:');
  for (const issue of seal.remainingProductionIssues) lines.push(`- ${issue}`);

  lines.push('', 'Forbidden material:');
  for (const item of seal.forbiddenMaterial) lines.push(`- ${item}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of seal.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}
