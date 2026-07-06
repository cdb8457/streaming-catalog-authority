export type ProductionTimeDecisionReport = 'phase-91-production-time-decision';
export type ProductionTimeDecisionCode = 'PRODUCTION_TIME_DECISION_RECORDED';
export type ProductionTimeStatus = 'launch-candidate-requested-with-deferred-risk-accepted';
export type LaunchCandidateDisposition = 'requested-for-review';
export type DeferredGateId = 'o4' | 'o5';

export interface ProductionTimeDeferredGate {
  readonly id: DeferredGateId;
  readonly label: string;
  readonly disposition: 'operator-accepted-deferred-risk';
  readonly closesGate: false;
  readonly requiredEvidenceToClose: readonly string[];
  readonly launchWording: string;
}

export interface ProductionTimeDecision {
  readonly ok: true;
  readonly report: ProductionTimeDecisionReport;
  readonly version: 1;
  readonly code: ProductionTimeDecisionCode;
  readonly status: ProductionTimeStatus;
  readonly launchCandidateDisposition: LaunchCandidateDisposition;
  readonly launchCandidateRequested: true;
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly releaseCandidateApproved: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly residualRiskAccepted: true;
  readonly sourceFinalDisposition: 'phase-90-final-launch-disposition';
  readonly sourceReviewHandoff: 'phase-89-launch-candidate-review-handoff';
  readonly sourceReadinessGate: 'phase-22-production-readiness-gate';
  readonly operatorDirection: 'push-through-with-honest-gates';
  readonly allowedLaunchClaim: 'launch candidate requested; O4/O5 deferred risk explicitly accepted';
  readonly forbiddenLaunchClaim: 'turnkey production ready';
  readonly deferredGates: readonly ProductionTimeDeferredGate[];
  readonly requiredOperatorEvidenceLabels: readonly string[];
  readonly finalReviewChecklist: readonly string[];
  readonly remainingProductionIssues: readonly string[];
  readonly forbiddenMaterial: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

export const PRODUCTION_TIME_DECISION: ProductionTimeDecision = {
  ok: true,
  report: 'phase-91-production-time-decision',
  version: 1,
  code: 'PRODUCTION_TIME_DECISION_RECORDED',
  status: 'launch-candidate-requested-with-deferred-risk-accepted',
  launchCandidateDisposition: 'requested-for-review',
  launchCandidateRequested: true,
  launchApproved: false,
  productionReady: false,
  releaseCandidateApproved: false,
  closesO4: false,
  closesO5: false,
  residualRiskAccepted: true,
  sourceFinalDisposition: 'phase-90-final-launch-disposition',
  sourceReviewHandoff: 'phase-89-launch-candidate-review-handoff',
  sourceReadinessGate: 'phase-22-production-readiness-gate',
  operatorDirection: 'push-through-with-honest-gates',
  allowedLaunchClaim: 'launch candidate requested; O4/O5 deferred risk explicitly accepted',
  forbiddenLaunchClaim: 'turnkey production ready',
  deferredGates: [
    {
      id: 'o4',
      label: 'External custodian / KMS gate',
      disposition: 'operator-accepted-deferred-risk',
      closesGate: false,
      requiredEvidenceToClose: [
        'real external custodian adapter outside app trust boundary',
        'live operator validation against the custodian acceptance kit',
        'redaction-safe attestation and fail-closed evidence',
      ],
      launchWording: 'O4 remains open/deferred and is accepted as launch-candidate residual risk.',
    },
    {
      id: 'o5',
      label: 'Managed KEK custody and rotation scheduling gate',
      disposition: 'operator-accepted-deferred-risk',
      closesGate: false,
      requiredEvidenceToClose: [
        'managed KEK custody evidence',
        'documented rotation schedule evidence',
        'redaction-safe rewrap plan or rotation record',
      ],
      launchWording: 'O5 remains open/deferred and is accepted as launch-candidate residual risk.',
    },
  ],
  requiredOperatorEvidenceLabels: [
    'ops-doctor-result-label',
    'backup-verify-result-label',
    'restore-rehearsal-result-label',
    'scheduler-retention-evidence-label',
    'provider-live-smoke-acceptance-label',
    'jellyfin-validation-evidence-label',
    'o4-deferred-risk-acceptance-label',
    'o5-deferred-risk-acceptance-label',
  ],
  finalReviewChecklist: [
    'Confirm master and launch-candidate tag point at the same reviewed commit.',
    'Confirm CI is green with zero failures.',
    'Confirm no runtime, provider-mode, playback, scraping, downloading, or UI scope expansion was added by this decision.',
    'Confirm O4 and O5 are visible as accepted deferred risks, not closed gates.',
    'Confirm retained evidence uses labels, counts, statuses, and placeholders only.',
    'Confirm production wording says launch candidate, not turnkey production ready.',
  ],
  remainingProductionIssues: [
    'O4 is not closed until a production external custodian/KMS adapter is validated and reviewed.',
    'O5 is not closed until managed KEK custody and rotation scheduling evidence is validated and reviewed.',
    'Operator-run evidence must be retained outside the repo using redaction-safe templates.',
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
    'No O4 closure.',
    'No O5 closure.',
    'No DB reads or writes.',
    'No credential, environment, evidence-content, artifact-content, backup-content, provider-payload, raw-ref, URL, or media-identity reads.',
    'No network calls or live service contact.',
    'No provider mode, playback, downloading, scraping, media-server writes, frontend framework, API framework, web UI expansion, scheduler, Docker change, or background runtime work.',
  ],
};

export function buildProductionTimeDecision(): ProductionTimeDecision {
  return {
    ...PRODUCTION_TIME_DECISION,
    deferredGates: PRODUCTION_TIME_DECISION.deferredGates.map((gate) => ({
      ...gate,
      requiredEvidenceToClose: [...gate.requiredEvidenceToClose],
    })),
    requiredOperatorEvidenceLabels: [...PRODUCTION_TIME_DECISION.requiredOperatorEvidenceLabels],
    finalReviewChecklist: [...PRODUCTION_TIME_DECISION.finalReviewChecklist],
    remainingProductionIssues: [...PRODUCTION_TIME_DECISION.remainingProductionIssues],
    forbiddenMaterial: [...PRODUCTION_TIME_DECISION.forbiddenMaterial],
    explicitNonGoals: [...PRODUCTION_TIME_DECISION.explicitNonGoals],
  };
}

export function formatProductionTimeDecisionJson(
  decision: ProductionTimeDecision = buildProductionTimeDecision(),
): string {
  return `${JSON.stringify(decision, null, 2)}\n`;
}

export function formatProductionTimeDecisionText(
  decision: ProductionTimeDecision = buildProductionTimeDecision(),
): string {
  const lines = [
    'Phase 91 production-time decision',
    `code: ${decision.code}`,
    `status: ${decision.status}`,
    `launchCandidateDisposition: ${decision.launchCandidateDisposition}`,
    `launchCandidateRequested: ${decision.launchCandidateRequested ? 'true' : 'false'}`,
    `launchApproved: ${decision.launchApproved ? 'true' : 'false'}`,
    `productionReady: ${decision.productionReady ? 'true' : 'false'}`,
    `releaseCandidateApproved: ${decision.releaseCandidateApproved ? 'true' : 'false'}`,
    `closesO4: ${decision.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${decision.closesO5 ? 'true' : 'false'}`,
    `residualRiskAccepted: ${decision.residualRiskAccepted ? 'true' : 'false'}`,
    `allowedLaunchClaim: ${decision.allowedLaunchClaim}`,
    `forbiddenLaunchClaim: ${decision.forbiddenLaunchClaim}`,
    '',
    'Deferred gates:',
  ];

  for (const gate of decision.deferredGates) {
    lines.push(`- ${gate.id}: ${gate.label}`);
    lines.push(`  disposition: ${gate.disposition}`);
    lines.push(`  closesGate: ${gate.closesGate ? 'true' : 'false'}`);
    lines.push(`  launchWording: ${gate.launchWording}`);
    lines.push('  required evidence to close:');
    for (const evidence of gate.requiredEvidenceToClose) lines.push(`  - ${evidence}`);
  }

  lines.push('', 'Required operator evidence labels:');
  for (const label of decision.requiredOperatorEvidenceLabels) lines.push(`- ${label}`);

  lines.push('', 'Final review checklist:');
  for (const item of decision.finalReviewChecklist) lines.push(`- ${item}`);

  lines.push('', 'Remaining production issues:');
  for (const issue of decision.remainingProductionIssues) lines.push(`- ${issue}`);

  lines.push('', 'Forbidden material:');
  for (const item of decision.forbiddenMaterial) lines.push(`- ${item}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of decision.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}
