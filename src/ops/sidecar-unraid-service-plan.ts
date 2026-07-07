export interface SidecarUnraidServicePlanStep {
  readonly id: string;
  readonly label: string;
  readonly action: string;
  readonly status: 'planned' | 'deferred' | 'blocked';
}

export interface SidecarUnraidServicePlan {
  readonly ok: true;
  readonly code: 'SIDECAR_UNRAID_SERVICE_PLAN';
  readonly report: 'phase-105-sidecar-unraid-service-plan';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'plan-unraid-local-sidecar-service-wrapper-without-installing-it';
  readonly servicePlanReady: true;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly mutatesUnraid: false;
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
  readonly appdataLayout: readonly string[];
  readonly permissionModel: readonly string[];
  readonly serviceWrapperSteps: readonly SidecarUnraidServicePlanStep[];
  readonly blockedActions: readonly string[];
  readonly operatorChecks: readonly string[];
}

const APPDATA_LAYOUT = [
  '/mnt/user/appdata/streaming-catalog-authority/sidecar/state',
  '/mnt/user/appdata/streaming-catalog-authority/sidecar/run',
  '/mnt/user/appdata/streaming-catalog-authority/sidecar/logs',
  '/mnt/user/appdata/streaming-catalog-authority/catalog',
] as const;

const PERMISSION_MODEL = [
  'sidecar state directory owner-only',
  'sidecar run directory owner-only',
  'Unix socket created under sidecar run directory',
  'catalog app receives only the socket path, not sidecar state secrets',
  'main catalog DB backups exclude sidecar state and sidecar secret material',
] as const;

const SERVICE_WRAPPER_STEPS = [
  {
    id: 'preflight-directories',
    label: 'Create appdata directories',
    action: 'mkdir -p sidecar/state sidecar/run sidecar/logs catalog; chmod 700 sidecar/state sidecar/run',
    status: 'planned',
  },
  {
    id: 'start-wrapper',
    label: 'Start local sidecar wrapper',
    action: 'start sidecar process bound only to sidecar/run/catalog-sidecar.sock',
    status: 'planned',
  },
  {
    id: 'health-check',
    label: 'Check local socket readiness',
    action: 'run a local status probe through the Unix socket and fail closed on any error',
    status: 'planned',
  },
  {
    id: 'stop-wrapper',
    label: 'Stop local sidecar wrapper',
    action: 'send process termination, remove stale socket file, retain state and tombstones',
    status: 'planned',
  },
  {
    id: 'boot-install',
    label: 'Install boot-time service',
    action: 'deferred until reviewed operator script exists',
    status: 'deferred',
  },
] as const satisfies readonly SidecarUnraidServicePlanStep[];

const BLOCKED_ACTIONS = [
  'writing /boot/config/go',
  'installing rc.d scripts',
  'starting a background daemon',
  'binding TCP ports',
  'binding 0.0.0.0',
  'publishing through a reverse proxy',
  'adding Docker or Compose topology',
  'reading production secrets',
  'contacting live services',
  'provider adapter work',
  'media-server integration',
  'operator UI expansion',
  'claiming O4 or O5 closure',
] as const;

const OPERATOR_CHECKS = [
  'state directory exists and is separate from catalog DB backups',
  'socket directory is owner-only before service start',
  'socket path is local filesystem IPC, not host:port',
  'sidecar logs contain no secrets, key material, socket paths with host-specific secrets, provider refs, or media titles',
  'catalog app fails closed when the sidecar socket is missing',
  'restart preserves active keys and tombstones through sidecar-owned state',
  'mismatched sidecar state makes reads fail closed',
] as const;

export function buildSidecarUnraidServicePlan(): SidecarUnraidServicePlan {
  return {
    ok: true,
    code: 'SIDECAR_UNRAID_SERVICE_PLAN',
    report: 'phase-105-sidecar-unraid-service-plan',
    version: 1,
    redactionSafe: true,
    purpose: 'plan-unraid-local-sidecar-service-wrapper-without-installing-it',
    servicePlanReady: true,
    serviceInstalled: false,
    serviceStarted: false,
    mutatesUnraid: false,
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
    appdataLayout: [...APPDATA_LAYOUT],
    permissionModel: [...PERMISSION_MODEL],
    serviceWrapperSteps: SERVICE_WRAPPER_STEPS.map((step) => ({ ...step })),
    blockedActions: [...BLOCKED_ACTIONS],
    operatorChecks: [...OPERATOR_CHECKS],
  };
}

export function formatSidecarUnraidServicePlanText(plan: SidecarUnraidServicePlan = buildSidecarUnraidServicePlan()): string {
  const lines = [
    'Phase 105 Sidecar Unraid Service Plan',
    `code: ${plan.code}`,
    `report: ${plan.report}`,
    `redactionSafe: ${plan.redactionSafe ? 'true' : 'false'}`,
    `servicePlanReady: ${plan.servicePlanReady ? 'true' : 'false'}`,
    `serviceInstalled: ${plan.serviceInstalled ? 'true' : 'false'}`,
    `serviceStarted: ${plan.serviceStarted ? 'true' : 'false'}`,
    `mutatesUnraid: ${plan.mutatesUnraid ? 'true' : 'false'}`,
    `tcpListenerAllowed: ${plan.tcpListenerAllowed ? 'true' : 'false'}`,
    `httpApiAllowed: ${plan.httpApiAllowed ? 'true' : 'false'}`,
    `lanExposureAllowed: ${plan.lanExposureAllowed ? 'true' : 'false'}`,
    `reverseProxyAllowed: ${plan.reverseProxyAllowed ? 'true' : 'false'}`,
    `providerContactAllowed: ${plan.providerContactAllowed ? 'true' : 'false'}`,
    `closesO4: ${plan.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${plan.closesO5 ? 'true' : 'false'}`,
    `O4 status: ${plan.o4Status}`,
    `O5 status: ${plan.o5Status}`,
    `FileCustodian: ${plan.fileCustodianStatus}`,
    '',
    'Appdata layout:',
  ];
  for (const item of plan.appdataLayout) lines.push(`- ${item}`);
  lines.push('', 'Permission model:');
  for (const item of plan.permissionModel) lines.push(`- ${item}`);
  lines.push('', 'Service wrapper steps:');
  for (const step of plan.serviceWrapperSteps) lines.push(`- ${step.id}: ${step.status} - ${step.label} - ${step.action}`);
  lines.push('', 'Blocked actions:');
  for (const item of plan.blockedActions) lines.push(`- ${item}`);
  lines.push('', 'Operator checks:');
  for (const item of plan.operatorChecks) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}
