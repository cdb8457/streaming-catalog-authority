export interface SidecarUnraidReviewHandoffSection {
  readonly id: string;
  readonly label: string;
  readonly sourceLabels: readonly string[];
  readonly reviewerQuestionLabels: readonly string[];
  readonly holdTriggerLabels: readonly string[];
}

export interface SidecarUnraidReviewHandoff {
  readonly ok: true;
  readonly report: 'phase-111-sidecar-unraid-review-handoff';
  readonly version: 1;
  readonly code: 'SIDECAR_UNRAID_REVIEW_HANDOFF';
  readonly status: 'awaiting-independent-review';
  readonly packetPurpose: 'static-sidecar-unraid-independent-review-handoff';
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly serviceInstallApproved: false;
  readonly providerModeEnabled: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly sourceReviewSummary: 'phase-109-sidecar-unraid-review-summary';
  readonly sourceAcceptancePreflight: 'phase-110-sidecar-unraid-acceptance-preflight';
  readonly handoffSections: readonly SidecarUnraidReviewHandoffSection[];
  readonly reviewerInstructions: readonly string[];
  readonly requiredVerdictLabels: readonly string[];
  readonly forbiddenMaterial: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

export function buildSidecarUnraidReviewHandoff(): SidecarUnraidReviewHandoff {
  return {
    ok: true,
    report: 'phase-111-sidecar-unraid-review-handoff',
    version: 1,
    code: 'SIDECAR_UNRAID_REVIEW_HANDOFF',
    status: 'awaiting-independent-review',
    packetPurpose: 'static-sidecar-unraid-independent-review-handoff',
    launchApproved: false,
    productionReady: false,
    serviceInstallApproved: false,
    providerModeEnabled: false,
    closesO4: false,
    closesO5: false,
    sourceReviewSummary: 'phase-109-sidecar-unraid-review-summary',
    sourceAcceptancePreflight: 'phase-110-sidecar-unraid-acceptance-preflight',
    handoffSections: [
      {
        id: 'operator-run-review',
        label: 'Operator run evidence labels',
        sourceLabels: ['phase-106-setup-permissions-redacted', 'phase-106-local-socket-health-redacted', 'phase-107-evidence-bundle-redacted'],
        reviewerQuestionLabels: ['operator-run-label-present-question', 'redaction-safe-question'],
        holdTriggerLabels: ['raw-command-output-present', 'secret-path-present', 'evidence-value-present'],
      },
      {
        id: 'review-gate-review',
        label: 'Review gate and summary labels',
        sourceLabels: ['phase-108-sidecar-unraid-review-gate', 'phase-109-sidecar-unraid-review-summary'],
        reviewerQuestionLabels: ['ready-for-review-label-question', 'summary-fail-count-zero-question'],
        holdTriggerLabels: ['review-gate-fail-present', 'summary-not-ready-present'],
      },
      {
        id: 'acceptance-record-review',
        label: 'Acceptance record labels',
        sourceLabels: ['phase-110-sidecar-unraid-acceptance-record', 'phase-110-sidecar-unraid-acceptance-preflight'],
        reviewerQuestionLabels: ['reviewer-go-or-hold-label-question', 'accepted-rejected-deferred-question'],
        holdTriggerLabels: ['missing-independent-reviewer-verdict', 'acceptance-claims-production-ready'],
      },
      {
        id: 'boundary-review',
        label: 'O4/O5 and exposure boundary labels',
        sourceLabels: ['o4-open-deferred-label', 'o5-open-deferred-label', 'filecustodian-reference-harness-label', 'local-socket-only-label'],
        reviewerQuestionLabels: ['o4-remains-open-question', 'o5-remains-open-question', 'no-tcp-http-lan-question'],
        holdTriggerLabels: ['o4-closed-claim', 'o5-closed-claim', 'tcp-http-lan-exposure-claim', 'filecustodian-production-kms-claim'],
      },
    ],
    reviewerInstructions: [
      'Review labels and fixed booleans only.',
      'Return GO only when the review summary and acceptance preflight are ready and no hold trigger is present.',
      'Return HOLD if any packet claims production readiness, service installation, provider mode, O4 closure, or O5 closure.',
      'Do not request raw logs, command output, secret paths, provider payloads, media identity, socket paths, or artifact contents.',
    ],
    requiredVerdictLabels: ['reviewer-go-label', 'reviewer-hold-label', 'required-change-label', 'residual-risk-label'],
    forbiddenMaterial: [
      'secret values',
      'credential contents or paths',
      'KEKs, DEKs, wrapping keys, private keys, or completion secrets',
      'database URLs',
      'raw environment dumps',
      'socket paths containing host-specific secrets',
      'request or response bodies',
      'provider payloads',
      'raw provider refs',
      'media titles or user library identity',
      'backup contents',
      'artifact contents',
      'raw logs',
      'actual evidence values',
    ],
    explicitNonGoals: [
      'No launch approval.',
      'No production-readiness approval.',
      'No service install approval.',
      'No provider mode.',
      'No O4 closure.',
      'No O5 closure.',
      'No DB reads or writes.',
      'No network calls or live service contact.',
      'No Docker, Compose, boot script, scheduler, provider adapter, media-server workflow, playback, downloading, scraping, API framework, or web UI expansion.',
    ],
  };
}

export function formatSidecarUnraidReviewHandoffJson(
  handoff: SidecarUnraidReviewHandoff = buildSidecarUnraidReviewHandoff(),
): string {
  return `${JSON.stringify(handoff, null, 2)}\n`;
}

export function formatSidecarUnraidReviewHandoffText(
  handoff: SidecarUnraidReviewHandoff = buildSidecarUnraidReviewHandoff(),
): string {
  const lines = [
    'Phase 111 sidecar Unraid review handoff',
    `code: ${handoff.code}`,
    `status: ${handoff.status}`,
    `launchApproved: ${handoff.launchApproved ? 'true' : 'false'}`,
    `productionReady: ${handoff.productionReady ? 'true' : 'false'}`,
    `serviceInstallApproved: ${handoff.serviceInstallApproved ? 'true' : 'false'}`,
    `providerModeEnabled: ${handoff.providerModeEnabled ? 'true' : 'false'}`,
    `closesO4: ${handoff.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${handoff.closesO5 ? 'true' : 'false'}`,
    '',
    'Handoff sections:',
  ];
  for (const section of handoff.handoffSections) {
    lines.push(`- ${section.id}: ${section.label}`);
    for (const label of section.sourceLabels) lines.push(`  source: ${label}`);
    for (const label of section.reviewerQuestionLabels) lines.push(`  question: ${label}`);
    for (const label of section.holdTriggerLabels) lines.push(`  hold: ${label}`);
  }
  lines.push('', 'Reviewer instructions:');
  for (const instruction of handoff.reviewerInstructions) lines.push(`- ${instruction}`);
  lines.push('', 'Required verdict labels:');
  for (const label of handoff.requiredVerdictLabels) lines.push(`- ${label}`);
  lines.push('', 'Forbidden material:');
  for (const item of handoff.forbiddenMaterial) lines.push(`- ${item}`);
  lines.push('', 'Explicit non-goals:');
  for (const item of handoff.explicitNonGoals) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}
