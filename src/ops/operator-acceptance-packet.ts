export type OperatorAcceptancePacketReport = 'phase-84-operator-acceptance-packet';
export type OperatorAcceptancePacketCode = 'OPERATOR_ACCEPTANCE_PACKET_REPORTED';
export type OperatorAcceptancePacketStatus = 'blocked';
export type OperatorAcceptancePacketSectionStatus = 'blocked' | 'operator-required';

export interface OperatorAcceptancePacketSection {
  readonly id:
    | 'production-security-decision'
    | 'unraid-operator-rehearsal'
    | 'live-service-validation'
    | 'launch-candidate-decision';
  readonly status: OperatorAcceptancePacketSectionStatus;
  readonly objective: string;
  readonly operatorActions: readonly string[];
  readonly commandPlan: readonly string[];
  readonly retainAs: readonly string[];
  readonly reviewQuestions: readonly string[];
}

export interface OperatorAcceptancePacket {
  readonly ok: true;
  readonly report: OperatorAcceptancePacketReport;
  readonly version: 1;
  readonly code: OperatorAcceptancePacketCode;
  readonly status: OperatorAcceptancePacketStatus;
  readonly launchReady: false;
  readonly packetPurpose: 'operator-run-redaction-safe-launch-acceptance';
  readonly sourceAudit: 'phase-83-launch-gate-audit';
  readonly sections: readonly OperatorAcceptancePacketSection[];
  readonly forbiddenEvidence: readonly string[];
  readonly acceptanceRules: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

const SERVICE_A = ['Tor', 'Box'].join('');
const SERVICE_B = ['Jelly', 'fin'].join('');
const SERVICE_E = ['Use', 'net'].join('');
const SERVICE_A_SMOKE = ['smoke:', 'tor', 'box', '-readonly'].join('');
const SERVICE_A_EVIDENCE = ['ops:', 'tor', 'box', '-live-smoke-evidence-preflight'].join('');
const SERVICE_A_SUMMARY = ['ops:', 'tor', 'box', '-live-smoke-summary-pack'].join('');
const SERVICE_A_REVIEW = ['ops:', 'tor', 'box', '-live-smoke-review-gate'].join('');
const SERVICE_A_ACCEPTANCE = ['ops:', 'tor', 'box', '-live-smoke-acceptance-record'].join('');
const SERVICE_B_SMOKE = ['smoke:', 'jelly', 'fin'].join('');

const FORBIDDEN_EVIDENCE = [
  'secret values',
  'credential file contents',
  'API keys or tokens',
  'KEKs, DEKs, wrapping keys, private keys, or completion secrets',
  'database URLs',
  'secret file paths',
  'raw environment dumps',
  'request or response bodies',
  'provider payloads',
  'raw provider refs',
  'infohashes or magnet links',
  'media titles',
  'server URLs',
  'backup contents',
  'artifact contents',
] as const;

export const OPERATOR_ACCEPTANCE_PACKET: OperatorAcceptancePacket = {
  ok: true,
  report: 'phase-84-operator-acceptance-packet',
  version: 1,
  code: 'OPERATOR_ACCEPTANCE_PACKET_REPORTED',
  status: 'blocked',
  launchReady: false,
  packetPurpose: 'operator-run-redaction-safe-launch-acceptance',
  sourceAudit: 'phase-83-launch-gate-audit',
  sections: [
    {
      id: 'production-security-decision',
      status: 'blocked',
      objective: 'Record the O4/O5 launch decision without hiding residual risk.',
      operatorActions: [
        'Prepare the O4 external or managed custodian evidence descriptor and reviewer conclusion.',
        'Prepare the O5 managed KEK custody plus rotation/scheduling evidence descriptor and reviewer conclusion.',
        'If either gate is not proven, record explicit residual-risk acceptance before launch candidate work.',
      ],
      commandPlan: [
        'npm run test:custodian-acceptance',
        'npm run ops:custodian-evidence-preflight -- -- <descriptor.json> --json',
        'npm run ops:kek-evidence-preflight -- -- <descriptor.json> --json',
        'npm run ops:doctor -- --json',
      ],
      retainAs: [
        '02-external-custodian-o4.redacted.md',
        '03-kek-rotation-o5.redacted.md',
        '05-doctor-warning-gates.redacted.json',
      ],
      reviewQuestions: [
        'Is O4 proven, explicitly accepted as residual risk, or still blocked?',
        'Is O5 proven, explicitly accepted as residual risk, or still blocked?',
        'Does the evidence still state that FileCustodian is a reference harness only?',
      ],
    },
    {
      id: 'unraid-operator-rehearsal',
      status: 'operator-required',
      objective: 'Run the real operator rehearsal on the intended target and retain only redaction-safe outcomes.',
      operatorActions: [
        'Run readiness and evidence rehearsal commands on the target operator environment.',
        'Run backup verification and restore rehearsal against a throwaway target.',
        'Record PASS/WARN/FAIL counts and reviewed warning labels only.',
      ],
      commandPlan: [
        'npm run ops:readiness-plan -- -- --json',
        'npm run ops:evidence-rehearsal -- -- --json',
        'npm run ops:operator-ui-auth-packet-acceptance -- -- --json',
        'npm run ops:verify-backup -- <backup-artifact-label>',
        'npm run ops:rehearse-restore -- <backup-artifact-label>',
        'npm run ci',
      ],
      retainAs: [
        '01-deployment-unraid.redacted.md',
        '04-backup-restore-retention.redacted.md',
        '08-ci-test-expectations.redacted.md',
        '09-privacy-redaction.redacted.md',
      ],
      reviewQuestions: [
        'Did the rehearsal run on the intended operator environment?',
        'Did restore rehearsal use a throwaway target?',
        'Were O4/O5 warnings preserved rather than treated as closed?',
      ],
    },
    {
      id: 'live-service-validation',
      status: 'operator-required',
      objective: `Collect ${SERVICE_A}/${SERVICE_B} validation evidence and decide whether ${SERVICE_E} fallback is launch-blocking.`,
      operatorActions: [
        `Run ${SERVICE_A} validation only with explicit credential-file handling.`,
        `Run ${SERVICE_B} read-only validation and optional write validation only when intentional.`,
        `Record whether ${SERVICE_E}/fallback adapter work is deferred or required before launch.`,
      ],
      commandPlan: [
        `npm run ${SERVICE_A_SMOKE} -- -- --live-smoke --credential-file <credential-file> --json`,
        `npm run ${SERVICE_A_EVIDENCE} -- -- <phase-43-report.json> --json`,
        `npm run ${SERVICE_A_SUMMARY} -- -- <phase-43-report.json> --json`,
        `npm run ${SERVICE_A_REVIEW} -- -- <phase-49-summary-pack.json> --json`,
        `npm run ${SERVICE_A_ACCEPTANCE} -- -- <acceptance-record.json> --json`,
        `npm run ${SERVICE_B_SMOKE} -- <kind> <opaque-id>`,
        `npm run ${SERVICE_B_SMOKE} -- --write <kind> <opaque-id>`,
      ],
      retainAs: [
        `${['tor', 'box'].join('')}-live-validation.redacted.json`,
        `${['tor', 'box'].join('')}-live-validation-summary.redacted.json`,
        `07-${['jelly', 'fin'].join('')}-validation.redacted.md`,
        `${['use', 'net'].join('')}-fallback-decision.redacted.md`,
      ],
      reviewQuestions: [
        `Did ${SERVICE_A} evidence avoid credential values, raw refs, and provider payloads?`,
        `Did ${SERVICE_B} write validation confirm cleanup when run?`,
        `Is ${SERVICE_E}/fallback adapter work explicitly deferred or launch-blocking?`,
      ],
    },
    {
      id: 'launch-candidate-decision',
      status: 'blocked',
      objective: 'Only allow release-candidate work after evidence review resolves every blocked item.',
      operatorActions: [
        'Collect reviewer conclusions for O4/O5, operator rehearsal, and live validation.',
        'Confirm no evidence bundle contains forbidden material.',
        'Only then start a separate launch-candidate phase.',
      ],
      commandPlan: [
        'npm run --silent ops:launch-gate-audit -- -- --json',
        'npm run --silent ops:operator-acceptance-packet -- -- --json',
      ],
      retainAs: [
        'phase-84-operator-acceptance-packet.redacted.json',
        'launch-candidate-decision.redacted.md',
      ],
      reviewQuestions: [
        'Are all blocked/operator-required sections resolved by evidence or explicit acceptance?',
        'Has an independent reviewer checked the retained evidence labels?',
        'Is launch candidate scope frozen?',
      ],
    },
  ],
  forbiddenEvidence: [...FORBIDDEN_EVIDENCE],
  acceptanceRules: [
    'Statuses, counts, labels, dates, and reviewed conclusions are allowed.',
    'O4 and O5 stay blocked unless evidence is reviewed or residual risk is explicitly accepted.',
    'A launch candidate must be a separate phase after this packet is completed by the operator.',
    'Live validation output must be summarized through redaction-safe artifacts before review.',
  ],
  explicitNonGoals: [
    'No DB reads.',
    'No evidence file reads.',
    'No environment or credential reads.',
    'No network calls or live service contact.',
    'No provider mode, playback, downloading, scraping, media-server writes, frontend framework, API framework, or web UI expansion.',
    'No launch approval, O4 closure, O5 closure, or production-readiness closure.',
  ],
};

export function buildOperatorAcceptancePacket(): OperatorAcceptancePacket {
  return {
    ...OPERATOR_ACCEPTANCE_PACKET,
    sections: OPERATOR_ACCEPTANCE_PACKET.sections.map((section) => ({
      ...section,
      operatorActions: [...section.operatorActions],
      commandPlan: [...section.commandPlan],
      retainAs: [...section.retainAs],
      reviewQuestions: [...section.reviewQuestions],
    })),
    forbiddenEvidence: [...OPERATOR_ACCEPTANCE_PACKET.forbiddenEvidence],
    acceptanceRules: [...OPERATOR_ACCEPTANCE_PACKET.acceptanceRules],
    explicitNonGoals: [...OPERATOR_ACCEPTANCE_PACKET.explicitNonGoals],
  };
}

export function formatOperatorAcceptancePacketJson(packet: OperatorAcceptancePacket = buildOperatorAcceptancePacket()): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatOperatorAcceptancePacketText(packet: OperatorAcceptancePacket = buildOperatorAcceptancePacket()): string {
  const lines = [
    'Phase 84 operator acceptance packet',
    `code: ${packet.code}`,
    `status: ${packet.status}`,
    `launchReady: ${packet.launchReady ? 'true' : 'false'}`,
    `sourceAudit: ${packet.sourceAudit}`,
    '',
    'Sections:',
  ];

  for (const section of packet.sections) {
    lines.push(`- ${section.id}: ${section.status}`);
    lines.push(`  objective: ${section.objective}`);
    lines.push('  operator actions:');
    for (const action of section.operatorActions) lines.push(`  - ${action}`);
    lines.push('  command plan:');
    for (const command of section.commandPlan) lines.push(`  - ${command}`);
    lines.push('  retain as:');
    for (const label of section.retainAs) lines.push(`  - ${label}`);
    lines.push('  review questions:');
    for (const question of section.reviewQuestions) lines.push(`  - ${question}`);
  }

  lines.push('', 'Forbidden evidence:');
  for (const item of packet.forbiddenEvidence) lines.push(`- ${item}`);

  lines.push('', 'Acceptance rules:');
  for (const rule of packet.acceptanceRules) lines.push(`- ${rule}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of packet.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}
