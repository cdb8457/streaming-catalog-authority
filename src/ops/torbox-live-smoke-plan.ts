export type TorBoxLiveSmokePlanStatus = 'operator-run' | 'static-only' | 'deferred';

export interface TorBoxLiveSmokePlanStep {
  readonly number: number;
  readonly title: string;
  readonly status: TorBoxLiveSmokePlanStatus;
  readonly commandShapes: readonly string[];
  readonly evidenceLabel: string;
  readonly operatorAction: string;
  readonly warning?: string;
}

export interface TorBoxLiveSmokePlan {
  readonly report: 'phase-45-torbox-live-smoke-operator-plan';
  readonly version: 1;
  readonly purpose: string;
  readonly liveTorBoxContact: false;
  readonly commandExecution: false;
  readonly credentialValuesIncluded: false;
  readonly credentialPathsIncluded: false;
  readonly rawRefsIncluded: false;
  readonly providerPayloadsIncluded: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly placeholders: readonly string[];
  readonly steps: readonly TorBoxLiveSmokePlanStep[];
  readonly redactionReminders: readonly string[];
  readonly nonRequirements: readonly string[];
}

export const TORBOX_LIVE_SMOKE_PLAN: TorBoxLiveSmokePlan = {
  report: 'phase-45-torbox-live-smoke-operator-plan',
  version: 1,
  purpose: 'Static operator command plan for Phase 43 TorBox live smoke and Phase 44 evidence preflight.',
  liveTorBoxContact: false,
  commandExecution: false,
  credentialValuesIncluded: false,
  credentialPathsIncluded: false,
  rawRefsIncluded: false,
  providerPayloadsIncluded: false,
  o4Status: 'open/deferred',
  o5Status: 'open/deferred',
  fileCustodianStatus: 'reference-harness-not-production-kms',
  placeholders: [
    '<torbox-token-file>',
    '<phase-43-service-status-report.json>',
    '<phase-43-hoster-metadata-report.json>',
    '<phase-43-cache-report.json>',
    '<redacted-cache-ref>',
    '<redacted-retention-location>',
  ],
  steps: [
    {
      number: 1,
      title: 'Confirm static readiness metadata',
      status: 'static-only',
      commandShapes: [
        'npm run ops:torbox-smoke-readiness-preflight -- -- <readiness-descriptor.json> --json',
      ],
      evidenceLabel: 'torbox-readiness-preflight.redacted.json',
      operatorAction: 'Confirm descriptor readiness without treating it as live-smoke authorization.',
      warning: 'This descriptor preflight does not contact TorBox or close live-smoke review.',
    },
    {
      number: 2,
      title: 'Run service-status live smoke',
      status: 'operator-run',
      commandShapes: [
        'npm run smoke:torbox-readonly -- --live-smoke --live-transport --read-only --redacted --operator-authorized --credential-file <torbox-token-file> --probe service-status --json > <phase-43-service-status-report.json>',
      ],
      evidenceLabel: 'torbox-service-status.redacted.json',
      operatorAction: 'Run manually outside CI and retain only the redacted JSON report.',
    },
    {
      number: 3,
      title: 'Run hoster-metadata live smoke',
      status: 'operator-run',
      commandShapes: [
        'npm run smoke:torbox-readonly -- --live-smoke --live-transport --read-only --redacted --operator-authorized --credential-file <torbox-token-file> --probe hoster-metadata --json > <phase-43-hoster-metadata-report.json>',
      ],
      evidenceLabel: 'torbox-hoster-metadata.redacted.json',
      operatorAction: 'Run manually outside CI and retain only the redacted JSON report.',
    },
    {
      number: 4,
      title: 'Run optional cache-availability live smoke',
      status: 'operator-run',
      commandShapes: [
        'npm run smoke:torbox-readonly -- --live-smoke --live-transport --read-only --redacted --operator-authorized --credential-file <torbox-token-file> --probe cache-availability --ref-type infohash --scoped-ref <redacted-cache-ref> --json > <phase-43-cache-report.json>',
      ],
      evidenceLabel: 'torbox-cache-availability.redacted.json',
      operatorAction: 'Use one operator-selected scoped ref only; do not retain the raw ref in evidence.',
      warning: 'The raw scoped ref is request input only and must not be pasted into retained evidence.',
    },
    {
      number: 5,
      title: 'Preflight saved Phase 43 reports',
      status: 'static-only',
      commandShapes: [
        'npm run ops:torbox-live-smoke-evidence-preflight -- -- <phase-43-service-status-report.json> --json',
        'npm run ops:torbox-live-smoke-evidence-preflight -- -- <phase-43-hoster-metadata-report.json> --json',
        'npm run ops:torbox-live-smoke-evidence-preflight -- -- <phase-43-cache-report.json> --json',
      ],
      evidenceLabel: 'torbox-live-smoke-evidence-preflight.redacted.json',
      operatorAction: 'Verify each saved report shape before review or retention.',
      warning: 'Passing Phase 44 preflight validates shape only; it does not prove provider availability.',
    },
    {
      number: 6,
      title: 'Retain redacted summary only',
      status: 'operator-run',
      commandShapes: [
        'record fixed statuses, counts, probe names, categories, dates, and <redacted-retention-location>',
      ],
      evidenceLabel: 'torbox-live-smoke-summary.redacted.md',
      operatorAction: 'Retain fixed summaries only and review against the TorBox smoke evidence template.',
    },
  ],
  redactionReminders: [
    'Do not include TorBox tokens, credential values, credential file paths, cookies, headers, or bearer strings.',
    'Do not include raw scoped refs, infohashes, digests, links, NZB-derived inputs, endpoint URLs, or query strings.',
    'Do not include provider response bodies, parse snippets, account labels, media titles, item ids, or debug logs.',
    'Retain fixed statuses, categories, counts, probe names, timestamps, and redacted artifact labels only.',
  ],
  nonRequirements: [
    'This plan is static and local only.',
    'It does not execute shell commands, read env values, read files, read credentials, connect to a database, call TorBox, construct transports, run Docker, or scan evidence directories.',
    'It does not add provider mode, adapter-factory wiring, downloads, playback, scheduling, HTTP, UI, or CI live-network requirements.',
    'It does not close live-smoke review, O4, or O5.',
  ],
};

export function formatTorBoxLiveSmokePlanJson(plan: TorBoxLiveSmokePlan = TORBOX_LIVE_SMOKE_PLAN): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function formatTorBoxLiveSmokePlanText(plan: TorBoxLiveSmokePlan = TORBOX_LIVE_SMOKE_PLAN): string {
  const lines: string[] = [];
  lines.push('Phase 45 TorBox live smoke operator plan');
  lines.push('');
  lines.push(plan.purpose);
  lines.push('');
  lines.push(`Live TorBox contact: ${plan.liveTorBoxContact ? 'true' : 'false'}`);
  lines.push(`Command execution: ${plan.commandExecution ? 'true' : 'false'}`);
  lines.push(`Credential values included: ${plan.credentialValuesIncluded ? 'true' : 'false'}`);
  lines.push(`Credential paths included: ${plan.credentialPathsIncluded ? 'true' : 'false'}`);
  lines.push(`Raw refs included: ${plan.rawRefsIncluded ? 'true' : 'false'}`);
  lines.push(`Provider payloads included: ${plan.providerPayloadsIncluded ? 'true' : 'false'}`);
  lines.push(`O4 status: ${plan.o4Status}`);
  lines.push(`O5 status: ${plan.o5Status}`);
  lines.push(`FileCustodian: ${plan.fileCustodianStatus}`);
  lines.push('');
  lines.push('Steps:');
  for (const step of plan.steps) {
    lines.push(`${step.number}. ${step.title}`);
    lines.push(`   status: ${step.status}`);
    lines.push(`   evidence: ${step.evidenceLabel}`);
    lines.push(`   command shapes: ${step.commandShapes.join('; ')}`);
    lines.push(`   operator action: ${step.operatorAction}`);
    if (step.warning) lines.push(`   warning: ${step.warning}`);
  }
  lines.push('');
  lines.push('Redaction reminders:');
  for (const reminder of plan.redactionReminders) lines.push(`- ${reminder}`);
  lines.push('');
  lines.push('Non-requirements:');
  for (const item of plan.nonRequirements) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}
