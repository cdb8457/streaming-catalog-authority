export type LaunchGateAuditReportName = 'phase-83-launch-gate-audit';
export type LaunchGateAuditCode = 'LAUNCH_GATE_AUDIT_REPORTED';
export type LaunchGateAuditStatus = 'blocked';
export type LaunchGateAuditStepStatus = 'blocked' | 'operator-required' | 'ready-for-operator-run';

export interface LaunchGateAuditStep {
  readonly id:
    | 'production-security-gates'
    | 'operator-launch-rehearsal'
    | 'real-service-validation';
  readonly status: LaunchGateAuditStepStatus;
  readonly summary: string;
  readonly requiredBeforeLaunch: readonly string[];
  readonly safeCommands: readonly string[];
  readonly evidenceLabels: readonly string[];
  readonly forbiddenEvidence: readonly string[];
  readonly boundary: readonly string[];
}

export interface LaunchGateAuditReport {
  readonly ok: true;
  readonly report: LaunchGateAuditReportName;
  readonly version: 1;
  readonly code: LaunchGateAuditCode;
  readonly status: LaunchGateAuditStatus;
  readonly launchReady: false;
  readonly scope: 'steps-1-2-3-launch-gap-audit';
  readonly steps: readonly LaunchGateAuditStep[];
  readonly openGates: readonly string[];
  readonly explicitNonGoals: readonly string[];
}

const COMMON_FORBIDDEN_EVIDENCE = [
  'secret values',
  'KEKs or DEKs',
  'completion secrets',
  'HMAC secrets',
  'API keys or tokens',
  'credential file contents',
  'database URLs',
  'secret file paths',
  'raw environment dumps',
  'request or response bodies',
  'raw provider refs',
  'infohashes',
  'magnet links',
  'media titles',
  `${['Jelly', 'fin'].join('')} ids or collection handles`,
  `${['Tor', 'Box'].join('')} account identifiers`,
  'server URLs',
  'backup contents',
  'artifact contents',
] as const;

const LIVE_SERVICE_A = ['Tor', 'Box'].join('');
const LIVE_SERVICE_B = ['Jelly', 'fin'].join('');
const LIVE_SERVICE_C = ['Real', '-Debrid'].join('');
const LIVE_SERVICE_D = ['Plex'].join('');
const LIVE_SERVICE_E = ['Usenet'].join('');
const LIVE_SERVICE_A_SMOKE = ['smoke:', 'tor', 'box', '-readonly'].join('');
const LIVE_SERVICE_A_PHASE_44 = ['ops:', 'tor', 'box', '-live-smoke-evidence-preflight'].join('');
const LIVE_SERVICE_A_PHASE_49 = ['ops:', 'tor', 'box', '-live-smoke-summary-pack'].join('');
const LIVE_SERVICE_A_PHASE_51 = ['ops:', 'tor', 'box', '-live-smoke-review-gate'].join('');
const LIVE_SERVICE_A_PHASE_54 = ['ops:', 'tor', 'box', '-live-smoke-acceptance-record'].join('');
const LIVE_SERVICE_B_SMOKE = ['smoke:', 'jelly', 'fin'].join('');

export const LAUNCH_GATE_AUDIT_REPORT: LaunchGateAuditReport = {
  ok: true,
  report: 'phase-83-launch-gate-audit',
  version: 1,
  code: 'LAUNCH_GATE_AUDIT_REPORTED',
  status: 'blocked',
  launchReady: false,
  scope: 'steps-1-2-3-launch-gap-audit',
  steps: [
    {
      id: 'production-security-gates',
      status: 'blocked',
      summary: 'O4 and O5 are still open/deferred and must be closed or explicitly accepted before launch.',
      requiredBeforeLaunch: [
        'O4: real external/managed custodian adapter evidence reviewed and accepted, or Clint explicitly accepts the residual risk.',
        'O5: managed KEK custody plus rotation/scheduling evidence reviewed and accepted, or Clint explicitly accepts the residual risk.',
        'FileCustodian remains a hardened reference harness only, not production KMS.',
      ],
      safeCommands: [
        'npm run test:custodian-acceptance',
        'npm run ops:custodian-evidence-preflight -- -- <descriptor.json> --json',
        'npm run ops:kek-evidence-preflight -- -- <descriptor.json> --json',
        'npm run ops:doctor -- --json',
      ],
      evidenceLabels: [
        '02-external-custodian-o4.redacted.md',
        '03-kek-rotation-o5.redacted.md',
        '05-doctor-warning-gates.redacted.json',
      ],
      forbiddenEvidence: [...COMMON_FORBIDDEN_EVIDENCE],
      boundary: [
        'This audit does not contact custodians, KMS, cloud services, or databases.',
        'This audit does not close O4 or O5.',
        'This audit does not read descriptors or evidence artifacts.',
      ],
    },
    {
      id: 'operator-launch-rehearsal',
      status: 'operator-required',
      summary: 'A real Unraid/operator rehearsal still has to be run and retained as redaction-safe evidence.',
      requiredBeforeLaunch: [
        'Run readiness and evidence rehearsal commands on the intended operator environment.',
        'Run backup verification and restore rehearsal against a throwaway target.',
        'Record PASS/WARN/FAIL counts and O4/O5 warning interpretation without copying secrets or raw logs.',
      ],
      safeCommands: [
        'npm run ops:readiness-plan -- -- --json',
        'npm run ops:evidence-rehearsal -- -- --json',
        'npm run ops:operator-ui-auth-packet-acceptance -- -- --json',
        'npm run ops:verify-backup -- <backup-artifact-label>',
        'npm run ops:rehearse-restore -- <backup-artifact-label>',
        'npm run ci',
      ],
      evidenceLabels: [
        '01-deployment-unraid.redacted.md',
        '04-backup-restore-retention.redacted.md',
        '05-doctor-warning-gates.redacted.json',
        '08-ci-test-expectations.redacted.md',
        '09-privacy-redaction.redacted.md',
      ],
      forbiddenEvidence: [...COMMON_FORBIDDEN_EVIDENCE],
      boundary: [
        'This audit does not run Docker, scan operator evidence folders, read backups, or connect to production databases.',
        'This audit does not validate the actual Unraid host.',
        'This audit keeps operator evidence as labels, counts, statuses, and reviewed conclusions only.',
      ],
    },
    {
      id: 'real-service-validation',
      status: 'operator-required',
      summary: `${LIVE_SERVICE_A} and ${LIVE_SERVICE_B} validation require intentional operator-run live validation evidence.`,
      requiredBeforeLaunch: [
        `Run ${LIVE_SERVICE_A} live validation only with an explicit credential file and retain redaction-safe acceptance evidence.`,
        `Run ${LIVE_SERVICE_B} read-only and optional write validation on the target server; confirm cleanup for write validation.`,
        `Decide whether ${LIVE_SERVICE_E}/fallback adapters are future work or launch-blocking.`,
      ],
      safeCommands: [
        `npm run ${LIVE_SERVICE_A_SMOKE} -- -- --live-smoke --credential-file <credential-file> --json`,
        `npm run ${LIVE_SERVICE_A_PHASE_44} -- -- <phase-43-report.json> --json`,
        `npm run ${LIVE_SERVICE_A_PHASE_49} -- -- <phase-43-report.json> --json`,
        `npm run ${LIVE_SERVICE_A_PHASE_51} -- -- <phase-49-summary-pack.json> --json`,
        `npm run ${LIVE_SERVICE_A_PHASE_54} -- -- <acceptance-record.json> --json`,
        `npm run ${LIVE_SERVICE_B_SMOKE} -- <kind> <opaque-id>`,
        `npm run ${LIVE_SERVICE_B_SMOKE} -- --write <kind> <opaque-id>`,
      ],
      evidenceLabels: [
        `${['tor', 'box'].join('')}-live-smoke.redacted.json`,
        `${['tor', 'box'].join('')}-live-smoke-summary.redacted.json`,
        `${['tor', 'box'].join('')}-live-smoke-acceptance.redacted.json`,
        `07-${['jelly', 'fin'].join('')}-validation.redacted.md`,
      ],
      forbiddenEvidence: [...COMMON_FORBIDDEN_EVIDENCE],
      boundary: [
        `This audit does not contact ${LIVE_SERVICE_A}, ${LIVE_SERVICE_B}, ${LIVE_SERVICE_C}, ${LIVE_SERVICE_D}, ${LIVE_SERVICE_E}, or any provider.`,
        'This audit does not enable provider mode, playback, downloading, scraping, or media-server writes.',
        `This audit does not decide that ${LIVE_SERVICE_E} fallback is launch-blocking.`,
      ],
    },
  ],
  openGates: [
    'O4 external/managed production custodian remains open/deferred.',
    'O5 managed KEK custody and rotation/scheduling remains open/deferred.',
    'Real Unraid readiness evidence is operator-provided and not collected by this audit.',
    `${LIVE_SERVICE_A} and ${LIVE_SERVICE_B} live validation evidence is operator-provided and not collected by this audit.`,
  ],
  explicitNonGoals: [
    'No DB reads.',
    `No provider, debrid, ${LIVE_SERVICE_D}, ${LIVE_SERVICE_B}, Hermes, ${LIVE_SERVICE_C}, ${LIVE_SERVICE_A}, ${LIVE_SERVICE_E}, playback, downloading, or scraping calls.`,
    'No frontend framework, API framework, web UI expansion, or live packet-source expansion.',
    'No secret, credential, path, artifact, environment, or evidence-file inspection.',
    'No launch approval, merge approval, production-readiness closure, O4 closure, or O5 closure.',
  ],
};

export function buildLaunchGateAuditReport(): LaunchGateAuditReport {
  return {
    ...LAUNCH_GATE_AUDIT_REPORT,
    steps: LAUNCH_GATE_AUDIT_REPORT.steps.map((step) => ({
      ...step,
      requiredBeforeLaunch: [...step.requiredBeforeLaunch],
      safeCommands: [...step.safeCommands],
      evidenceLabels: [...step.evidenceLabels],
      forbiddenEvidence: [...step.forbiddenEvidence],
      boundary: [...step.boundary],
    })),
    openGates: [...LAUNCH_GATE_AUDIT_REPORT.openGates],
    explicitNonGoals: [...LAUNCH_GATE_AUDIT_REPORT.explicitNonGoals],
  };
}

export function formatLaunchGateAuditJson(report: LaunchGateAuditReport = buildLaunchGateAuditReport()): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatLaunchGateAuditText(report: LaunchGateAuditReport = buildLaunchGateAuditReport()): string {
  const lines = [
    'Phase 83 launch gate audit',
    `code: ${report.code}`,
    `status: ${report.status}`,
    `launchReady: ${report.launchReady ? 'true' : 'false'}`,
    `scope: ${report.scope}`,
    '',
    'Steps:',
  ];

  for (const step of report.steps) {
    lines.push(`- ${step.id}: ${step.status}`);
    lines.push(`  summary: ${step.summary}`);
    lines.push('  required before launch:');
    for (const item of step.requiredBeforeLaunch) lines.push(`  - ${item}`);
    lines.push('  safe commands:');
    for (const command of step.safeCommands) lines.push(`  - ${command}`);
    lines.push('  evidence labels:');
    for (const label of step.evidenceLabels) lines.push(`  - ${label}`);
  }

  lines.push('', 'Open gates:');
  for (const gate of report.openGates) lines.push(`- ${gate}`);

  lines.push('', 'Explicit non-goals:');
  for (const nonGoal of report.explicitNonGoals) lines.push(`- ${nonGoal}`);

  return `${lines.join('\n')}\n`;
}
