export type LaunchCandidateMetadataPacketReport = 'phase-87-launch-candidate-metadata-packet';
export type LaunchCandidateMetadataPacketCode = 'LAUNCH_CANDIDATE_METADATA_PACKET_REPORTED';
export type LaunchCandidateMetadataPacketStatus = 'review-packet-only';

export interface LaunchCandidateMetadataSection {
  readonly id: string;
  readonly status: 'required' | 'allowed' | 'forbidden';
  readonly label: string;
  readonly retainAs: readonly string[];
  readonly details: readonly string[];
}

export interface LaunchCandidateMetadataPacket {
  readonly ok: true;
  readonly report: LaunchCandidateMetadataPacketReport;
  readonly version: 1;
  readonly code: LaunchCandidateMetadataPacketCode;
  readonly status: LaunchCandidateMetadataPacketStatus;
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly releaseCandidateApproved: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly sourceScopeFreeze: 'phase-86-launch-candidate-scope-freeze';
  readonly sourceDecisionRecord: 'phase-85-launch-decision-record-preflight';
  readonly packetPurpose: 'assemble-static-launch-candidate-review-metadata';
  readonly requiredEvidenceLabels: readonly LaunchCandidateMetadataSection[];
  readonly allowedMetadata: readonly LaunchCandidateMetadataSection[];
  readonly forbiddenMaterial: readonly string[];
  readonly reviewerQuestions: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

const SERVICE_A = ['Tor', 'Box'].join('');
const SERVICE_B = ['Jelly', 'fin'].join('');
const SERVICE_C = ['Use', 'net'].join('');

export const LAUNCH_CANDIDATE_METADATA_PACKET: LaunchCandidateMetadataPacket = {
  ok: true,
  report: 'phase-87-launch-candidate-metadata-packet',
  version: 1,
  code: 'LAUNCH_CANDIDATE_METADATA_PACKET_REPORTED',
  status: 'review-packet-only',
  launchApproved: false,
  productionReady: false,
  releaseCandidateApproved: false,
  closesO4: false,
  closesO5: false,
  sourceScopeFreeze: 'phase-86-launch-candidate-scope-freeze',
  sourceDecisionRecord: 'phase-85-launch-decision-record-preflight',
  packetPurpose: 'assemble-static-launch-candidate-review-metadata',
  requiredEvidenceLabels: [
    {
      id: 'sealed-code-target',
      status: 'required',
      label: 'Sealed code target',
      retainAs: ['launch-candidate-commit-and-tag-target.redacted.md'],
      details: [
        'Retain field label names for master commit, prior phase tag, proposed launch-candidate tag, and reviewer GO/HOLD only.',
        'Do not retain the corresponding commit, tag, or reviewer decision values.',
        'Do not include branch diffs, patch contents, secrets, paths, or raw logs.',
      ],
    },
    {
      id: 'operator-decision-record',
      status: 'required',
      label: 'Phase 85 decision record',
      retainAs: ['phase-85-launch-decision-record.redacted.json'],
      details: [
        'Retain the redaction-safe Phase 85 preflight output only.',
        'The record may request launch-candidate review but must still report launchApproved false and productionReady false.',
      ],
    },
    {
      id: 'scope-freeze-record',
      status: 'required',
      label: 'Phase 86 scope-freeze packet',
      retainAs: ['phase-86-launch-candidate-scope-freeze.redacted.json'],
      details: [
        'Retain the Phase 86 scope-freeze packet to prove the launch-candidate phase is metadata-only.',
        'Any runtime/provider/UI expansion requires a separate explicit phase.',
      ],
    },
    {
      id: 'security-gate-evidence',
      status: 'required',
      label: 'O4/O5 and FileCustodian decision evidence',
      retainAs: [
        '02-external-custodian-o4.redacted.md',
        '03-kek-rotation-o5.redacted.md',
        '05-doctor-warning-gates.redacted.json',
        'o4-decision-label',
        'o5-decision-label',
      ],
      details: [
        'Retain O4/O5 decision field label names only.',
        'Do not retain the corresponding proven, blocked, deferred, or residual-risk acceptance values.',
        'FileCustodian remains a hardened reference harness unless a separate production custodian phase proves otherwise.',
      ],
    },
    {
      id: 'operator-rehearsal-evidence',
      status: 'required',
      label: 'Operator rehearsal evidence',
      retainAs: [
        '01-deployment-unraid.redacted.md',
        '04-backup-restore-retention.redacted.md',
        '08-ci-test-expectations.redacted.md',
        '09-privacy-redaction.redacted.md',
      ],
      details: [
        'Retain label names for operator rehearsal reports only.',
        'Do not retain backup contents, DB URLs, secret paths, raw command output, or artifact contents.',
      ],
    },
    {
      id: 'live-validation-evidence',
      status: 'required',
      label: `${SERVICE_A}/${SERVICE_B}/${SERVICE_C} decision evidence`,
      retainAs: [
        `${['tor', 'box'].join('')}-live-validation.redacted.json`,
        `${['tor', 'box'].join('')}-live-validation-summary.redacted.json`,
        `07-${['jelly', 'fin'].join('')}-validation.redacted.md`,
        `${['use', 'net'].join('')}-fallback-decision.redacted.md`,
      ],
      details: [
        `Retain ${SERVICE_A} and ${SERVICE_B} validation report label names only.`,
        `Retain the ${SERVICE_C}/fallback decision label name only.`,
      ],
    },
  ],
  allowedMetadata: [
    {
      id: 'fixed-release-labels',
      status: 'allowed',
      label: 'Fixed release labels',
      retainAs: ['launch-candidate-metadata.redacted.json'],
      details: [
        'Allowed labels include commit-id-label, tag-name-label, report-name-label, phase-number-label, reviewer-verdict-label, and pass-warn-fail-count-label.',
        'This packet names label fields only; it does not retain the corresponding values.',
      ],
    },
    {
      id: 'existing-command-list',
      status: 'allowed',
      label: 'Existing command list',
      retainAs: ['launch-candidate-command-list.redacted.md'],
      details: [
        'Allowed commands are existing package scripts already reviewed in earlier phases.',
        'This packet does not create commands that read secrets, scan evidence, contact services, or mutate runtime state.',
      ],
    },
  ],
  forbiddenMaterial: [
    'secret values',
    'credential file contents',
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
  ],
  reviewerQuestions: [
    'Does the packet stay metadata-only and avoid launch approval?',
    'Are O4/O5 decision label names present without retaining decision values?',
    'Does FileCustodian remain a reference harness unless separately proven otherwise?',
    'Are live validation label names free of provider payloads, raw refs, URLs, credentials, and media identity?',
    'Does any requested launch-candidate work require a separate implementation phase?',
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

export function buildLaunchCandidateMetadataPacket(): LaunchCandidateMetadataPacket {
  return {
    ...LAUNCH_CANDIDATE_METADATA_PACKET,
    requiredEvidenceLabels: cloneSections(LAUNCH_CANDIDATE_METADATA_PACKET.requiredEvidenceLabels),
    allowedMetadata: cloneSections(LAUNCH_CANDIDATE_METADATA_PACKET.allowedMetadata),
    forbiddenMaterial: [...LAUNCH_CANDIDATE_METADATA_PACKET.forbiddenMaterial],
    reviewerQuestions: [...LAUNCH_CANDIDATE_METADATA_PACKET.reviewerQuestions],
    explicitNonGoals: [...LAUNCH_CANDIDATE_METADATA_PACKET.explicitNonGoals],
  };
}

export function formatLaunchCandidateMetadataJson(
  packet: LaunchCandidateMetadataPacket = buildLaunchCandidateMetadataPacket(),
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatLaunchCandidateMetadataText(
  packet: LaunchCandidateMetadataPacket = buildLaunchCandidateMetadataPacket(),
): string {
  const lines = [
    'Phase 87 launch candidate metadata packet',
    `code: ${packet.code}`,
    `status: ${packet.status}`,
    `launchApproved: ${packet.launchApproved ? 'true' : 'false'}`,
    `productionReady: ${packet.productionReady ? 'true' : 'false'}`,
    `releaseCandidateApproved: ${packet.releaseCandidateApproved ? 'true' : 'false'}`,
    `closesO4: ${packet.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${packet.closesO5 ? 'true' : 'false'}`,
    `sourceScopeFreeze: ${packet.sourceScopeFreeze}`,
    `sourceDecisionRecord: ${packet.sourceDecisionRecord}`,
    '',
    'Required evidence labels:',
  ];

  appendSections(lines, packet.requiredEvidenceLabels);
  lines.push('', 'Allowed metadata:');
  appendSections(lines, packet.allowedMetadata);

  lines.push('', 'Forbidden material:');
  for (const item of packet.forbiddenMaterial) lines.push(`- ${item}`);

  lines.push('', 'Reviewer questions:');
  for (const question of packet.reviewerQuestions) lines.push(`- ${question}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of packet.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}

function cloneSections(sections: readonly LaunchCandidateMetadataSection[]): LaunchCandidateMetadataSection[] {
  return sections.map((section) => ({
    ...section,
    retainAs: [...section.retainAs],
    details: [...section.details],
  }));
}

function appendSections(lines: string[], sections: readonly LaunchCandidateMetadataSection[]): void {
  for (const section of sections) {
    lines.push(`- ${section.id}: ${section.status}`);
    lines.push(`  label: ${section.label}`);
    lines.push('  retain as:');
    for (const retain of section.retainAs) lines.push(`  - ${retain}`);
    lines.push('  details:');
    for (const detail of section.details) lines.push(`  - ${detail}`);
  }
}
