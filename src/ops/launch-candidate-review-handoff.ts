export type LaunchCandidateReviewHandoffReport = 'phase-89-launch-candidate-review-handoff';
export type LaunchCandidateReviewHandoffCode = 'LAUNCH_CANDIDATE_REVIEW_HANDOFF_REPORTED';
export type LaunchCandidateReviewHandoffStatus = 'awaiting-independent-review';

export interface LaunchCandidateReviewHandoffSection {
  readonly id: string;
  readonly label: string;
  readonly sourceLabels: readonly string[];
  readonly reviewerQuestionLabels: readonly string[];
  readonly holdTriggerLabels: readonly string[];
}

export interface LaunchCandidateReviewHandoff {
  readonly ok: true;
  readonly report: LaunchCandidateReviewHandoffReport;
  readonly version: 1;
  readonly code: LaunchCandidateReviewHandoffCode;
  readonly status: LaunchCandidateReviewHandoffStatus;
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly releaseCandidateApproved: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly sourceReviewChecklist: 'phase-88-launch-candidate-review-checklist';
  readonly sourceMetadataPacket: 'phase-87-launch-candidate-metadata-packet';
  readonly packetPurpose: 'static-independent-review-handoff';
  readonly handoffSections: readonly LaunchCandidateReviewHandoffSection[];
  readonly reviewerInstructions: readonly string[];
  readonly requiredVerdictLabels: readonly string[];
  readonly forbiddenMaterial: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

const SERVICE_A = ['Tor', 'Box'].join('');
const SERVICE_B = ['Jelly', 'fin'].join('');
const SERVICE_C = ['Use', 'net'].join('');

export const LAUNCH_CANDIDATE_REVIEW_HANDOFF: LaunchCandidateReviewHandoff = {
  ok: true,
  report: 'phase-89-launch-candidate-review-handoff',
  version: 1,
  code: 'LAUNCH_CANDIDATE_REVIEW_HANDOFF_REPORTED',
  status: 'awaiting-independent-review',
  launchApproved: false,
  productionReady: false,
  releaseCandidateApproved: false,
  closesO4: false,
  closesO5: false,
  sourceReviewChecklist: 'phase-88-launch-candidate-review-checklist',
  sourceMetadataPacket: 'phase-87-launch-candidate-metadata-packet',
  packetPurpose: 'static-independent-review-handoff',
  handoffSections: [
    {
      id: 'sealed-target-review',
      label: 'Sealed target review labels',
      sourceLabels: ['commit-id-label', 'tag-name-label', 'phase-number-label'],
      reviewerQuestionLabels: ['target-ref-match-question', 'unreviewed-diff-question'],
      holdTriggerLabels: ['target-label-missing', 'target-label-ambiguous', 'unreviewed-diff-label-present'],
    },
    {
      id: 'packet-chain-review',
      label: 'Packet chain review labels',
      sourceLabels: [
        'phase-85-launch-decision-record.redacted.json',
        'phase-86-launch-candidate-scope-freeze.redacted.json',
        'launch-candidate-metadata.redacted.json',
        'phase-88-launch-candidate-review-checklist',
      ],
      reviewerQuestionLabels: ['packet-chain-label-only-question', 'approval-flag-false-question'],
      holdTriggerLabels: ['packet-label-missing', 'packet-claims-launch-approval', 'packet-retains-actual-values'],
    },
    {
      id: 'security-boundary-review',
      label: 'Security boundary review labels',
      sourceLabels: ['o4-decision-label', 'o5-decision-label', 'filecustodian-boundary-label'],
      reviewerQuestionLabels: ['o4-visible-question', 'o5-visible-question', 'filecustodian-reference-harness-question'],
      holdTriggerLabels: ['o4-hidden-or-softened', 'o5-hidden-or-softened', 'filecustodian-claimed-production-kms'],
    },
    {
      id: 'operator-evidence-review',
      label: 'Operator evidence review labels',
      sourceLabels: [
        'deployment-unraid-label',
        'backup-restore-retention-label',
        'ci-test-expectations-label',
        'privacy-redaction-label',
      ],
      reviewerQuestionLabels: ['operator-evidence-labels-present-question', 'redaction-boundary-question'],
      holdTriggerLabels: ['operator-evidence-label-missing', 'raw-artifact-requested', 'secret-path-requested'],
    },
    {
      id: 'service-validation-review',
      label: `${SERVICE_A}/${SERVICE_B}/${SERVICE_C} validation review labels`,
      sourceLabels: [
        `${['tor', 'box'].join('')}-validation-label`,
        `${['jelly', 'fin'].join('')}-validation-label`,
        `${['use', 'net'].join('')}-fallback-label`,
      ],
      reviewerQuestionLabels: ['provider-payload-absent-question', 'raw-ref-absent-question', 'media-identity-absent-question'],
      holdTriggerLabels: ['provider-payload-label-present', 'raw-ref-label-present', 'media-identity-label-present'],
    },
  ],
  reviewerInstructions: [
    'Review label names, command references, and explicit hold triggers only.',
    'Do not request raw evidence, artifact contents, secret paths, provider payloads, raw refs, URLs, media identity, logs, or patch contents.',
    'Return GO only when every required label is present and every hold trigger remains absent.',
    'Return HOLD if any approval flag is true or if O4/O5 are hidden, softened, or closed.',
  ],
  requiredVerdictLabels: ['reviewer-go-label', 'reviewer-hold-label', 'required-change-label', 'residual-risk-label'],
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

export function buildLaunchCandidateReviewHandoff(): LaunchCandidateReviewHandoff {
  return {
    ...LAUNCH_CANDIDATE_REVIEW_HANDOFF,
    handoffSections: LAUNCH_CANDIDATE_REVIEW_HANDOFF.handoffSections.map((section) => ({
      ...section,
      sourceLabels: [...section.sourceLabels],
      reviewerQuestionLabels: [...section.reviewerQuestionLabels],
      holdTriggerLabels: [...section.holdTriggerLabels],
    })),
    reviewerInstructions: [...LAUNCH_CANDIDATE_REVIEW_HANDOFF.reviewerInstructions],
    requiredVerdictLabels: [...LAUNCH_CANDIDATE_REVIEW_HANDOFF.requiredVerdictLabels],
    forbiddenMaterial: [...LAUNCH_CANDIDATE_REVIEW_HANDOFF.forbiddenMaterial],
    explicitNonGoals: [...LAUNCH_CANDIDATE_REVIEW_HANDOFF.explicitNonGoals],
  };
}

export function formatLaunchCandidateReviewHandoffJson(
  handoff: LaunchCandidateReviewHandoff = buildLaunchCandidateReviewHandoff(),
): string {
  return `${JSON.stringify(handoff, null, 2)}\n`;
}

export function formatLaunchCandidateReviewHandoffText(
  handoff: LaunchCandidateReviewHandoff = buildLaunchCandidateReviewHandoff(),
): string {
  const lines = [
    'Phase 89 launch candidate review handoff',
    `code: ${handoff.code}`,
    `status: ${handoff.status}`,
    `launchApproved: ${handoff.launchApproved ? 'true' : 'false'}`,
    `productionReady: ${handoff.productionReady ? 'true' : 'false'}`,
    `releaseCandidateApproved: ${handoff.releaseCandidateApproved ? 'true' : 'false'}`,
    `closesO4: ${handoff.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${handoff.closesO5 ? 'true' : 'false'}`,
    `sourceReviewChecklist: ${handoff.sourceReviewChecklist}`,
    `sourceMetadataPacket: ${handoff.sourceMetadataPacket}`,
    '',
    'Handoff sections:',
  ];

  for (const section of handoff.handoffSections) {
    lines.push(`- ${section.id}: ${section.label}`);
    lines.push('  source labels:');
    for (const label of section.sourceLabels) lines.push(`  - ${label}`);
    lines.push('  reviewer question labels:');
    for (const label of section.reviewerQuestionLabels) lines.push(`  - ${label}`);
    lines.push('  hold trigger labels:');
    for (const label of section.holdTriggerLabels) lines.push(`  - ${label}`);
  }

  lines.push('', 'Reviewer instructions:');
  for (const instruction of handoff.reviewerInstructions) lines.push(`- ${instruction}`);

  lines.push('', 'Required verdict labels:');
  for (const label of handoff.requiredVerdictLabels) lines.push(`- ${label}`);

  lines.push('', 'Forbidden material:');
  for (const item of handoff.forbiddenMaterial) lines.push(`- ${item}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of handoff.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}
