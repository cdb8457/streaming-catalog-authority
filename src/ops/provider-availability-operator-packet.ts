export type ProviderAvailabilityOperatorPacketStepStatus = 'operator-provided' | 'static-local' | 'review-required';

export interface ProviderAvailabilityOperatorPacketStep {
  readonly number: number;
  readonly title: string;
  readonly phase: string;
  readonly status: ProviderAvailabilityOperatorPacketStepStatus;
  readonly commandShapes: readonly string[];
  readonly retainAs: readonly string[];
  readonly requires: readonly string[];
  readonly warning?: string;
}

export interface ProviderAvailabilityOperatorPacket {
  readonly report: 'phase-59-provider-availability-operator-packet';
  readonly version: 1;
  readonly purpose: 'static-redaction-safe-provider-availability-summary-workflow';
  readonly source: 'static-provider-availability-operator-workflow-packet';
  readonly providerContact: false;
  readonly commandExecution: false;
  readonly credentialValuesIncluded: false;
  readonly credentialPathsIncluded: false;
  readonly rawRefsIncluded: false;
  readonly providerPayloadsIncluded: false;
  readonly itemRowsIncluded: false;
  readonly mediaIdentityIncluded: false;
  readonly summaryValuesEchoed: false;
  readonly enablesProviderMode: false;
  readonly persisted: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly placeholders: readonly string[];
  readonly artifactFlow: readonly string[];
  readonly steps: readonly ProviderAvailabilityOperatorPacketStep[];
  readonly redactionRules: readonly string[];
  readonly reviewRules: readonly string[];
  readonly nonRequirements: readonly string[];
}

export const PROVIDER_AVAILABILITY_OPERATOR_PACKET: ProviderAvailabilityOperatorPacket = {
  report: 'phase-59-provider-availability-operator-packet',
  version: 1,
  purpose: 'static-redaction-safe-provider-availability-summary-workflow',
  source: 'static-provider-availability-operator-workflow-packet',
  providerContact: false,
  commandExecution: false,
  credentialValuesIncluded: false,
  credentialPathsIncluded: false,
  rawRefsIncluded: false,
  providerPayloadsIncluded: false,
  itemRowsIncluded: false,
  mediaIdentityIncluded: false,
  summaryValuesEchoed: false,
  enablesProviderMode: false,
  persisted: false,
  closesO4: false,
  closesO5: false,
  o4Status: 'open/deferred',
  o5Status: 'open/deferred',
  fileCustodianStatus: 'reference-harness-not-production-kms',
  placeholders: [
    '<phase-56-bridge-report.json>',
    '<phase-58-provider-availability-summary.json>',
    '<redacted-retention-folder>',
    '<independent-review-note>',
  ],
  artifactFlow: [
    'phase-56-sanitized-bridge-reports -> phase-58-provider-availability-summary',
    'phase-58-provider-availability-summary -> independent review note',
    'reviewed count-only summary -> future operator dashboard planning',
  ],
  steps: [
    {
      number: 1,
      title: 'Retain sanitized bridge reports only',
      phase: 'Phase 56',
      status: 'operator-provided',
      commandShapes: ['retain <phase-56-bridge-report.json> files produced by trusted local bridge callers'],
      retainAs: ['<phase-56-bridge-report.json>'],
      requires: ['sanitized bridge reports only', 'no raw adapter result retention'],
      warning: 'Do not retain provider locator/detail payloads or raw adapter outputs.',
    },
    {
      number: 2,
      title: 'Build the count-only provider availability summary',
      phase: 'Phase 58',
      status: 'static-local',
      commandShapes: [
        'npm run --silent ops:provider-availability-summary -- -- <phase-56-bridge-report.json>... --json > <phase-58-provider-availability-summary.json>',
      ],
      retainAs: ['<phase-58-provider-availability-summary.json>'],
      requires: ['one or more sanitized Phase 56 bridge reports'],
      warning: 'A held summary is not a failure to hide; retain the fixed hold counts for review.',
    },
    {
      number: 3,
      title: 'Review fixed counts before future dashboard use',
      phase: 'Phase 59',
      status: 'review-required',
      commandShapes: ['record <independent-review-note> with GO/HOLD for count-only availability summary use'],
      retainAs: ['<independent-review-note>'],
      requires: ['Phase 58 summary JSON', 'no retained sensitive values'],
      warning: 'This review prepares future operator visibility only and does not enable provider mode.',
    },
  ],
  redactionRules: [
    'Retain fixed count fields and readiness labels only.',
    'Do not retain credential values, credential paths, bearer strings, cookies, headers, raw refs, infohashes, digests, URLs, query strings, provider payloads, response bodies, parse snippets, account labels, item ids, media titles, or debug logs.',
    'Do not retain per-item rows or per-provider payload rows for dashboard planning.',
  ],
  reviewRules: [
    'candidate, skip, and hold counts are advisory-only and not catalog authority.',
    'held summaries must remain visible for operator review.',
    'This packet does not enable provider mode.',
    'O4 and O5 remain open/deferred.',
    'FileCustodian remains a hardened reference harness, not production KMS.',
  ],
  nonRequirements: [
    'This packet is static and local only.',
    'It does not execute commands, read env values, read files, read credentials, connect to a database, contact providers, construct transports, run Docker, scan directories, or validate live evidence.',
    'It does not add provider writes, downloads, playback, scheduling, HTTP, UI, adapter-factory live wiring, or CI live-network requirements.',
    'It does not close O4 or O5.',
  ],
};

export function formatProviderAvailabilityOperatorPacketJson(
  packet: ProviderAvailabilityOperatorPacket = PROVIDER_AVAILABILITY_OPERATOR_PACKET,
): string {
  return `${JSON.stringify(packet, null, 2)}\n`;
}

export function formatProviderAvailabilityOperatorPacketText(
  packet: ProviderAvailabilityOperatorPacket = PROVIDER_AVAILABILITY_OPERATOR_PACKET,
): string {
  const lines: string[] = [];
  lines.push('Phase 59 provider availability operator packet');
  lines.push('');
  lines.push(packet.purpose);
  lines.push('');
  lines.push(`Provider contact: ${packet.providerContact ? 'true' : 'false'}`);
  lines.push(`Command execution: ${packet.commandExecution ? 'true' : 'false'}`);
  lines.push(`Credential values included: ${packet.credentialValuesIncluded ? 'true' : 'false'}`);
  lines.push(`Credential paths included: ${packet.credentialPathsIncluded ? 'true' : 'false'}`);
  lines.push(`Raw refs included: ${packet.rawRefsIncluded ? 'true' : 'false'}`);
  lines.push(`Provider payloads included: ${packet.providerPayloadsIncluded ? 'true' : 'false'}`);
  lines.push(`Item rows included: ${packet.itemRowsIncluded ? 'true' : 'false'}`);
  lines.push(`Media identity included: ${packet.mediaIdentityIncluded ? 'true' : 'false'}`);
  lines.push(`Summary values echoed: ${packet.summaryValuesEchoed ? 'true' : 'false'}`);
  lines.push(`Enables provider mode: ${packet.enablesProviderMode ? 'true' : 'false'}`);
  lines.push(`Persisted: ${packet.persisted ? 'true' : 'false'}`);
  lines.push(`O4 status: ${packet.o4Status}`);
  lines.push(`O5 status: ${packet.o5Status}`);
  lines.push(`FileCustodian: ${packet.fileCustodianStatus}`);
  lines.push('');
  lines.push('Placeholders:');
  for (const placeholder of packet.placeholders) lines.push(`- ${placeholder}`);
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
