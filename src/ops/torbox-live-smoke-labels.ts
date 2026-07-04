/**
 * Phase 50 - shared fixed labels for TorBox live-smoke evidence.
 *
 * Static label contract only. This module has no I/O, env, network, DB, transport, or provider
 * behavior. Keep Phase 43 report production, Phase 44 preflight, and Phase 49 summaries in lockstep.
 */

export const TORBOX_LIVE_SMOKE_PROBES = ['service-status', 'hoster-metadata', 'cache-availability'] as const;
export type TorBoxLiveSmokeProbe = typeof TORBOX_LIVE_SMOKE_PROBES[number];

export const TORBOX_LIVE_SMOKE_OPERATIONS = ['status-check', 'hoster-list', 'cache-availability'] as const;
export type TorBoxLiveSmokeOperation = typeof TORBOX_LIVE_SMOKE_OPERATIONS[number];

export const TORBOX_LIVE_SMOKE_CATEGORIES = [
  'live-smoke-ok',
  'not-authorized',
  'not-read-only',
  'redaction-block',
  'unsupported-ref',
  'empty-ref',
  'auth',
  'quota',
  'timeout',
  'transport',
  'parse',
  'ambiguous-availability',
  'unknown',
] as const;
export type TorBoxLiveSmokeCategory = typeof TORBOX_LIVE_SMOKE_CATEGORIES[number];

export function isTorBoxLiveSmokeProbe(value: unknown): value is TorBoxLiveSmokeProbe {
  return typeof value === 'string' && includesFixedLabel(TORBOX_LIVE_SMOKE_PROBES, value);
}

export function isTorBoxLiveSmokeOperation(value: unknown): value is TorBoxLiveSmokeOperation {
  return typeof value === 'string' && includesFixedLabel(TORBOX_LIVE_SMOKE_OPERATIONS, value);
}

export function isTorBoxLiveSmokeCategory(value: unknown): value is TorBoxLiveSmokeCategory {
  return typeof value === 'string' && includesFixedLabel(TORBOX_LIVE_SMOKE_CATEGORIES, value);
}

export function torBoxLiveSmokeOperationForProbe(probe: TorBoxLiveSmokeProbe): TorBoxLiveSmokeOperation {
  if (probe === 'service-status') return 'status-check';
  if (probe === 'hoster-metadata') return 'hoster-list';
  return 'cache-availability';
}

export function fixedTorBoxLiveSmokeProbe(value: unknown): TorBoxLiveSmokeProbe | 'invalid-probe' {
  return isTorBoxLiveSmokeProbe(value) ? value : 'invalid-probe';
}

export function fixedTorBoxLiveSmokeOperation(value: unknown): TorBoxLiveSmokeOperation | 'invalid-operation' {
  return isTorBoxLiveSmokeOperation(value) ? value : 'invalid-operation';
}

export function fixedTorBoxLiveSmokeCategory(value: unknown): TorBoxLiveSmokeCategory | 'invalid-category' {
  return isTorBoxLiveSmokeCategory(value) ? value : 'invalid-category';
}

function includesFixedLabel<const T extends readonly string[]>(labels: T, value: string): value is T[number] {
  return (labels as readonly string[]).includes(value);
}
