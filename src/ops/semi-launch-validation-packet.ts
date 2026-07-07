export type SemiLaunchValidationReport = 'phase-93-semi-launch-validation-packet';
export type SemiLaunchValidationCode = 'SEMI_LAUNCH_VALIDATION_PACKET_RECORDED';
export type SemiLaunchValidationStatus = 'hold-pending-operator-evidence';
export type SemiLaunchCandidateVerdict = 'hold';

export interface SemiLaunchValidationGate {
  readonly id: string;
  readonly label: string;
  readonly status: 'required' | 'accepted-deferred-risk';
  readonly requiredForGo: boolean;
  readonly closesO4: false;
  readonly closesO5: false;
}

export interface SemiLaunchValidationPacket {
  readonly ok: true;
  readonly report: SemiLaunchValidationReport;
  readonly version: 1;
  readonly code: SemiLaunchValidationCode;
  readonly status: SemiLaunchValidationStatus;
  readonly launchCandidateTagLabel: 'launch-candidate-1';
  readonly phaseTagLabel: 'phase-93';
  readonly sourceLaunchCandidateSeal: 'phase-92-launch-candidate-seal';
  readonly sourceProductionDecision: 'phase-91-production-time-decision';
  readonly semiLaunchCandidateVerdict: SemiLaunchCandidateVerdict;
  readonly semiLaunchCandidateGo: false;
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly releaseCandidateApproved: false;
  readonly releaseApproved: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly residualRiskAccepted: true;
  readonly repoValidationExpected: true;
  readonly operatorEvidenceCollected: false;
  readonly independentReviewRequired: true;
  readonly allowedClaim: 'launch candidate is sealed; semi-launch GO is pending operator evidence review';
  readonly forbiddenClaim: 'semi-launch candidate approved';
  readonly requiredRefChecks: readonly string[];
  readonly requiredRepoValidation: readonly string[];
  readonly requiredOperatorEvidenceLabels: readonly string[];
  readonly validationGates: readonly SemiLaunchValidationGate[];
  readonly holdTriggers: readonly string[];
  readonly goConditions: readonly string[];
  readonly remainingProductionIssues: readonly string[];
  readonly forbiddenMaterial: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

export const SEMI_LAUNCH_VALIDATION_PACKET: SemiLaunchValidationPacket = {
  ok: true,
  report: 'phase-93-semi-launch-validation-packet',
  version: 1,
  code: 'SEMI_LAUNCH_VALIDATION_PACKET_RECORDED',
  status: 'hold-pending-operator-evidence',
  launchCandidateTagLabel: 'launch-candidate-1',
  phaseTagLabel: 'phase-93',
  sourceLaunchCandidateSeal: 'phase-92-launch-candidate-seal',
  sourceProductionDecision: 'phase-91-production-time-decision',
  semiLaunchCandidateVerdict: 'hold',
  semiLaunchCandidateGo: false,
  launchApproved: false,
  productionReady: false,
  releaseCandidateApproved: false,
  releaseApproved: false,
  closesO4: false,
  closesO5: false,
  residualRiskAccepted: true,
  repoValidationExpected: true,
  operatorEvidenceCollected: false,
  independentReviewRequired: true,
  allowedClaim: 'launch candidate is sealed; semi-launch GO is pending operator evidence review',
  forbiddenClaim: 'semi-launch candidate approved',
  requiredRefChecks: [
    'master equals origin/master',
    'master equals phase-92',
    'master equals launch-candidate-1',
    'phase-93 points at the validation-packet commit after seal',
    'working tree is clean after validation-packet seal',
  ],
  requiredRepoValidation: [
    'npm ci from a clean checkout of launch-candidate-1',
    'npm run ci from a clean checkout of launch-candidate-1',
    'npm run test:deploy from the validation branch',
    'npm run test:semi-launch-validation-packet from the validation branch',
    'git diff --check before commit',
    'source boundary grep for runtime, provider, network, evidence, and approval drift',
  ],
  requiredOperatorEvidenceLabels: [
    'ops-doctor-json-result-label',
    'backup-created-label',
    'backup-verify-result-label',
    'restore-rehearsal-result-label',
    'kek-rewrap-plan-result-label',
    'scheduler-retention-evidence-label',
    'provider-live-smoke-acceptance-label',
    'media-server-validation-evidence-label',
    'o4-deferred-risk-acceptance-label',
    'o5-deferred-risk-acceptance-label',
    'independent-reviewer-go-or-hold-label',
  ],
  validationGates: [
    {
      id: 'repo-validation',
      label: 'Repository validation from launch-candidate-1',
      status: 'required',
      requiredForGo: true,
      closesO4: false,
      closesO5: false,
    },
    {
      id: 'operator-evidence',
      label: 'Redaction-safe operator evidence packet',
      status: 'required',
      requiredForGo: true,
      closesO4: false,
      closesO5: false,
    },
    {
      id: 'independent-review',
      label: 'Independent reviewer GO/HOLD on retained evidence labels',
      status: 'required',
      requiredForGo: true,
      closesO4: false,
      closesO5: false,
    },
    {
      id: 'o4',
      label: 'External custodian / KMS deferred risk',
      status: 'accepted-deferred-risk',
      requiredForGo: true,
      closesO4: false,
      closesO5: false,
    },
    {
      id: 'o5',
      label: 'Managed KEK custody and rotation scheduling deferred risk',
      status: 'accepted-deferred-risk',
      requiredForGo: true,
      closesO4: false,
      closesO5: false,
    },
  ],
  holdTriggers: [
    'Hold if master, origin/master, phase-92, and launch-candidate-1 do not point at the same reviewed commit before validation.',
    'Hold if clean-checkout repo validation fails.',
    'Hold if any required operator evidence label is missing.',
    'Hold if independent reviewer verdict is missing or HOLD.',
    'Hold if O4 or O5 are described as closed.',
    'Hold if any retained evidence includes secrets, raw identity, provider payloads, raw refs, server URLs, logs, artifact contents, or actual evidence values.',
  ],
  goConditions: [
    'All required ref checks pass.',
    'Clean-checkout repo validation passes.',
    'All required operator evidence labels are present and redaction-safe.',
    'Independent reviewer records GO for semi-launch candidate use.',
    'O4 and O5 remain visible as accepted deferred risk, not closed.',
    'Semi-launch wording avoids production-ready, release-approved, or turnkey claims.',
  ],
  remainingProductionIssues: [
    'O4 still needs real external custodian/KMS evidence before production closure.',
    'O5 still needs managed KEK custody and rotation scheduling evidence before production closure.',
    'Semi-launch GO cannot be recorded by this packet until operator evidence and independent review exist.',
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

export function buildSemiLaunchValidationPacket(): SemiLaunchValidationPacket {
  return {
    ...SEMI_LAUNCH_VALIDATION_PACKET,
    requiredRefChecks: [...SEMI_LAUNCH_VALIDATION_PACKET.requiredRefChecks],
    requiredRepoValidation: [...SEMI_LAUNCH_VALIDATION_PACKET.requiredRepoValidation],
    requiredOperatorEvidenceLabels: [...SEMI_LAUNCH_VALIDATION_PACKET.requiredOperatorEvidenceLabels],
    validationGates: SEMI_LAUNCH_VALIDATION_PACKET.validationGates.map((gate) => ({ ...gate })),
    holdTriggers: [...SEMI_LAUNCH_VALIDATION_PACKET.holdTriggers],
    goConditions: [...SEMI_LAUNCH_VALIDATION_PACKET.goConditions],
    remainingProductionIssues: [...SEMI_LAUNCH_VALIDATION_PACKET.remainingProductionIssues],
    forbiddenMaterial: [...SEMI_LAUNCH_VALIDATION_PACKET.forbiddenMaterial],
    explicitNonGoals: [...SEMI_LAUNCH_VALIDATION_PACKET.explicitNonGoals],
  };
}

export function formatSemiLaunchValidationPacketJson(
  packet: SemiLaunchValidationPacket = buildSemiLaunchValidationPacket(),
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatSemiLaunchValidationPacketText(
  packet: SemiLaunchValidationPacket = buildSemiLaunchValidationPacket(),
): string {
  const lines = [
    'Phase 93 semi-launch validation packet',
    `code: ${packet.code}`,
    `status: ${packet.status}`,
    `semiLaunchCandidateVerdict: ${packet.semiLaunchCandidateVerdict}`,
    `semiLaunchCandidateGo: ${packet.semiLaunchCandidateGo ? 'true' : 'false'}`,
    `launchCandidateTagLabel: ${packet.launchCandidateTagLabel}`,
    `phaseTagLabel: ${packet.phaseTagLabel}`,
    `launchApproved: ${packet.launchApproved ? 'true' : 'false'}`,
    `productionReady: ${packet.productionReady ? 'true' : 'false'}`,
    `releaseCandidateApproved: ${packet.releaseCandidateApproved ? 'true' : 'false'}`,
    `releaseApproved: ${packet.releaseApproved ? 'true' : 'false'}`,
    `closesO4: ${packet.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${packet.closesO5 ? 'true' : 'false'}`,
    `operatorEvidenceCollected: ${packet.operatorEvidenceCollected ? 'true' : 'false'}`,
    `independentReviewRequired: ${packet.independentReviewRequired ? 'true' : 'false'}`,
    `allowedClaim: ${packet.allowedClaim}`,
    `forbiddenClaim: ${packet.forbiddenClaim}`,
    '',
    'Required ref checks:',
  ];

  for (const check of packet.requiredRefChecks) lines.push(`- ${check}`);

  lines.push('', 'Required repo validation:');
  for (const check of packet.requiredRepoValidation) lines.push(`- ${check}`);

  lines.push('', 'Required operator evidence labels:');
  for (const label of packet.requiredOperatorEvidenceLabels) lines.push(`- ${label}`);

  lines.push('', 'Validation gates:');
  for (const gate of packet.validationGates) {
    lines.push(`- ${gate.id}: ${gate.label}`);
    lines.push(`  status: ${gate.status}`);
    lines.push(`  requiredForGo: ${gate.requiredForGo ? 'true' : 'false'}`);
    lines.push(`  closesO4: ${gate.closesO4 ? 'true' : 'false'}`);
    lines.push(`  closesO5: ${gate.closesO5 ? 'true' : 'false'}`);
  }

  lines.push('', 'Hold triggers:');
  for (const trigger of packet.holdTriggers) lines.push(`- ${trigger}`);

  lines.push('', 'GO conditions:');
  for (const condition of packet.goConditions) lines.push(`- ${condition}`);

  lines.push('', 'Remaining production issues:');
  for (const issue of packet.remainingProductionIssues) lines.push(`- ${issue}`);

  lines.push('', 'Forbidden material:');
  for (const item of packet.forbiddenMaterial) lines.push(`- ${item}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of packet.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}
