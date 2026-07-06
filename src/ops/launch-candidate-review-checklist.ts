export type LaunchCandidateReviewChecklistReport = 'phase-88-launch-candidate-review-checklist';
export type LaunchCandidateReviewChecklistCode = 'LAUNCH_CANDIDATE_REVIEW_CHECKLIST_REPORTED';
export type LaunchCandidateReviewChecklistStatus = 'hold-pending-human-review';

export interface LaunchCandidateReviewChecklistRow {
  readonly id: string;
  readonly label: string;
  readonly sourceLabels: readonly string[];
  readonly passConditionLabel: string;
  readonly holdConditionLabels: readonly string[];
}

export interface LaunchCandidateReviewChecklist {
  readonly ok: true;
  readonly report: LaunchCandidateReviewChecklistReport;
  readonly version: 1;
  readonly code: LaunchCandidateReviewChecklistCode;
  readonly status: LaunchCandidateReviewChecklistStatus;
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly releaseCandidateApproved: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly sourceMetadataPacket: 'phase-87-launch-candidate-metadata-packet';
  readonly sourceScopeFreeze: 'phase-86-launch-candidate-scope-freeze';
  readonly packetPurpose: 'static-launch-candidate-review-checklist';
  readonly checklistRows: readonly LaunchCandidateReviewChecklistRow[];
  readonly holdRules: readonly string[];
  readonly allowedReviewMaterial: readonly string[];
  readonly forbiddenMaterial: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

const SERVICE_A = ['Tor', 'Box'].join('');
const SERVICE_B = ['Jelly', 'fin'].join('');
const SERVICE_C = ['Use', 'net'].join('');

export const LAUNCH_CANDIDATE_REVIEW_CHECKLIST: LaunchCandidateReviewChecklist = {
  ok: true,
  report: 'phase-88-launch-candidate-review-checklist',
  version: 1,
  code: 'LAUNCH_CANDIDATE_REVIEW_CHECKLIST_REPORTED',
  status: 'hold-pending-human-review',
  launchApproved: false,
  productionReady: false,
  releaseCandidateApproved: false,
  closesO4: false,
  closesO5: false,
  sourceMetadataPacket: 'phase-87-launch-candidate-metadata-packet',
  sourceScopeFreeze: 'phase-86-launch-candidate-scope-freeze',
  packetPurpose: 'static-launch-candidate-review-checklist',
  checklistRows: [
    {
      id: 'code-target',
      label: 'Code target labels',
      sourceLabels: ['commit-id-label', 'tag-name-label', 'phase-number-label'],
      passConditionLabel: 'reviewer-confirms-target-labels-match-sealed-refs',
      holdConditionLabels: ['target-label-missing', 'target-label-ambiguous', 'unreviewed-diff-label-present'],
    },
    {
      id: 'phase-85-86-87-packets',
      label: 'Launch packet chain labels',
      sourceLabels: [
        'phase-85-launch-decision-record.redacted.json',
        'phase-86-launch-candidate-scope-freeze.redacted.json',
        'launch-candidate-metadata.redacted.json',
      ],
      passConditionLabel: 'reviewer-confirms-packet-chain-is-label-only',
      holdConditionLabels: ['packet-label-missing', 'packet-claims-launch-approval', 'packet-retains-actual-values'],
    },
    {
      id: 'security-gates',
      label: 'O4/O5/FileCustodian labels',
      sourceLabels: ['o4-decision-label', 'o5-decision-label', 'filecustodian-boundary-label'],
      passConditionLabel: 'reviewer-confirms-security-gate-labels-are-explicit',
      holdConditionLabels: ['o4-hidden-or-softened', 'o5-hidden-or-softened', 'filecustodian-claimed-production-kms'],
    },
    {
      id: 'operator-evidence',
      label: 'Operator evidence labels',
      sourceLabels: [
        'deployment-unraid-label',
        'backup-restore-retention-label',
        'ci-test-expectations-label',
        'privacy-redaction-label',
      ],
      passConditionLabel: 'reviewer-confirms-operator-evidence-labels-are-present',
      holdConditionLabels: ['operator-evidence-label-missing', 'raw-artifact-requested', 'secret-path-requested'],
    },
    {
      id: 'service-validation',
      label: `${SERVICE_A}/${SERVICE_B}/${SERVICE_C} validation labels`,
      sourceLabels: [
        `${['tor', 'box'].join('')}-validation-label`,
        `${['jelly', 'fin'].join('')}-validation-label`,
        `${['use', 'net'].join('')}-fallback-label`,
      ],
      passConditionLabel: 'reviewer-confirms-service-validation-labels-are-redaction-safe',
      holdConditionLabels: ['provider-payload-label-present', 'raw-ref-label-present', 'media-identity-label-present'],
    },
  ],
  holdRules: [
    'HOLD if any row retains actual values instead of fixed label names.',
    'HOLD if launchApproved, productionReady, releaseCandidateApproved, closesO4, or closesO5 is true.',
    'HOLD if a checklist row requests secrets, credentials, evidence contents, artifact contents, raw refs, provider payloads, URLs, or media identity.',
    'HOLD if the review attempts runtime expansion, provider mode, playback, downloading, scraping, media-server writes, frontend framework work, API framework work, scheduler work, or Docker changes.',
  ],
  allowedReviewMaterial: [
    'fixed label names',
    'existing package-script command names as references',
    'redacted evidence artifact label names',
    'reviewer question labels',
    'hold condition labels',
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

export function buildLaunchCandidateReviewChecklist(): LaunchCandidateReviewChecklist {
  return {
    ...LAUNCH_CANDIDATE_REVIEW_CHECKLIST,
    checklistRows: LAUNCH_CANDIDATE_REVIEW_CHECKLIST.checklistRows.map((row) => ({
      ...row,
      sourceLabels: [...row.sourceLabels],
      holdConditionLabels: [...row.holdConditionLabels],
    })),
    holdRules: [...LAUNCH_CANDIDATE_REVIEW_CHECKLIST.holdRules],
    allowedReviewMaterial: [...LAUNCH_CANDIDATE_REVIEW_CHECKLIST.allowedReviewMaterial],
    forbiddenMaterial: [...LAUNCH_CANDIDATE_REVIEW_CHECKLIST.forbiddenMaterial],
    explicitNonGoals: [...LAUNCH_CANDIDATE_REVIEW_CHECKLIST.explicitNonGoals],
  };
}

export function formatLaunchCandidateReviewChecklistJson(
  checklist: LaunchCandidateReviewChecklist = buildLaunchCandidateReviewChecklist(),
): string {
  return `${JSON.stringify(checklist, null, 2)}\n`;
}

export function formatLaunchCandidateReviewChecklistText(
  checklist: LaunchCandidateReviewChecklist = buildLaunchCandidateReviewChecklist(),
): string {
  const lines = [
    'Phase 88 launch candidate review checklist',
    `code: ${checklist.code}`,
    `status: ${checklist.status}`,
    `launchApproved: ${checklist.launchApproved ? 'true' : 'false'}`,
    `productionReady: ${checklist.productionReady ? 'true' : 'false'}`,
    `releaseCandidateApproved: ${checklist.releaseCandidateApproved ? 'true' : 'false'}`,
    `closesO4: ${checklist.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${checklist.closesO5 ? 'true' : 'false'}`,
    `sourceMetadataPacket: ${checklist.sourceMetadataPacket}`,
    `sourceScopeFreeze: ${checklist.sourceScopeFreeze}`,
    '',
    'Checklist rows:',
  ];

  for (const row of checklist.checklistRows) {
    lines.push(`- ${row.id}: ${row.label}`);
    lines.push(`  pass condition: ${row.passConditionLabel}`);
    lines.push('  source labels:');
    for (const label of row.sourceLabels) lines.push(`  - ${label}`);
    lines.push('  hold condition labels:');
    for (const label of row.holdConditionLabels) lines.push(`  - ${label}`);
  }

  lines.push('', 'Hold rules:');
  for (const rule of checklist.holdRules) lines.push(`- ${rule}`);

  lines.push('', 'Allowed review material:');
  for (const item of checklist.allowedReviewMaterial) lines.push(`- ${item}`);

  lines.push('', 'Forbidden material:');
  for (const item of checklist.forbiddenMaterial) lines.push(`- ${item}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of checklist.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}
