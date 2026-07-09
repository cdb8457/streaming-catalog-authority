export interface ControlSurfaceComposeBoundaryFinding {
  readonly level: 'pass' | 'warn';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface ControlSurfaceComposeBoundaryReport {
  readonly report: 'phase-140-control-surface-compose-boundary';
  readonly version: 1;
  readonly purpose: 'define-pre-compose-stop-line-for-arcane-dockhand-control-surface';
  readonly sourceRestartPersistenceReview: 'phase-139-unraid-restart-persistence-review';
  readonly redactionSafe: true;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly mutatesUnraid: false;
  readonly composeStarted: false;
  readonly arcaneSelected: false;
  readonly dockhandControlsInstalled: false;
  readonly readyForComposeSection: true;
  readonly requiresHumanLoopBeforeCompose: true;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly nextDecision: 'choose-control-surface-compose-target';
  readonly allowedTargets: readonly ['arcane-hosted-controls', 'separate-operator-ui', 'ssh-user-scripts-only'];
  readonly blockedUntilDecision: readonly [
    'compose-service-added',
    'port-published',
    'arcane-route-added',
    'dockhand-control-installed',
    'credential-form-enabled',
  ];
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: 0;
    readonly total: number;
  };
  readonly findings: readonly ControlSurfaceComposeBoundaryFinding[];
}

export function buildControlSurfaceComposeBoundaryReport(): ControlSurfaceComposeBoundaryReport {
  const findings: ControlSurfaceComposeBoundaryFinding[] = [
    pass('PHASE_139_COMPLETE', 'sourceRestartPersistenceReview', 'Restart persistence review is the required predecessor.'),
    pass('READY_FOR_COMPOSE_SECTION', 'readyForComposeSection', 'The next work may enter the Compose control-surface section.'),
    pass('HUMAN_LOOP_REQUIRED', 'requiresHumanLoopBeforeCompose', 'The control-surface target must be selected before Compose changes.'),
    pass('COMPOSE_NOT_STARTED', 'composeStarted', 'This phase does not add or start Compose services.'),
    pass('ARCANE_NOT_SELECTED', 'arcaneSelected', 'Arcane is a candidate target, not selected by this packet.'),
    pass('DOCKHAND_NOT_INSTALLED', 'dockhandControlsInstalled', 'DockHand controls are not installed by this packet.'),
    pass('NO_UNRAID_MUTATION', 'mutatesUnraid', 'This packet mutates no Unraid state.'),
    pass('NO_COMMAND_EXECUTION', 'commandExecution', 'This packet emits guidance only.'),
    pass('NO_PROVIDER_MODE', 'providerModeEnabled', 'Provider mode remains disabled.'),
    warn('O4_REMAINS_OPEN', 'fileCustodianStatus', 'FileCustodian remains a reference harness, not external production KMS.'),
    warn('O5_REMAINS_OPEN', 'kekCustodyStatus', 'Managed KEK custody/scheduling remains open.'),
  ];
  const passCount = findings.filter((finding) => finding.level === 'pass').length;
  const warnCount = findings.filter((finding) => finding.level === 'warn').length;
  return {
    report: 'phase-140-control-surface-compose-boundary',
    version: 1,
    purpose: 'define-pre-compose-stop-line-for-arcane-dockhand-control-surface',
    sourceRestartPersistenceReview: 'phase-139-unraid-restart-persistence-review',
    redactionSafe: true,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    composeStarted: false,
    arcaneSelected: false,
    dockhandControlsInstalled: false,
    readyForComposeSection: true,
    requiresHumanLoopBeforeCompose: true,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    nextDecision: 'choose-control-surface-compose-target',
    allowedTargets: ['arcane-hosted-controls', 'separate-operator-ui', 'ssh-user-scripts-only'],
    blockedUntilDecision: [
      'compose-service-added',
      'port-published',
      'arcane-route-added',
      'dockhand-control-installed',
      'credential-form-enabled',
    ],
    summary: { pass: passCount, warn: warnCount, fail: 0, total: findings.length },
    findings,
  };
}

export function formatControlSurfaceComposeBoundaryJson(report: ControlSurfaceComposeBoundaryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatControlSurfaceComposeBoundaryText(report: ControlSurfaceComposeBoundaryReport): string {
  const lines = [
    'Phase 140 control surface Compose boundary',
    `Ready for Compose section: ${report.readyForComposeSection ? 'true' : 'false'}`,
    `Requires human loop before Compose: ${report.requiresHumanLoopBeforeCompose ? 'true' : 'false'}`,
    `Compose started: ${report.composeStarted ? 'true' : 'false'}`,
    `Arcane selected: ${report.arcaneSelected ? 'true' : 'false'}`,
    `DockHand controls installed: ${report.dockhandControlsInstalled ? 'true' : 'false'}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function pass(code: string, field: string, message: string): ControlSurfaceComposeBoundaryFinding {
  return { level: 'pass', code, field, message };
}

function warn(code: string, field: string, message: string): ControlSurfaceComposeBoundaryFinding {
  return { level: 'warn', code, field, message };
}
