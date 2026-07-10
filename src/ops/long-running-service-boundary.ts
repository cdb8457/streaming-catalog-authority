export interface LongRunningServiceBoundaryFinding {
  readonly level: 'pass' | 'warn';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface LongRunningServiceBoundaryReport {
  readonly report: 'phase-146-long-running-service-boundary';
  readonly version: 1;
  readonly purpose: 'define-first-always-on-api-and-minimal-operator-ui-service';
  readonly productFraming: 'backend-orchestration-rail-not-streaming-product';
  readonly selectedServiceShape: 'api-plus-minimal-operator-ui';
  readonly implementationStarted: false;
  readonly composeChanged: false;
  readonly serviceAdded: false;
  readonly portPublishedNow: false;
  readonly plannedOperatorPort: 8099;
  readonly authBoundary: 'local-admin-token-file';
  readonly plannedAuthSecretFile: '/mnt/user/appdata/catalog/secrets/operator_ui_token';
  readonly initialDataMode: 'read-only-first';
  readonly logsFirstClass: true;
  readonly allowedLogClasses: readonly ['system', 'operation', 'connector'];
  readonly logRedactionRequired: true;
  readonly dockerLogsRequired: true;
  readonly uiLogsRequired: true;
  readonly allowedInitialExposures: readonly [
    'health-status',
    'doctor-summary',
    'schema-version',
    'database-status',
    'custodian-status',
    'production-gate-warnings',
    'redacted-system-logs',
    'redacted-operation-logs',
    'static-deployment-readiness',
  ];
  readonly allowedFutureConnectorClasses: readonly [
    'availability-provider-connectors',
    'usenet-connectors',
    'library-consumer-connectors',
    'metadata-consumer-connectors',
  ];
  readonly forbiddenProductClaims: readonly [
    'streaming-product',
    'player',
    'media-server-replacement',
    'downloader-ui',
    'provider-search-ui',
  ];
  readonly forbiddenRuntimeCapabilities: readonly [
    'provider-contact',
    'scraping',
    'downloading',
    'playback',
    'debrid-provider-live-mode',
    'usenet-provider-live-mode',
    'library-consumer-mutation',
    'media-server-mutation',
    'external-app-publish',
    'raw-secret-exposure',
    'raw-identity-exposure',
  ];
  readonly redactionSafe: true;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly mutatesUnraid: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly nextPhase: 'phase-147-implement-first-always-on-service';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: 0;
    readonly total: number;
  };
  readonly findings: readonly LongRunningServiceBoundaryFinding[];
}

export function buildLongRunningServiceBoundaryReport(): LongRunningServiceBoundaryReport {
  const findings: LongRunningServiceBoundaryFinding[] = [
    pass('SERVICE_SHAPE_SELECTED', 'selectedServiceShape', 'The first always-on service is API plus minimal operator UI.'),
    pass('PRODUCT_FRAMING_SELECTED', 'productFraming', 'The product is a backend orchestration rail, not a streaming product.'),
    pass('PORT_POLICY_SELECTED', 'plannedOperatorPort', 'The first intentional published port is planned as 8099.'),
    pass('AUTH_BOUNDARY_SELECTED', 'authBoundary', 'Local Unraid auth starts with an operator token file.'),
    pass('READ_ONLY_FIRST', 'initialDataMode', 'The first service should expose read-only status before command buttons.'),
    pass('LOGS_FIRST_CLASS', 'logsFirstClass', 'System, operation, and connector logs are first-class UI/API surfaces.'),
    pass('REDACTION_REQUIRED', 'logRedactionRequired', 'Logs and status surfaces must be redacted by default.'),
    pass('NO_IMPLEMENTATION_YET', 'implementationStarted', 'This phase defines the contract only.'),
    pass('NO_COMPOSE_MUTATION', 'composeChanged', 'This phase does not add the app service to Compose.'),
    pass('NO_PROVIDER_MODE', 'providerModeEnabled', 'Provider mode remains disabled.'),
    warn('O4_REMAINS_OPEN', 'productionReady', 'FileCustodian remains a reference harness, not external production KMS.'),
    warn('O5_REMAINS_OPEN', 'productionReady', 'Managed KEK custody/scheduling remains open.'),
  ];
  const passCount = findings.filter((finding) => finding.level === 'pass').length;
  const warnCount = findings.filter((finding) => finding.level === 'warn').length;
  return {
    report: 'phase-146-long-running-service-boundary',
    version: 1,
    purpose: 'define-first-always-on-api-and-minimal-operator-ui-service',
    productFraming: 'backend-orchestration-rail-not-streaming-product',
    selectedServiceShape: 'api-plus-minimal-operator-ui',
    implementationStarted: false,
    composeChanged: false,
    serviceAdded: false,
    portPublishedNow: false,
    plannedOperatorPort: 8099,
    authBoundary: 'local-admin-token-file',
    plannedAuthSecretFile: '/mnt/user/appdata/catalog/secrets/operator_ui_token',
    initialDataMode: 'read-only-first',
    logsFirstClass: true,
    allowedLogClasses: ['system', 'operation', 'connector'],
    logRedactionRequired: true,
    dockerLogsRequired: true,
    uiLogsRequired: true,
    allowedInitialExposures: [
      'health-status',
      'doctor-summary',
      'schema-version',
      'database-status',
      'custodian-status',
      'production-gate-warnings',
      'redacted-system-logs',
      'redacted-operation-logs',
      'static-deployment-readiness',
    ],
    allowedFutureConnectorClasses: [
      'availability-provider-connectors',
      'usenet-connectors',
      'library-consumer-connectors',
      'metadata-consumer-connectors',
    ],
    forbiddenProductClaims: [
      'streaming-product',
      'player',
      'media-server-replacement',
      'downloader-ui',
      'provider-search-ui',
    ],
    forbiddenRuntimeCapabilities: [
      'provider-contact',
      'scraping',
      'downloading',
      'playback',
      'debrid-provider-live-mode',
      'usenet-provider-live-mode',
      'library-consumer-mutation',
      'media-server-mutation',
      'external-app-publish',
      'raw-secret-exposure',
      'raw-identity-exposure',
    ],
    redactionSafe: true,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    nextPhase: 'phase-147-implement-first-always-on-service',
    summary: { pass: passCount, warn: warnCount, fail: 0, total: findings.length },
    findings,
  };
}

export function formatLongRunningServiceBoundaryJson(report: LongRunningServiceBoundaryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatLongRunningServiceBoundaryText(report: LongRunningServiceBoundaryReport): string {
  const lines = [
    'Phase 146 long-running service boundary',
    `Service shape: ${report.selectedServiceShape}`,
    `Product framing: ${report.productFraming}`,
    `Planned operator port: ${report.plannedOperatorPort}`,
    `Auth boundary: ${report.authBoundary}`,
    `Initial data mode: ${report.initialDataMode}`,
    `Logs first-class: ${report.logsFirstClass ? 'true' : 'false'}`,
    `Compose changed: ${report.composeChanged ? 'true' : 'false'}`,
    `Service added: ${report.serviceAdded ? 'true' : 'false'}`,
    `Provider mode enabled: ${report.providerModeEnabled ? 'true' : 'false'}`,
    `Next phase: ${report.nextPhase}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function pass(code: string, field: string, message: string): LongRunningServiceBoundaryFinding {
  return { level: 'pass', code, field, message };
}

function warn(code: string, field: string, message: string): LongRunningServiceBoundaryFinding {
  return { level: 'warn', code, field, message };
}
