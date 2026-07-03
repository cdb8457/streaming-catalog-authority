/**
 * Phase 37 - TorBox smoke CLI shell.
 *
 * Local preflight/reporting only. This module does not read env, read files, call a network service,
 * import a TorBox SDK, connect to a database, or construct a transport.
 */

export type TorBoxSmokeProbe = 'service-status' | 'hoster-metadata' | 'cache-availability';

export type TorBoxSmokeCategory =
  | 'not-authorized'
  | 'not-read-only'
  | 'redaction-block'
  | 'policy-block'
  | 'unsupported-ref'
  | 'empty-ref'
  | 'transport';

export interface TorBoxSmokeShellOptions {
  readonly liveSmoke: boolean;
  readonly readOnly: boolean;
  readonly redacted: boolean;
  readonly operatorAuthorized: boolean;
  readonly credentialRefConfigured: boolean;
  readonly probe: TorBoxSmokeProbe;
  readonly refType?: string;
  readonly scopedRefPresent: boolean;
  readonly json: boolean;
}

export interface TorBoxSmokeGate {
  readonly name: string;
  readonly ok: boolean;
  readonly category?: TorBoxSmokeCategory;
}

export interface TorBoxSmokeShellReport {
  readonly report: 'phase-37-torbox-smoke-cli-shell';
  readonly phase: 37;
  readonly ok: false;
  readonly liveSmokeAttempted: false;
  readonly wouldContactTorBox: false;
  readonly command: 'smoke:torbox-readonly';
  readonly mode: 'preflight-shell-only';
  readonly probe: TorBoxSmokeProbe;
  readonly operation: 'status-check' | 'hoster-list' | 'cache-availability';
  readonly gates: readonly TorBoxSmokeGate[];
  readonly category: TorBoxSmokeCategory;
  readonly evidence: {
    readonly statuses: readonly string[];
    readonly counts: {
      readonly serviceStatusChecks: number;
      readonly hosterMetadataChecks: number;
      readonly cacheAvailabilityChecks: number;
    };
    readonly credentialRef: 'configured' | 'missing';
    readonly scopedRef: 'present' | 'not-recorded';
  };
  readonly notes: readonly string[];
}

export const TORBOX_SMOKE_SHELL_SUPPORTED_REF_TYPES = [
  'infohash',
  'hash-digest',
  'link-derived-digest',
  'nzb-derived-digest',
] as const;

const DEFAULT_OPTIONS: TorBoxSmokeShellOptions = {
  liveSmoke: false,
  readOnly: false,
  redacted: false,
  operatorAuthorized: false,
  credentialRefConfigured: false,
  probe: 'service-status',
  scopedRefPresent: false,
  json: false,
};

export function parseTorBoxSmokeShellArgs(argv: readonly string[]): TorBoxSmokeShellOptions | { readonly error: string } {
  const options: {
    liveSmoke: boolean;
    readOnly: boolean;
    redacted: boolean;
    operatorAuthorized: boolean;
    credentialRefConfigured: boolean;
    probe: TorBoxSmokeProbe;
    refType?: string;
    scopedRefPresent: boolean;
    json: boolean;
  } = { ...DEFAULT_OPTIONS };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--' || arg === '--json') {
      if (arg === '--json') options.json = true;
    } else if (arg === '--live-smoke') {
      options.liveSmoke = true;
    } else if (arg === '--read-only') {
      options.readOnly = true;
    } else if (arg === '--redacted') {
      options.redacted = true;
    } else if (arg === '--operator-authorized') {
      options.operatorAuthorized = true;
    } else if (arg === '--credential-ref') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) return { error: 'credential-ref-required' };
      options.credentialRefConfigured = true;
    } else if (arg === '--probe') {
      const value = argv[++i];
      if (!isTorBoxSmokeProbe(value)) return { error: 'unsupported-probe' };
      options.probe = value;
    } else if (arg === '--ref-type') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) return { error: 'ref-type-required' };
      options.refType = value;
    } else if (arg === '--scoped-ref-present') {
      options.scopedRefPresent = true;
    } else {
      return { error: 'unsupported-argument' };
    }
  }

  return options;
}

export function buildTorBoxSmokeShellReport(options: TorBoxSmokeShellOptions): TorBoxSmokeShellReport {
  const gates: TorBoxSmokeGate[] = [
    gate('operator-authorization', options.operatorAuthorized, 'not-authorized'),
    gate('explicit-live-smoke-flag', options.liveSmoke, 'not-authorized'),
    gate('read-only-mode', options.readOnly, 'not-read-only'),
    gate('secret-indirection', options.credentialRefConfigured, 'not-authorized'),
    gate('redaction-mode', options.redacted, 'redaction-block'),
    gate('probe-allowlist', true, 'policy-block'),
    gate('bounded-timeout-policy', true, 'policy-block'),
    gate('no-live-transport-attached', false, 'transport'),
  ];

  if (options.probe === 'cache-availability') {
    gates.splice(
      5,
      0,
      gate('cache-ref-type-supported', isSupportedRefType(options.refType), 'unsupported-ref'),
      gate('cache-scoped-ref-present', options.scopedRefPresent, 'empty-ref'),
    );
  }

  const firstFailure = gates.find((item) => !item.ok);
  const category = firstFailure?.category ?? 'policy-block';
  const operation = options.probe === 'service-status'
    ? 'status-check'
    : options.probe === 'hoster-metadata'
      ? 'hoster-list'
      : 'cache-availability';

  return {
    report: 'phase-37-torbox-smoke-cli-shell',
    phase: 37,
    ok: false,
    liveSmokeAttempted: false,
    wouldContactTorBox: false,
    command: 'smoke:torbox-readonly',
    mode: 'preflight-shell-only',
    probe: options.probe,
    operation,
    gates,
    category,
    evidence: {
      statuses: [category],
      counts: {
        serviceStatusChecks: options.probe === 'service-status' ? 1 : 0,
        hosterMetadataChecks: options.probe === 'hoster-metadata' ? 1 : 0,
        cacheAvailabilityChecks: options.probe === 'cache-availability' ? 1 : 0,
      },
      credentialRef: options.credentialRefConfigured ? 'configured' : 'missing',
      scopedRef: options.scopedRefPresent ? 'present' : 'not-recorded',
    },
    notes: [
      'Phase 37 is a CLI shell only; no TorBox transport is attached.',
      'The command refuses before any network contact.',
      'Evidence is limited to fixed statuses, counts, operation names, and categories.',
      'O4 remains open/deferred; O5 remains open/deferred.',
      'FileCustodian remains a hardened reference harness, not production KMS.',
    ],
  };
}

export function formatTorBoxSmokeShellJson(report: TorBoxSmokeShellReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatTorBoxSmokeShellText(report: TorBoxSmokeShellReport): string {
  const gateLines = report.gates.map((gate) => {
    const status = gate.ok ? 'PASS' : 'BLOCK';
    return `  ${status} ${gate.name}${gate.category ? ` (${gate.category})` : ''}`;
  });
  return [
    'torbox read-only smoke preflight shell:',
    `  command: ${report.command}`,
    `  mode: ${report.mode}`,
    `  probe: ${report.probe}`,
    `  operation: ${report.operation}`,
    `  result: BLOCK (${report.category})`,
    `  would-contact-torbox: ${report.wouldContactTorBox}`,
    `  credential-ref: ${report.evidence.credentialRef}`,
    `  scoped-ref: ${report.evidence.scopedRef}`,
    ...gateLines,
    '',
    'No live TorBox transport is attached in Phase 37.',
    '',
  ].join('\n');
}

export function torBoxSmokeShellUsage(): string {
  return [
    'usage: smoke:torbox-readonly --live-smoke --read-only --redacted --operator-authorized --credential-ref <opaque-ref> [--probe service-status|hoster-metadata|cache-availability] [--ref-type <type> --scoped-ref-present] [--json]',
    '',
    'Phase 37 is a preflight shell only. It refuses before TorBox contact because no live transport is attached.',
  ].join('\n');
}

function gate(name: string, ok: boolean, category: TorBoxSmokeCategory): TorBoxSmokeGate {
  return ok ? { name, ok } : { name, ok, category };
}

function isTorBoxSmokeProbe(value: unknown): value is TorBoxSmokeProbe {
  return value === 'service-status' || value === 'hoster-metadata' || value === 'cache-availability';
}

function isSupportedRefType(value: unknown): boolean {
  return typeof value === 'string' && (TORBOX_SMOKE_SHELL_SUPPORTED_REF_TYPES as readonly string[]).includes(value);
}
