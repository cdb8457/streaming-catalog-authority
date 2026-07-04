export type TorBoxLiveSmokeOperatorPacketStepStatus = 'operator-run' | 'static-local' | 'review-required';

export interface TorBoxLiveSmokeOperatorPacketStep {
  readonly number: number;
  readonly title: string;
  readonly phase: string;
  readonly status: TorBoxLiveSmokeOperatorPacketStepStatus;
  readonly commandShapes: readonly string[];
  readonly retainAs: readonly string[];
  readonly requires: readonly string[];
  readonly warning?: string;
}

export interface TorBoxLiveSmokeOperatorPacket {
  readonly report: 'phase-52-torbox-live-smoke-operator-packet';
  readonly version: 1;
  readonly purpose: 'static-redaction-safe-live-smoke-run-save-review-workflow';
  readonly source: 'static-operator-workflow-packet';
  readonly liveTorBoxContact: false;
  readonly commandExecution: false;
  readonly credentialValuesIncluded: false;
  readonly credentialPathsIncluded: false;
  readonly rawRefsIncluded: false;
  readonly providerPayloadsIncluded: false;
  readonly summaryValuesEchoed: false;
  readonly closesLiveSmokeReview: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly requiredReviewGateInputs: readonly ['service-status', 'hoster-metadata'];
  readonly optionalReviewGateInputs: readonly ['cache-availability'];
  readonly placeholders: readonly string[];
  readonly artifactFlow: readonly string[];
  readonly steps: readonly TorBoxLiveSmokeOperatorPacketStep[];
  readonly redactionRules: readonly string[];
  readonly reviewRules: readonly string[];
  readonly nonRequirements: readonly string[];
}

export const TORBOX_LIVE_SMOKE_OPERATOR_PACKET: TorBoxLiveSmokeOperatorPacket = {
  report: 'phase-52-torbox-live-smoke-operator-packet',
  version: 1,
  purpose: 'static-redaction-safe-live-smoke-run-save-review-workflow',
  source: 'static-operator-workflow-packet',
  liveTorBoxContact: false,
  commandExecution: false,
  credentialValuesIncluded: false,
  credentialPathsIncluded: false,
  rawRefsIncluded: false,
  providerPayloadsIncluded: false,
  summaryValuesEchoed: false,
  closesLiveSmokeReview: false,
  o4Status: 'open/deferred',
  o5Status: 'open/deferred',
  fileCustodianStatus: 'reference-harness-not-production-kms',
  requiredReviewGateInputs: ['service-status', 'hoster-metadata'],
  optionalReviewGateInputs: ['cache-availability'],
  placeholders: [
    '<torbox-token-file>',
    '<redacted-cache-ref>',
    '<phase-43-service-status-report.json>',
    '<phase-43-hoster-metadata-report.json>',
    '<phase-43-cache-report.json>',
    '<phase-44-service-status-preflight.json>',
    '<phase-44-hoster-metadata-preflight.json>',
    '<phase-44-cache-preflight.json>',
    '<phase-49-summary-pack.json>',
    '<phase-51-review-gate.json>',
    '<redacted-retention-folder>',
  ],
  artifactFlow: [
    'phase-43-service-status-report -> phase-44-service-status-preflight',
    'phase-43-hoster-metadata-report -> phase-44-hoster-metadata-preflight',
    'optional-phase-43-cache-report -> optional-phase-44-cache-preflight',
    'phase-43-reports -> phase-49-summary-pack',
    'phase-49-summary-pack -> phase-51-review-gate',
    'phase-51-review-gate plus retained redacted artifacts -> independent reviewer',
  ],
  steps: [
    {
      number: 1,
      title: 'Print the static operator plan',
      phase: 'Phase 45',
      status: 'static-local',
      commandShapes: [
        'npm run --silent ops:torbox-live-smoke-plan -- -- --json > <redacted-retention-folder>/torbox-live-smoke-plan.redacted.json',
      ],
      retainAs: ['torbox-live-smoke-plan.redacted.json'],
      requires: ['sealed Phase 51 codebase', 'operator-controlled redacted retention folder'],
      warning: 'The plan is a static reminder and does not authorize live smoke by itself.',
    },
    {
      number: 2,
      title: 'Run required service-status smoke',
      phase: 'Phase 43',
      status: 'operator-run',
      commandShapes: [
        'npm run --silent smoke:torbox-readonly -- -- --live-smoke --live-transport --read-only --redacted --operator-authorized --credential-file <torbox-token-file> --probe service-status --json > <phase-43-service-status-report.json>',
      ],
      retainAs: ['<phase-43-service-status-report.json>'],
      requires: ['operator authorization', 'credential file path supplied at runtime only'],
    },
    {
      number: 3,
      title: 'Run required hoster-metadata smoke',
      phase: 'Phase 43',
      status: 'operator-run',
      commandShapes: [
        'npm run --silent smoke:torbox-readonly -- -- --live-smoke --live-transport --read-only --redacted --operator-authorized --credential-file <torbox-token-file> --probe hoster-metadata --json > <phase-43-hoster-metadata-report.json>',
      ],
      retainAs: ['<phase-43-hoster-metadata-report.json>'],
      requires: ['operator authorization', 'credential file path supplied at runtime only'],
    },
    {
      number: 4,
      title: 'Optionally run cache-availability smoke',
      phase: 'Phase 43',
      status: 'operator-run',
      commandShapes: [
        'npm run --silent smoke:torbox-readonly -- -- --live-smoke --live-transport --read-only --redacted --operator-authorized --credential-file <torbox-token-file> --probe cache-availability --ref-type infohash --scoped-ref <redacted-cache-ref> --json > <phase-43-cache-report.json>',
      ],
      retainAs: ['<phase-43-cache-report.json>'],
      requires: ['operator-selected scoped ref', 'raw ref must not be retained'],
      warning: 'Cache-availability is optional for the Phase 51 review gate; omit it rather than retaining a raw ref.',
    },
    {
      number: 5,
      title: 'Preflight each saved Phase 43 report',
      phase: 'Phase 44',
      status: 'static-local',
      commandShapes: [
        'npm run --silent ops:torbox-live-smoke-evidence-preflight -- -- <phase-43-service-status-report.json> --json > <phase-44-service-status-preflight.json>',
        'npm run --silent ops:torbox-live-smoke-evidence-preflight -- -- <phase-43-hoster-metadata-report.json> --json > <phase-44-hoster-metadata-preflight.json>',
        'npm run --silent ops:torbox-live-smoke-evidence-preflight -- -- <phase-43-cache-report.json> --json > <phase-44-cache-preflight.json>',
      ],
      retainAs: [
        '<phase-44-service-status-preflight.json>',
        '<phase-44-hoster-metadata-preflight.json>',
        '<phase-44-cache-preflight.json>',
      ],
      requires: ['saved Phase 43 JSON reports'],
      warning: 'Run the cache preflight only when the optional cache report exists.',
    },
    {
      number: 6,
      title: 'Build the Phase 49 summary pack',
      phase: 'Phase 49',
      status: 'static-local',
      commandShapes: [
        'npm run --silent ops:torbox-live-smoke-summary-pack -- -- <phase-43-service-status-report.json> <phase-43-hoster-metadata-report.json> --json > <phase-49-summary-pack.json>',
        'npm run --silent ops:torbox-live-smoke-summary-pack -- -- <phase-43-service-status-report.json> <phase-43-hoster-metadata-report.json> <phase-43-cache-report.json> --json > <phase-49-summary-pack.json>',
      ],
      retainAs: ['<phase-49-summary-pack.json>'],
      requires: ['required service-status and hoster-metadata Phase 43 reports'],
      warning: 'Use the second command only when the optional cache report exists and passed preflight.',
    },
    {
      number: 7,
      title: 'Run the Phase 51 review gate',
      phase: 'Phase 51',
      status: 'static-local',
      commandShapes: [
        'npm run --silent ops:torbox-live-smoke-review-gate -- -- <phase-49-summary-pack.json> --json > <phase-51-review-gate.json>',
      ],
      retainAs: ['<phase-51-review-gate.json>'],
      requires: ['Phase 49 summary pack'],
      warning: 'A ready review-gate report prepares review only and does not close live-smoke review.',
    },
    {
      number: 8,
      title: 'Hand the redacted packet to independent review',
      phase: 'Phase 52',
      status: 'review-required',
      commandShapes: [
        'retain only redacted artifacts in <redacted-retention-folder> and request independent review',
      ],
      retainAs: ['redacted Phase 43 reports', 'Phase 44 preflights', 'Phase 49 summary pack', 'Phase 51 review gate'],
      requires: ['no retained secrets', 'no retained raw refs', 'no retained provider payloads'],
      warning: 'Independent review remains required before treating live-smoke evidence as accepted.',
    },
  ],
  redactionRules: [
    'Do not retain TorBox tokens, bearer strings, cookies, headers, credential values, or credential file paths.',
    'Do not retain raw scoped refs, infohashes, digests, URLs, query strings, provider payloads, response bodies, parse snippets, account labels, item ids, media titles, or debug logs.',
    'Retain fixed report names, fixed probe names, fixed operation names, fixed categories, pass/warn/fail counts, readiness labels, timestamps, and redacted artifact labels only.',
  ],
  reviewRules: [
    'service-status and hoster-metadata are required for Phase 51 review readiness.',
    'cache-availability is optional and must be ready when retained.',
    'A ready Phase 51 report does not close live-smoke review.',
    'O4 and O5 remain open/deferred.',
    'FileCustodian remains a hardened reference harness, not production KMS.',
  ],
  nonRequirements: [
    'This packet is static and local only.',
    'It does not execute commands, read env values, read files, read credentials, connect to a database, contact TorBox, construct transports, run Docker, scan directories, or validate live evidence.',
    'It does not add provider writes, downloads, playback, scheduling, HTTP, UI, adapter-factory live wiring, or CI live-network requirements.',
    'It does not close live-smoke review, O4, or O5.',
  ],
};

export function formatTorBoxLiveSmokeOperatorPacketJson(
  packet: TorBoxLiveSmokeOperatorPacket = TORBOX_LIVE_SMOKE_OPERATOR_PACKET,
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatTorBoxLiveSmokeOperatorPacketText(
  packet: TorBoxLiveSmokeOperatorPacket = TORBOX_LIVE_SMOKE_OPERATOR_PACKET,
): string {
  const lines: string[] = [];
  lines.push('Phase 52 TorBox live smoke operator packet');
  lines.push('');
  lines.push(packet.purpose);
  lines.push('');
  lines.push(`Live TorBox contact: ${packet.liveTorBoxContact ? 'true' : 'false'}`);
  lines.push(`Command execution: ${packet.commandExecution ? 'true' : 'false'}`);
  lines.push(`Credential values included: ${packet.credentialValuesIncluded ? 'true' : 'false'}`);
  lines.push(`Credential paths included: ${packet.credentialPathsIncluded ? 'true' : 'false'}`);
  lines.push(`Raw refs included: ${packet.rawRefsIncluded ? 'true' : 'false'}`);
  lines.push(`Provider payloads included: ${packet.providerPayloadsIncluded ? 'true' : 'false'}`);
  lines.push(`Summary values echoed: ${packet.summaryValuesEchoed ? 'true' : 'false'}`);
  lines.push(`Closes live-smoke review: ${packet.closesLiveSmokeReview ? 'true' : 'false'}`);
  lines.push(`O4 status: ${packet.o4Status}`);
  lines.push(`O5 status: ${packet.o5Status}`);
  lines.push(`FileCustodian: ${packet.fileCustodianStatus}`);
  lines.push('');
  lines.push(`Required review-gate inputs: ${packet.requiredReviewGateInputs.join(',')}`);
  lines.push(`Optional review-gate inputs: ${packet.optionalReviewGateInputs.join(',')}`);
  lines.push('');
  lines.push('Artifact flow:');
  for (const item of packet.artifactFlow) lines.push(`- ${item}`);
  lines.push('');
  lines.push('Steps:');
  for (const step of packet.steps) {
    lines.push(`${step.number}. ${step.title}`);
    lines.push(`   phase: ${step.phase}`);
    lines.push(`   status: ${step.status}`);
    lines.push(`   requires: ${step.requires.join('; ')}`);
    lines.push(`   retain as: ${step.retainAs.join('; ')}`);
    lines.push(`   command shapes: ${step.commandShapes.join('; ')}`);
    if (step.warning) lines.push(`   warning: ${step.warning}`);
  }
  lines.push('');
  lines.push('Redaction rules:');
  for (const rule of packet.redactionRules) lines.push(`- ${rule}`);
  lines.push('');
  lines.push('Review rules:');
  for (const rule of packet.reviewRules) lines.push(`- ${rule}`);
  lines.push('');
  lines.push('Non-requirements:');
  for (const item of packet.nonRequirements) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}
