/**
 * Phase 37/38 - TorBox smoke CLI shell and deterministic fixture harness.
 *
 * Local preflight/reporting only. This module does not read env, read files, call a network service,
 * import a TorBox SDK, connect to a database, or construct a transport.
 */

export type TorBoxSmokeProbe = 'service-status' | 'hoster-metadata' | 'cache-availability';

export type TorBoxSmokeCategory =
  | 'fixture-ok'
  | 'not-authorized'
  | 'not-read-only'
  | 'redaction-block'
  | 'policy-block'
  | 'unsupported-ref'
  | 'empty-ref'
  | 'transport'
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'parse'
  | 'ambiguous-response';

export type TorBoxSmokeFixtureScenario =
  | 'available'
  | 'unavailable'
  | 'unknown'
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'parse'
  | 'ambiguous-response';

export interface TorBoxSmokeShellOptions {
  readonly liveSmoke: boolean;
  readonly readOnly: boolean;
  readonly redacted: boolean;
  readonly operatorAuthorized: boolean;
  readonly credentialRefConfigured: boolean;
  readonly probe: TorBoxSmokeProbe;
  readonly refType?: string;
  readonly scopedRefPresent: boolean;
  readonly fixture?: TorBoxSmokeFixtureScenario;
  readonly json: boolean;
}

export interface TorBoxSmokeGate {
  readonly name: string;
  readonly ok: boolean;
  readonly category?: TorBoxSmokeCategory;
}

export interface TorBoxSmokeShellReport {
  readonly report: 'phase-38-torbox-smoke-cli-fixture-harness';
  readonly phase: 38;
  readonly ok: boolean;
  readonly liveSmokeAttempted: false;
  readonly wouldContactTorBox: false;
  readonly command: 'smoke:torbox-readonly';
  readonly mode: 'preflight-shell-only' | 'local-fixture-harness';
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
      readonly availabilityHits: number;
      readonly availabilityMisses: number;
      readonly availabilityUnknown: number;
    };
    readonly credentialRef: 'configured' | 'missing';
    readonly scopedRef: 'present' | 'not-recorded';
    readonly fixture: 'none' | TorBoxSmokeFixtureScenario;
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
    fixture?: TorBoxSmokeFixtureScenario;
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
    } else if (arg === '--fixture') {
      const value = argv[++i];
      if (!isTorBoxSmokeFixtureScenario(value)) return { error: 'unsupported-fixture' };
      options.fixture = value;
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
  ];

  if (options.probe === 'cache-availability') {
    gates.splice(
      5,
      0,
      gate('cache-ref-type-supported', isSupportedRefType(options.refType), 'unsupported-ref'),
      gate('cache-scoped-ref-present', options.scopedRefPresent, 'empty-ref'),
    );
  }

  const fixture = options.fixture;
  const fixtureCategory = fixtureCategoryFor(fixture);
  gates.push(gate('local-fixture-transport-attached', fixture !== undefined, 'transport'));
  const failure = gates.find((item) => !item.ok);
  const category = failure?.category ?? fixtureCategory;
  const operation = options.probe === 'service-status'
    ? 'status-check'
    : options.probe === 'hoster-metadata'
      ? 'hoster-list'
      : 'cache-availability';
  const ok = failure === undefined && fixtureCategory === 'fixture-ok';

  return {
    report: 'phase-38-torbox-smoke-cli-fixture-harness',
    phase: 38,
    ok,
    liveSmokeAttempted: false,
    wouldContactTorBox: false,
    command: 'smoke:torbox-readonly',
    mode: fixture === undefined ? 'preflight-shell-only' : 'local-fixture-harness',
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
        availabilityHits: fixture === 'available' ? 1 : 0,
        availabilityMisses: fixture === 'unavailable' ? 1 : 0,
        availabilityUnknown: fixture === 'unknown' ? 1 : 0,
      },
      credentialRef: options.credentialRefConfigured ? 'configured' : 'missing',
      scopedRef: options.scopedRefPresent ? 'present' : 'not-recorded',
      fixture: fixture ?? 'none',
    },
    notes: [
      fixture === undefined
        ? 'Phase 37 shell mode is active; no TorBox transport is attached.'
        : 'Phase 38 fixture mode is active; only a local deterministic fake transport is attached.',
      'The command never contacts TorBox in Phase 38.',
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
  const result = report.ok ? 'PASS' : 'BLOCK';
  return [
    'torbox read-only smoke preflight shell:',
    `  command: ${report.command}`,
    `  mode: ${report.mode}`,
    `  probe: ${report.probe}`,
    `  operation: ${report.operation}`,
    `  result: ${result} (${report.category})`,
    `  would-contact-torbox: ${report.wouldContactTorBox}`,
    `  credential-ref: ${report.evidence.credentialRef}`,
    `  scoped-ref: ${report.evidence.scopedRef}`,
    `  fixture: ${report.evidence.fixture}`,
    `  availability: hit=${report.evidence.counts.availabilityHits} miss=${report.evidence.counts.availabilityMisses} unknown=${report.evidence.counts.availabilityUnknown}`,
    ...gateLines,
    '',
    'No live TorBox transport is attached in Phase 38.',
    '',
  ].join('\n');
}

export function torBoxSmokeShellUsage(): string {
  return [
    'usage: smoke:torbox-readonly --live-smoke --read-only --redacted --operator-authorized --credential-ref <opaque-ref> [--probe service-status|hoster-metadata|cache-availability] [--ref-type <type> --scoped-ref-present] [--fixture available|unavailable|unknown|auth|quota|timeout|parse|ambiguous-response] [--json]',
    '',
    'Phase 38 supports only local deterministic fixture output. It never contacts TorBox.',
  ].join('\n');
}

function gate(name: string, ok: boolean, category: TorBoxSmokeCategory): TorBoxSmokeGate {
  return ok ? { name, ok } : { name, ok, category };
}

function isTorBoxSmokeProbe(value: unknown): value is TorBoxSmokeProbe {
  return value === 'service-status' || value === 'hoster-metadata' || value === 'cache-availability';
}

function isTorBoxSmokeFixtureScenario(value: unknown): value is TorBoxSmokeFixtureScenario {
  return value === 'available'
    || value === 'unavailable'
    || value === 'unknown'
    || value === 'auth'
    || value === 'quota'
    || value === 'timeout'
    || value === 'parse'
    || value === 'ambiguous-response';
}

function isSupportedRefType(value: unknown): boolean {
  return typeof value === 'string' && (TORBOX_SMOKE_SHELL_SUPPORTED_REF_TYPES as readonly string[]).includes(value);
}

function fixtureCategoryFor(fixture: TorBoxSmokeFixtureScenario | undefined): TorBoxSmokeCategory {
  if (fixture === undefined || fixture === 'available' || fixture === 'unavailable' || fixture === 'unknown') return 'fixture-ok';
  return fixture;
}
