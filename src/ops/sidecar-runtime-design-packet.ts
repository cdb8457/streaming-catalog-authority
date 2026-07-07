export interface SidecarRuntimeDecision {
  readonly id: string;
  readonly decision: string;
  readonly status: 'selected' | 'deferred' | 'blocked';
  readonly rationale: readonly string[];
}

export interface SidecarRuntimeDesignPacket {
  readonly ok: true;
  readonly code: 'SIDECAR_RUNTIME_DESIGN_PACKET';
  readonly report: 'phase-99-sidecar-runtime-design-packet';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'select-unraid-local-sidecar-runtime-boundary';
  readonly runtimeDesignSelected: true;
  readonly runtimeImplemented: false;
  readonly liveValidationAllowed: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly custodyBoundary: 'external-self-hosted';
  readonly decisions: readonly SidecarRuntimeDecision[];
  readonly implementationBacklog: readonly string[];
  readonly blockedShapes: readonly string[];
  readonly evidencePrerequisites: readonly string[];
}

const DECISIONS = [
  {
    id: 'process-boundary',
    decision: 'Run custodian as a separate local sidecar process on the Unraid host.',
    status: 'selected',
    rationale: [
      'Keeps DEK lifecycle state outside the catalog app process.',
      'Allows the catalog app to fail closed when the sidecar is unavailable.',
      'Avoids cloud-managed KMS dependency while preserving a reviewable custody boundary.',
    ],
  },
  {
    id: 'ipc-boundary',
    decision: 'Use a Unix domain socket under appdata with owner-only filesystem permissions.',
    status: 'selected',
    rationale: [
      'Unraid is Linux, so a filesystem socket is simpler than exposing TCP.',
      'The socket can stay off the LAN and off reverse proxies.',
      'A future implementation can reuse the Phase 98 injected transport client.',
    ],
  },
  {
    id: 'state-boundary',
    decision: 'Store sidecar state in a dedicated appdata directory separate from the catalog database and DB backups.',
    status: 'selected',
    rationale: [
      'Main DB backups must not contain custodian key material.',
      'Sidecar state needs an independent backup and restore gate.',
      'Missing or mismatched sidecar state must make catalog reads fail closed.',
    ],
  },
  {
    id: 'attestation-boundary',
    decision: 'Use sidecar-owned attestation material for destruction receipts.',
    status: 'selected',
    rationale: [
      'The catalog app must not be able to forge tombstone attestations.',
      'Destroyed keys need stable, durable, non-secret receipts across retries.',
      'Evidence can verify receipt shape without printing secret material.',
    ],
  },
  {
    id: 'supervision-boundary',
    decision: 'Defer concrete Unraid service installation until implementation.',
    status: 'deferred',
    rationale: [
      'This phase is a design packet, not a daemon or service installer.',
      'The next implementation unit must choose start, stop, restart, logs, and permissions explicitly.',
      'No background process is launched by this package.',
    ],
  },
] as const satisfies readonly SidecarRuntimeDecision[];

const IMPLEMENTATION_BACKLOG = [
  'Create a sidecar executable with the Phase 98 request/response contract.',
  'Implement Unix socket listener with owner-only socket directory permissions.',
  'Add sidecar state store with durable key records, tombstones, and attestation metadata.',
  'Add catalog app transport adapter that connects only to the configured local socket.',
  'Add fail-closed startup and read behavior when the socket or sidecar state is unavailable.',
  'Add Unraid appdata layout documentation and operator-run service wrapper instructions.',
  'Add independent sidecar backup and restore rehearsal before any O4 closure claim.',
] as const;

const BLOCKED_SHAPES = [
  'TCP listener',
  'HTTP API',
  'remote network exposure',
  'reverse proxy publication',
  'Docker topology change',
  'cloud KMS or vendor SDK',
  'provider adapter work',
  'media-server integration',
  'operator UI or frontend work',
  'live validation execution',
  'O4 or O5 closure',
] as const;

const EVIDENCE_PREREQUISITES = [
  'contract-kit evidence for provision, commit, get, destroy, status, stale provisioning, idempotency, and lost acknowledgements',
  'failure-injection evidence for sidecar unavailable, corrupt state, wrong epoch, destroyed key, missing tombstone, and malformed response',
  'attestation evidence proving the app cannot forge destruction receipts',
  'redaction review for logs, errors, stdout, stderr, service status, and evidence manifests',
  'backup/restore evidence proving main DB restore fails closed without matching sidecar prerequisites',
  'operator and reviewer acceptance records with fixed labels only',
] as const;

export function buildSidecarRuntimeDesignPacket(): SidecarRuntimeDesignPacket {
  return {
    ok: true,
    code: 'SIDECAR_RUNTIME_DESIGN_PACKET',
    report: 'phase-99-sidecar-runtime-design-packet',
    version: 1,
    redactionSafe: true,
    purpose: 'select-unraid-local-sidecar-runtime-boundary',
    runtimeDesignSelected: true,
    runtimeImplemented: false,
    liveValidationAllowed: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    custodyBoundary: 'external-self-hosted',
    decisions: DECISIONS.map((decision) => ({
      ...decision,
      rationale: [...decision.rationale],
    })),
    implementationBacklog: [...IMPLEMENTATION_BACKLOG],
    blockedShapes: [...BLOCKED_SHAPES],
    evidencePrerequisites: [...EVIDENCE_PREREQUISITES],
  };
}

export function formatSidecarRuntimeDesignPacketText(report: SidecarRuntimeDesignPacket = buildSidecarRuntimeDesignPacket()): string {
  const lines = [
    'Phase 99 Sidecar Runtime Design Packet',
    `code: ${report.code}`,
    `report: ${report.report}`,
    `redactionSafe: ${report.redactionSafe ? 'true' : 'false'}`,
    `runtimeDesignSelected: ${report.runtimeDesignSelected ? 'true' : 'false'}`,
    `runtimeImplemented: ${report.runtimeImplemented ? 'true' : 'false'}`,
    `liveValidationAllowed: ${report.liveValidationAllowed ? 'true' : 'false'}`,
    `custodyBoundary: ${report.custodyBoundary}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `FileCustodian: ${report.fileCustodianStatus}`,
    '',
    'Decisions:',
  ];

  for (const decision of report.decisions) {
    lines.push(`- ${decision.id}: ${decision.status}`);
    lines.push(`  decision: ${decision.decision}`);
    for (const reason of decision.rationale) lines.push(`  - ${reason}`);
  }

  lines.push('', 'Implementation backlog:');
  for (const item of report.implementationBacklog) lines.push(`- ${item}`);

  lines.push('', 'Blocked shapes:');
  for (const shape of report.blockedShapes) lines.push(`- ${shape}`);

  lines.push('', 'Evidence prerequisites:');
  for (const prerequisite of report.evidencePrerequisites) lines.push(`- ${prerequisite}`);

  return `${lines.join('\n')}\n`;
}
