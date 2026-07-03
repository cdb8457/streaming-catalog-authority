import { TorBoxReadOnlyClient } from '../core/adapters/torbox-readonly-client.js';
import type { AdapterResult } from '../core/adapters/adapter.js';
import type { TorBoxTransport } from '../core/adapters/torbox-real-client-gate.js';
import type { TorBoxSmokeProbe, TorBoxSmokeShellOptions } from './torbox-smoke-shell.js';

/**
 * Phase 43 - redaction-safe TorBox live smoke runner.
 *
 * This module accepts an injected transport. It does not read env, read files, construct fetch,
 * import the TorBox SDK, connect to a DB, or emit provider payloads.
 */

export type TorBoxLiveSmokeCategory =
  | 'live-smoke-ok'
  | 'not-authorized'
  | 'not-read-only'
  | 'redaction-block'
  | 'unsupported-ref'
  | 'empty-ref'
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'transport'
  | 'parse'
  | 'ambiguous-availability'
  | 'unknown';

export interface TorBoxLiveSmokeRunnerInput {
  readonly options: TorBoxSmokeShellOptions;
  readonly transport: TorBoxTransport;
}

export interface TorBoxLiveSmokeReport {
  readonly report: 'phase-43-torbox-live-smoke-cli';
  readonly phase: 43;
  readonly ok: boolean;
  readonly liveSmokeAttempted: true;
  readonly wouldContactTorBox: true;
  readonly command: 'smoke:torbox-readonly';
  readonly mode: 'live-transport-smoke';
  readonly probe: TorBoxSmokeProbe;
  readonly operation: 'status-check' | 'hoster-list' | 'cache-availability';
  readonly category: TorBoxLiveSmokeCategory;
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
    readonly credentialFile: 'configured';
    readonly scopedRef: 'present' | 'not-recorded';
  };
  readonly notes: readonly string[];
}

export async function runTorBoxLiveSmoke(input: TorBoxLiveSmokeRunnerInput): Promise<TorBoxLiveSmokeReport> {
  const client = new TorBoxReadOnlyClient({ transport: input.transport });
  const result = await runProbe(client, input.options);
  const category = categoryFor(result);
  const ok = result.status === 'available' || result.status === 'unavailable' || result.status === 'unknown';

  return {
    report: 'phase-43-torbox-live-smoke-cli',
    phase: 43,
    ok,
    liveSmokeAttempted: true,
    wouldContactTorBox: true,
    command: 'smoke:torbox-readonly',
    mode: 'live-transport-smoke',
    probe: input.options.probe,
    operation: operationFor(input.options.probe),
    category,
    evidence: {
      statuses: [result.status],
      counts: {
        serviceStatusChecks: input.options.probe === 'service-status' ? 1 : 0,
        hosterMetadataChecks: input.options.probe === 'hoster-metadata' ? 1 : 0,
        cacheAvailabilityChecks: input.options.probe === 'cache-availability' ? 1 : 0,
        availabilityHits: result.status === 'available' ? 1 : 0,
        availabilityMisses: result.status === 'unavailable' ? 1 : 0,
        availabilityUnknown: result.status === 'unknown' ? 1 : 0,
      },
      credentialFile: 'configured',
      scopedRef: input.options.probe === 'cache-availability' ? 'present' : 'not-recorded',
    },
    notes: [
      'Phase 43 live smoke is operator-run only and absent from CI.',
      'Evidence is limited to fixed statuses, counts, operation names, and categories.',
      'No credential values, credential file paths, raw refs, provider payloads, or endpoint URLs are emitted.',
      'No provider mode, adapter-factory wiring, downloads, request-link calls, playback, or DB writes are added.',
      'O4 remains open/deferred; O5 remains open/deferred.',
      'FileCustodian remains a hardened reference harness, not production KMS.',
    ],
  };
}

export function formatTorBoxLiveSmokeJson(report: TorBoxLiveSmokeReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatTorBoxLiveSmokeText(report: TorBoxLiveSmokeReport): string {
  return [
    'torbox read-only live smoke:',
    `  command: ${report.command}`,
    `  mode: ${report.mode}`,
    `  probe: ${report.probe}`,
    `  operation: ${report.operation}`,
    `  result: ${report.ok ? 'PASS' : 'BLOCK'} (${report.category})`,
    `  would-contact-torbox: ${report.wouldContactTorBox}`,
    '  credential-file: configured',
    `  scoped-ref: ${report.evidence.scopedRef}`,
    `  availability: hit=${report.evidence.counts.availabilityHits} miss=${report.evidence.counts.availabilityMisses} unknown=${report.evidence.counts.availabilityUnknown}`,
    '',
  ].join('\n');
}

async function runProbe(client: TorBoxReadOnlyClient, options: TorBoxSmokeShellOptions): Promise<AdapterResult> {
  if (options.probe === 'service-status') return client.checkServiceStatus();
  if (options.probe === 'hoster-metadata') return client.checkHosters();
  return client.resolveRef({
    itemId: '00000000-0000-4000-8000-000000000043',
    refType: options.refType ?? '',
    refValue: options.scopedRefValue ?? '',
  });
}

function operationFor(probe: TorBoxSmokeProbe): TorBoxLiveSmokeReport['operation'] {
  if (probe === 'service-status') return 'status-check';
  if (probe === 'hoster-metadata') return 'hoster-list';
  return 'cache-availability';
}

function categoryFor(result: AdapterResult): TorBoxLiveSmokeCategory {
  if (result.status === 'available' || result.status === 'unavailable') return 'live-smoke-ok';
  if (result.detail === 'auth') return 'auth';
  if (result.detail === 'quota') return 'quota';
  if (result.detail === 'timeout') return 'timeout';
  if (result.detail === 'transport') return 'transport';
  if (result.detail === 'parse') return 'parse';
  if (result.detail === 'ambiguous-availability') return 'ambiguous-availability';
  if (result.detail === 'unsupported-ref-type') return 'unsupported-ref';
  if (result.detail === 'empty-ref-value') return 'empty-ref';
  return 'unknown';
}
