export interface OperatorUiPreviewLaunchCommand {
  readonly id: 'local-loopback' | 'unraid-loopback-ssh-tunnel';
  readonly label: string;
  readonly readiness: 'ready' | 'operator-run';
  readonly commandShape: string;
  readonly exposure: 'loopback-only';
  readonly dataMode: 'fixture-only';
  readonly notes: readonly string[];
}

export interface OperatorUiPreviewLaunchPacket {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_PREVIEW_LAUNCH_PACKET';
  readonly report: 'phase-97-operator-ui-preview-launch-packet';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'package-safe-static-operator-ui-preview-launch-shapes';
  readonly staticPreviewReady: true;
  readonly localReadonlyUiReady: false;
  readonly liveProductReady: false;
  readonly remoteExposureAllowed: false;
  readonly liveDataAllowed: false;
  readonly providerContactAllowed: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly commands: readonly OperatorUiPreviewLaunchCommand[];
  readonly blockedShapes: readonly string[];
  readonly boundaries: readonly string[];
}

const COMMANDS = [
  {
    id: 'local-loopback',
    label: 'Local fixture preview',
    readiness: 'ready',
    commandShape: 'npm run ops:operator-ui-static-runtime -- -- --serve --host 127.0.0.1 --port 4173',
    exposure: 'loopback-only',
    dataMode: 'fixture-only',
    notes: [
      'Use this from the workstation running the repo.',
      'Serves the static fixture preview only.',
      'No DB, provider, packet-source, playback, download, scraping, or media-server behavior.',
    ],
  },
  {
    id: 'unraid-loopback-ssh-tunnel',
    label: 'Unraid fixture preview through SSH tunnel',
    readiness: 'operator-run',
    commandShape: 'start the same runtime on Unraid bound to 127.0.0.1, then use an SSH local port forward such as ssh -L 4174:127.0.0.1:4173 root@<unraid-host>',
    exposure: 'loopback-only',
    dataMode: 'fixture-only',
    notes: [
      'This keeps the preview off the LAN by using SSH forwarding.',
      'Do not bind the runtime to 0.0.0.0 or publish it through a reverse proxy.',
      'Use only redaction-safe fixture/static packets until a future auth/access phase authorizes live data.',
    ],
  },
] as const satisfies readonly OperatorUiPreviewLaunchCommand[];

const BLOCKED_SHAPES = [
  'binding the preview server to 0.0.0.0',
  'publishing the preview through Traefik, nginx, Cloudflare Tunnel, Newt, or another reverse proxy',
  'serving live catalog DB data',
  'serving provider/debrid/media-server data',
  'adding remote auth/session/cookie/token behavior in this phase',
  'using the preview as production UI or launch approval',
] as const;

const BOUNDARIES = [
  'Static preview remains fixture-only',
  'Remote exposure remains blocked',
  'Loopback-only preview may be viewed locally or over an operator-controlled SSH tunnel',
  'No real titles, external IDs, provider names/logos, infohashes, magnets, credentials, user library data, poster art, streaming artwork, raw logs, secret paths, or backup contents are displayed',
  'O4 remains open/deferred',
  'O5 remains open/deferred',
  'FileCustodian remains a hardened reference harness, not production KMS',
] as const;

export function buildOperatorUiPreviewLaunchPacket(): OperatorUiPreviewLaunchPacket {
  return {
    ok: true,
    code: 'OPERATOR_UI_PREVIEW_LAUNCH_PACKET',
    report: 'phase-97-operator-ui-preview-launch-packet',
    version: 1,
    redactionSafe: true,
    purpose: 'package-safe-static-operator-ui-preview-launch-shapes',
    staticPreviewReady: true,
    localReadonlyUiReady: false,
    liveProductReady: false,
    remoteExposureAllowed: false,
    liveDataAllowed: false,
    providerContactAllowed: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    commands: COMMANDS.map((command) => ({ ...command, notes: [...command.notes] })),
    blockedShapes: [...BLOCKED_SHAPES],
    boundaries: [...BOUNDARIES],
  };
}

export function formatOperatorUiPreviewLaunchPacketText(report: OperatorUiPreviewLaunchPacket = buildOperatorUiPreviewLaunchPacket()): string {
  const lines = [
    'Operator UI Preview Launch Packet',
    `code: ${report.code}`,
    `report: ${report.report}`,
    `redactionSafe: ${report.redactionSafe ? 'true' : 'false'}`,
    `staticPreviewReady: ${report.staticPreviewReady ? 'true' : 'false'}`,
    `localReadonlyUiReady: ${report.localReadonlyUiReady ? 'true' : 'false'}`,
    `liveProductReady: ${report.liveProductReady ? 'true' : 'false'}`,
    `remoteExposureAllowed: ${report.remoteExposureAllowed ? 'true' : 'false'}`,
    `liveDataAllowed: ${report.liveDataAllowed ? 'true' : 'false'}`,
    `providerContactAllowed: ${report.providerContactAllowed ? 'true' : 'false'}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `FileCustodian: ${report.fileCustodianStatus}`,
    '',
    'Command shapes:',
  ];
  for (const command of report.commands) {
    lines.push(`- ${command.id}: ${command.readiness}`);
    lines.push(`  label: ${command.label}`);
    lines.push(`  command: ${command.commandShape}`);
    lines.push(`  exposure: ${command.exposure}`);
    lines.push(`  dataMode: ${command.dataMode}`);
    for (const note of command.notes) lines.push(`  - ${note}`);
  }

  lines.push('', 'Blocked shapes:');
  for (const shape of report.blockedShapes) lines.push(`- ${shape}`);
  lines.push('', 'Boundaries:');
  for (const boundary of report.boundaries) lines.push(`- ${boundary}`);
  return `${lines.join('\n')}\n`;
}

