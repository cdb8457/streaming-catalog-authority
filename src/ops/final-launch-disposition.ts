export type FinalLaunchDispositionReport = 'phase-90-final-launch-disposition';
export type FinalLaunchDispositionCode = 'FINAL_LAUNCH_DISPOSITION_REPORTED';
export type FinalLaunchDispositionStatus = 'hold-pending-operator-decision';
export type FinalLaunchDecision = 'hold' | 'launch-candidate-requested';
export type GateDisposition = 'hold' | 'accepted-deferred-risk';

export interface FinalLaunchGateDisposition {
  readonly id: 'o4' | 'o5';
  readonly label: string;
  readonly disposition: GateDisposition;
  readonly closesGate: false;
  readonly requiredDecisionLabel: string;
  readonly holdIfMissingLabels: readonly string[];
}

export interface FinalLaunchDisposition {
  readonly ok: true;
  readonly report: FinalLaunchDispositionReport;
  readonly version: 1;
  readonly code: FinalLaunchDispositionCode;
  readonly status: FinalLaunchDispositionStatus;
  readonly launchDecision: FinalLaunchDecision;
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly releaseCandidateApproved: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly sourceReviewHandoff: 'phase-89-launch-candidate-review-handoff';
  readonly sourceReviewChecklist: 'phase-88-launch-candidate-review-checklist';
  readonly packetPurpose: 'static-final-launch-disposition-template';
  readonly requiredDecisionLabels: readonly string[];
  readonly gateDispositions: readonly FinalLaunchGateDisposition[];
  readonly finalHoldTriggers: readonly string[];
  readonly permittedOperatorDecisions: readonly string[];
  readonly forbiddenMaterial: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

export const FINAL_LAUNCH_DISPOSITION: FinalLaunchDisposition = {
  ok: true,
  report: 'phase-90-final-launch-disposition',
  version: 1,
  code: 'FINAL_LAUNCH_DISPOSITION_REPORTED',
  status: 'hold-pending-operator-decision',
  launchDecision: 'hold',
  launchApproved: false,
  productionReady: false,
  releaseCandidateApproved: false,
  closesO4: false,
  closesO5: false,
  sourceReviewHandoff: 'phase-89-launch-candidate-review-handoff',
  sourceReviewChecklist: 'phase-88-launch-candidate-review-checklist',
  packetPurpose: 'static-final-launch-disposition-template',
  requiredDecisionLabels: [
    'operator-final-decision-label',
    'reviewer-go-or-hold-label',
    'o4-disposition-label',
    'o5-disposition-label',
    'residual-risk-acceptance-label',
    'launch-candidate-target-label',
  ],
  gateDispositions: [
    {
      id: 'o4',
      label: 'External custodian / KMS gate',
      disposition: 'hold',
      closesGate: false,
      requiredDecisionLabel: 'o4-disposition-label',
      holdIfMissingLabels: ['o4-live-evidence-label', 'o4-reviewer-disposition-label', 'o4-operator-risk-decision-label'],
    },
    {
      id: 'o5',
      label: 'Managed KEK custody and rotation gate',
      disposition: 'hold',
      closesGate: false,
      requiredDecisionLabel: 'o5-disposition-label',
      holdIfMissingLabels: ['o5-custody-evidence-label', 'o5-rotation-schedule-label', 'o5-operator-risk-decision-label'],
    },
  ],
  finalHoldTriggers: [
    'Hold if operator-final-decision-label is missing.',
    'Hold if reviewer-go-or-hold-label is reviewer-hold-label.',
    'Hold if O4 or O5 are hidden, softened, or claimed closed.',
    'Hold if O4 or O5 are accepted as deferred risk without explicit operator residual-risk acceptance label.',
    'Hold if any launch artifact requests secrets, credentials, raw evidence, provider payloads, raw refs, media identity, URLs, logs, patch contents, or actual evidence values.',
  ],
  permittedOperatorDecisions: [
    'hold',
    'launch-candidate-requested-with-o4-o5-deferred-risk-accepted',
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
    'actual commit ids, tag names, dates, verdicts, counts, conclusions, or evidence values',
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

export function buildFinalLaunchDisposition(): FinalLaunchDisposition {
  return {
    ...FINAL_LAUNCH_DISPOSITION,
    requiredDecisionLabels: [...FINAL_LAUNCH_DISPOSITION.requiredDecisionLabels],
    gateDispositions: FINAL_LAUNCH_DISPOSITION.gateDispositions.map((gate) => ({
      ...gate,
      holdIfMissingLabels: [...gate.holdIfMissingLabels],
    })),
    finalHoldTriggers: [...FINAL_LAUNCH_DISPOSITION.finalHoldTriggers],
    permittedOperatorDecisions: [...FINAL_LAUNCH_DISPOSITION.permittedOperatorDecisions],
    forbiddenMaterial: [...FINAL_LAUNCH_DISPOSITION.forbiddenMaterial],
    explicitNonGoals: [...FINAL_LAUNCH_DISPOSITION.explicitNonGoals],
  };
}

export function formatFinalLaunchDispositionJson(
  disposition: FinalLaunchDisposition = buildFinalLaunchDisposition(),
): string {
  return `${JSON.stringify(disposition, null, 2)}\n`;
}

export function formatFinalLaunchDispositionText(
  disposition: FinalLaunchDisposition = buildFinalLaunchDisposition(),
): string {
  const lines = [
    'Phase 90 final launch disposition',
    `code: ${disposition.code}`,
    `status: ${disposition.status}`,
    `launchDecision: ${disposition.launchDecision}`,
    `launchApproved: ${disposition.launchApproved ? 'true' : 'false'}`,
    `productionReady: ${disposition.productionReady ? 'true' : 'false'}`,
    `releaseCandidateApproved: ${disposition.releaseCandidateApproved ? 'true' : 'false'}`,
    `closesO4: ${disposition.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${disposition.closesO5 ? 'true' : 'false'}`,
    `sourceReviewHandoff: ${disposition.sourceReviewHandoff}`,
    `sourceReviewChecklist: ${disposition.sourceReviewChecklist}`,
    '',
    'Required decision labels:',
  ];

  for (const label of disposition.requiredDecisionLabels) lines.push(`- ${label}`);

  lines.push('', 'Gate dispositions:');
  for (const gate of disposition.gateDispositions) {
    lines.push(`- ${gate.id}: ${gate.label}`);
    lines.push(`  disposition: ${gate.disposition}`);
    lines.push(`  closesGate: ${gate.closesGate ? 'true' : 'false'}`);
    lines.push(`  required decision label: ${gate.requiredDecisionLabel}`);
    lines.push('  hold if missing labels:');
    for (const label of gate.holdIfMissingLabels) lines.push(`  - ${label}`);
  }

  lines.push('', 'Final hold triggers:');
  for (const trigger of disposition.finalHoldTriggers) lines.push(`- ${trigger}`);

  lines.push('', 'Permitted operator decisions:');
  for (const decision of disposition.permittedOperatorDecisions) lines.push(`- ${decision}`);

  lines.push('', 'Forbidden material:');
  for (const item of disposition.forbiddenMaterial) lines.push(`- ${item}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of disposition.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}
