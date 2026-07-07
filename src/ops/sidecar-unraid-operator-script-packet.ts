export interface SidecarUnraidOperatorScript {
  readonly id: 'setup' | 'start' | 'health' | 'stop' | 'evidence';
  readonly label: string;
  readonly operatorRunRequired: true;
  readonly mutatesWhenRunByOperator: boolean;
  readonly command: string;
  readonly capturesEvidenceLabel: string;
}

export interface SidecarUnraidOperatorScriptPacket {
  readonly ok: true;
  readonly code: 'SIDECAR_UNRAID_OPERATOR_SCRIPT_PACKET';
  readonly report: 'phase-106-sidecar-unraid-operator-script-packet';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'provide-copy-paste-safe-unraid-sidecar-operator-scripts-without-running-them';
  readonly commandExecution: false;
  readonly operatorRunRequired: true;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly mutatesUnraidNow: false;
  readonly tcpListenerAllowed: false;
  readonly httpApiAllowed: false;
  readonly lanExposureAllowed: false;
  readonly reverseProxyAllowed: false;
  readonly providerContactAllowed: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly scripts: readonly SidecarUnraidOperatorScript[];
  readonly blockedActions: readonly string[];
}

const SCRIPTS = [
  {
    id: 'setup',
    label: 'Create sidecar appdata directories and owner-only permissions',
    operatorRunRequired: true,
    mutatesWhenRunByOperator: true,
    command: "mkdir -p /mnt/user/appdata/streaming-catalog-authority/sidecar/{state,run,logs} /mnt/user/appdata/streaming-catalog-authority/catalog && chmod 700 /mnt/user/appdata/streaming-catalog-authority/sidecar/state /mnt/user/appdata/streaming-catalog-authority/sidecar/run",
    capturesEvidenceLabel: 'phase-106-setup-permissions-redacted',
  },
  {
    id: 'start',
    label: 'Start sidecar bound to local Unix socket only',
    operatorRunRequired: true,
    mutatesWhenRunByOperator: true,
    command: "catalog-sidecar --state-dir /mnt/user/appdata/streaming-catalog-authority/sidecar/state --socket /mnt/user/appdata/streaming-catalog-authority/sidecar/run/catalog-sidecar.sock --log-dir /mnt/user/appdata/streaming-catalog-authority/sidecar/logs",
    capturesEvidenceLabel: 'phase-106-start-local-socket-redacted',
  },
  {
    id: 'health',
    label: 'Run local socket readiness probe',
    operatorRunRequired: true,
    mutatesWhenRunByOperator: false,
    command: "catalog-sidecar-health --socket /mnt/user/appdata/streaming-catalog-authority/sidecar/run/catalog-sidecar.sock --json",
    capturesEvidenceLabel: 'phase-106-local-socket-health-redacted',
  },
  {
    id: 'stop',
    label: 'Stop sidecar and leave durable state intact',
    operatorRunRequired: true,
    mutatesWhenRunByOperator: true,
    command: "catalog-sidecar-stop --socket /mnt/user/appdata/streaming-catalog-authority/sidecar/run/catalog-sidecar.sock --retain-state",
    capturesEvidenceLabel: 'phase-106-stop-retain-state-redacted',
  },
  {
    id: 'evidence',
    label: 'Collect redacted sidecar evidence labels only',
    operatorRunRequired: true,
    mutatesWhenRunByOperator: false,
    command: "catalog-sidecar-evidence --redacted --output sidecar-unraid-evidence.redacted.json",
    capturesEvidenceLabel: 'phase-107-evidence-bundle-redacted',
  },
] as const satisfies readonly SidecarUnraidOperatorScript[];

const BLOCKED_ACTIONS = [
  'automatic command execution',
  'writing /boot/config/go',
  'installing rc.d scripts',
  'registering a boot-time service',
  'binding TCP ports',
  'binding 0.0.0.0',
  'publishing through a reverse proxy',
  'adding Docker or Compose topology',
  'reading production secrets in CI',
  'contacting live services in CI',
  'provider adapter work',
  'media-server integration',
  'operator UI expansion',
  'claiming O4 or O5 closure',
] as const;

export function buildSidecarUnraidOperatorScriptPacket(): SidecarUnraidOperatorScriptPacket {
  return {
    ok: true,
    code: 'SIDECAR_UNRAID_OPERATOR_SCRIPT_PACKET',
    report: 'phase-106-sidecar-unraid-operator-script-packet',
    version: 1,
    redactionSafe: true,
    purpose: 'provide-copy-paste-safe-unraid-sidecar-operator-scripts-without-running-them',
    commandExecution: false,
    operatorRunRequired: true,
    serviceInstalled: false,
    serviceStarted: false,
    mutatesUnraidNow: false,
    tcpListenerAllowed: false,
    httpApiAllowed: false,
    lanExposureAllowed: false,
    reverseProxyAllowed: false,
    providerContactAllowed: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    scripts: SCRIPTS.map((script) => ({ ...script })),
    blockedActions: [...BLOCKED_ACTIONS],
  };
}

export function formatSidecarUnraidOperatorScriptPacketText(packet: SidecarUnraidOperatorScriptPacket = buildSidecarUnraidOperatorScriptPacket()): string {
  const lines = [
    'Phase 106 Sidecar Unraid Operator Script Packet',
    `code: ${packet.code}`,
    `report: ${packet.report}`,
    `redactionSafe: ${packet.redactionSafe ? 'true' : 'false'}`,
    `commandExecution: ${packet.commandExecution ? 'true' : 'false'}`,
    `operatorRunRequired: ${packet.operatorRunRequired ? 'true' : 'false'}`,
    `serviceInstalled: ${packet.serviceInstalled ? 'true' : 'false'}`,
    `serviceStarted: ${packet.serviceStarted ? 'true' : 'false'}`,
    `mutatesUnraidNow: ${packet.mutatesUnraidNow ? 'true' : 'false'}`,
    `tcpListenerAllowed: ${packet.tcpListenerAllowed ? 'true' : 'false'}`,
    `httpApiAllowed: ${packet.httpApiAllowed ? 'true' : 'false'}`,
    `lanExposureAllowed: ${packet.lanExposureAllowed ? 'true' : 'false'}`,
    `closesO4: ${packet.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${packet.closesO5 ? 'true' : 'false'}`,
    `O4 status: ${packet.o4Status}`,
    `O5 status: ${packet.o5Status}`,
    `FileCustodian: ${packet.fileCustodianStatus}`,
    '',
    'Scripts:',
  ];
  for (const script of packet.scripts) {
    lines.push(`- ${script.id}: ${script.label}`);
    lines.push(`  operatorRunRequired: ${script.operatorRunRequired ? 'true' : 'false'}`);
    lines.push(`  mutatesWhenRunByOperator: ${script.mutatesWhenRunByOperator ? 'true' : 'false'}`);
    lines.push(`  command: ${script.command}`);
    lines.push(`  evidenceLabel: ${script.capturesEvidenceLabel}`);
  }
  lines.push('', 'Blocked actions:');
  for (const action of packet.blockedActions) lines.push(`- ${action}`);
  return `${lines.join('\n')}\n`;
}
