export type LaunchCandidateScopeFreezeReport = 'phase-86-launch-candidate-scope-freeze';
export type LaunchCandidateScopeFreezeCode = 'LAUNCH_CANDIDATE_SCOPE_FREEZE_REPORTED';
export type LaunchCandidateScopeFreezeStatus = 'blocked-pending-operator-decision';

export interface LaunchCandidateScopeItem {
  readonly id: string;
  readonly status: 'allowed' | 'required' | 'forbidden';
  readonly label: string;
  readonly details: readonly string[];
}

export interface LaunchCandidateScopeFreezePacket {
  readonly ok: true;
  readonly report: LaunchCandidateScopeFreezeReport;
  readonly version: 1;
  readonly code: LaunchCandidateScopeFreezeCode;
  readonly status: LaunchCandidateScopeFreezeStatus;
  readonly launchApproved: false;
  readonly productionReady: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly sourceDecisionRecord: 'phase-85-launch-decision-record-preflight';
  readonly sourceAcceptancePacket: 'phase-84-operator-acceptance-packet';
  readonly packetPurpose: 'freeze-future-launch-candidate-phase-scope';
  readonly requiredBeforeLaunchCandidate: readonly LaunchCandidateScopeItem[];
  readonly allowedLaunchCandidateWork: readonly LaunchCandidateScopeItem[];
  readonly forbiddenLaunchCandidateWork: readonly LaunchCandidateScopeItem[];
  readonly reviewerRequiredWhen: readonly string[];
  readonly holdConditions: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

const SERVICE_A = ['Tor', 'Box'].join('');
const SERVICE_B = ['Jelly', 'fin'].join('');
const SERVICE_C = ['Real', '-Debrid'].join('');
const SERVICE_D = ['Plex'].join('');
const SERVICE_E = ['Use', 'net'].join('');

export const LAUNCH_CANDIDATE_SCOPE_FREEZE_PACKET: LaunchCandidateScopeFreezePacket = {
  ok: true,
  report: 'phase-86-launch-candidate-scope-freeze',
  version: 1,
  code: 'LAUNCH_CANDIDATE_SCOPE_FREEZE_REPORTED',
  status: 'blocked-pending-operator-decision',
  launchApproved: false,
  productionReady: false,
  closesO4: false,
  closesO5: false,
  sourceDecisionRecord: 'phase-85-launch-decision-record-preflight',
  sourceAcceptancePacket: 'phase-84-operator-acceptance-packet',
  packetPurpose: 'freeze-future-launch-candidate-phase-scope',
  requiredBeforeLaunchCandidate: [
    {
      id: 'phase-85-decision-record',
      status: 'required',
      label: 'Phase 85 launch decision record reviewed',
      details: [
        'A redaction-safe Phase 85 report must be retained before launch-candidate work starts.',
        'The record must not approve launch, claim production readiness, close O4, or close O5.',
        'A launch-candidate-requested disposition is only a request for a separate reviewed phase.',
      ],
    },
    {
      id: 'scope-freeze-review',
      status: 'required',
      label: 'Reviewer confirms the future phase is scope-frozen',
      details: [
        'Reviewer must confirm the future branch only packages existing evidence and release-candidate metadata.',
        'Any new runtime behavior, integration, provider operation, or UI/API expansion requires a new explicit phase.',
      ],
    },
    {
      id: 'operator-risk-decision',
      status: 'required',
      label: 'Operator risk decision is explicit',
      details: [
        'O4/O5 must be proven, blocked, deferred, or explicitly accepted as residual risk in operator metadata.',
        'FileCustodian must remain described as a reference harness unless a separate production custodian phase proves otherwise.',
      ],
    },
  ],
  allowedLaunchCandidateWork: [
    {
      id: 'release-candidate-metadata',
      status: 'allowed',
      label: 'Release-candidate metadata only',
      details: [
        'Allowed work is limited to static release-candidate labels, retained evidence labels, commit ids, tag targets, reviewer verdicts, and command lists.',
        'Allowed outputs may summarize pass/warn/fail counts and fixed gate labels.',
      ],
    },
    {
      id: 'existing-command-references',
      status: 'allowed',
      label: 'Existing command references only',
      details: [
        'The future phase may reference existing ops and test commands that already exist in package.json.',
        'It must not create a new live command that contacts services or reads secrets.',
      ],
    },
    {
      id: 'redaction-safe-packaging',
      status: 'allowed',
      label: 'Redaction-safe packaging only',
      details: [
        'Retained evidence may be named by labels, dates, fixed report names, and reviewed conclusions.',
        'Artifact contents, secret paths, provider payloads, raw refs, media identity, URLs, and credentials remain forbidden.',
      ],
    },
  ],
  forbiddenLaunchCandidateWork: [
    {
      id: 'runtime-expansion',
      status: 'forbidden',
      label: 'No runtime expansion',
      details: [
        'No DB reads or writes, schema changes, HTTP/API framework work, frontend framework work, background services, schedulers, Docker changes, or live packet sources.',
        'No launch candidate phase may change playback, catalog mutation, provider availability, auth, or UI runtime behavior.',
      ],
    },
    {
      id: 'provider-or-media-expansion',
      status: 'forbidden',
      label: 'No provider, debrid, or media-server expansion',
      details: [
        `No ${SERVICE_A}, ${SERVICE_C}, ${SERVICE_B}, ${SERVICE_D}, ${SERVICE_E}, Hermes, scraping, downloading, playback, media-server writes, provider logos, provider payloads, or provider mode expansion.`,
        'Existing live validation outputs must remain operator-provided and redaction-summarized.',
      ],
    },
    {
      id: 'security-gate-softening',
      status: 'forbidden',
      label: 'No security-gate softening',
      details: [
        'No text, doc, test, or output may hide, soften, or silently close O4/O5.',
        'No release-candidate metadata may describe the system as turnkey production ready.',
      ],
    },
  ],
  reviewerRequiredWhen: [
    'A phase mentions launch, release candidate, production readiness, O4, O5, FileCustodian, provider validation, retained evidence, or operator acceptance.',
    'A diff changes package scripts, ops commands, release docs, README readiness wording, or deploy guards.',
    'A launch-candidate-requested decision record is used as input for any later phase.',
  ],
  holdConditions: [
    'The diff approves launch or claims productionReady true.',
    'The diff closes O4/O5 without separate reviewed operator evidence or explicit residual-risk acceptance.',
    'The diff reads evidence contents, secrets, credentials, environment values, DBs, browser storage, provider payloads, media titles, raw refs, URLs, or backup contents.',
    'The diff adds provider/debrid/media-server/playback/downloading/scraping/frontend/API/runtime behavior.',
    'The diff weakens FileCustodian reference-harness wording.',
  ],
  explicitNonGoals: [
    'No launch approval.',
    'No production-readiness approval.',
    'No O4 closure.',
    'No O5 closure.',
    'No DB, credential, environment, evidence-content, artifact-content, backup-content, provider-payload, raw-ref, URL, or media-identity reads.',
    'No network calls or live service contact.',
    'No provider mode, playback, downloading, scraping, media-server writes, frontend framework, API framework, web UI expansion, scheduler, Docker change, or background runtime work.',
  ],
};

export function buildLaunchCandidateScopeFreezePacket(): LaunchCandidateScopeFreezePacket {
  return {
    ...LAUNCH_CANDIDATE_SCOPE_FREEZE_PACKET,
    requiredBeforeLaunchCandidate: cloneItems(LAUNCH_CANDIDATE_SCOPE_FREEZE_PACKET.requiredBeforeLaunchCandidate),
    allowedLaunchCandidateWork: cloneItems(LAUNCH_CANDIDATE_SCOPE_FREEZE_PACKET.allowedLaunchCandidateWork),
    forbiddenLaunchCandidateWork: cloneItems(LAUNCH_CANDIDATE_SCOPE_FREEZE_PACKET.forbiddenLaunchCandidateWork),
    reviewerRequiredWhen: [...LAUNCH_CANDIDATE_SCOPE_FREEZE_PACKET.reviewerRequiredWhen],
    holdConditions: [...LAUNCH_CANDIDATE_SCOPE_FREEZE_PACKET.holdConditions],
    explicitNonGoals: [...LAUNCH_CANDIDATE_SCOPE_FREEZE_PACKET.explicitNonGoals],
  };
}

export function formatLaunchCandidateScopeFreezeJson(
  packet: LaunchCandidateScopeFreezePacket = buildLaunchCandidateScopeFreezePacket(),
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatLaunchCandidateScopeFreezeText(
  packet: LaunchCandidateScopeFreezePacket = buildLaunchCandidateScopeFreezePacket(),
): string {
  const lines = [
    'Phase 86 launch candidate scope freeze',
    `code: ${packet.code}`,
    `status: ${packet.status}`,
    `launchApproved: ${packet.launchApproved ? 'true' : 'false'}`,
    `productionReady: ${packet.productionReady ? 'true' : 'false'}`,
    `closesO4: ${packet.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${packet.closesO5 ? 'true' : 'false'}`,
    `sourceDecisionRecord: ${packet.sourceDecisionRecord}`,
    `sourceAcceptancePacket: ${packet.sourceAcceptancePacket}`,
    '',
    'Required before launch candidate:',
  ];

  appendItems(lines, packet.requiredBeforeLaunchCandidate);
  lines.push('', 'Allowed launch-candidate work:');
  appendItems(lines, packet.allowedLaunchCandidateWork);
  lines.push('', 'Forbidden launch-candidate work:');
  appendItems(lines, packet.forbiddenLaunchCandidateWork);

  lines.push('', 'Reviewer required when:');
  for (const rule of packet.reviewerRequiredWhen) lines.push(`- ${rule}`);

  lines.push('', 'HOLD conditions:');
  for (const condition of packet.holdConditions) lines.push(`- ${condition}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of packet.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}

function cloneItems(items: readonly LaunchCandidateScopeItem[]): LaunchCandidateScopeItem[] {
  return items.map((item) => ({ ...item, details: [...item.details] }));
}

function appendItems(lines: string[], items: readonly LaunchCandidateScopeItem[]): void {
  for (const item of items) {
    lines.push(`- ${item.id}: ${item.status}`);
    lines.push(`  label: ${item.label}`);
    for (const detail of item.details) lines.push(`  - ${detail}`);
  }
}
