import { createHash } from 'node:crypto';

// Local, non-live automation / watchdog hygiene report. The Orca watcher that drives promotion automation
// must behave safely: it must debounce, be idempotent, deduplicate queued work by content digest, never
// auto-promote, and respect the closed live boundary. This report verifies that behavior from the records
// the watcher produces -- its declared config and its work queue -- WITHOUT running or contacting any
// watcher: it confirms the config declares the safe invariants, and that the queue carries no duplicate
// (same content digest queued twice), stale (belonging to a superseded run), or digest-malformed entries.
// It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
// Jellyfin, and authorizes nothing live (`authorization` is the constant NONE). It echoes only content
// digests (hex), status enums, booleans, and counts -- never raw paths or titles.

export interface WatchdogHygieneInput {
  readonly config?: unknown;
  readonly queue?: unknown;
  readonly currentRun?: unknown; // entries not belonging to this run id are stale
}

const ALLOWED_STATUS: readonly string[] = ['queued', 'processed', 'skipped'];

export const WATCHDOG_DISCLAIMERS: readonly string[] = [
  'A CLEAN watchdog report does NOT authorize any promotion, merge, or live action.',
  'This report does NOT authorize Phase 231.',
  'No live Jellyfin call or real Movies write is implied or performed by this report.',
  'This is a redaction-safe, deterministic check over offline records only.',
];

export interface QueueEntryResult {
  readonly itemDigest: string | null;
  readonly status: string | null;
  readonly wellFormed: boolean;
  readonly fresh: boolean;
  readonly duplicate: boolean;
}

export interface WatchdogHygieneReport {
  readonly report: 'phase-230-promotion-watchdog-hygiene';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'WATCHDOG_HYGIENE_CLEAN' | 'WATCHDOG_HYGIENE_VIOLATED';
  readonly configSafe: boolean;
  readonly queueCount: number;
  readonly uniqueCount: number;
  readonly entries: readonly QueueEntryResult[];
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly watchdogDigest: string;
}

export function buildWatchdogHygiene(input: WatchdogHygieneInput): WatchdogHygieneReport {
  const blockers: string[] = [];

  // 1) The watcher config must declare every safe-behavior invariant.
  const config = asObject(input.config);
  let configSafe = false;
  if (input.config === undefined || typeof input.config !== 'object' || Array.isArray(input.config)) {
    blockers.push('WATCHER_CONFIG_MISSING');
  } else {
    const debounceOk = typeof config.debounceMs === 'number' && Number.isFinite(config.debounceMs) && config.debounceMs > 0;
    if (!debounceOk) blockers.push('WATCHER_DEBOUNCE_MISSING');
    if (config.idempotent !== true) blockers.push('WATCHER_NOT_IDEMPOTENT');
    if (config.autoPromote !== false) blockers.push('WATCHER_AUTO_PROMOTE_ENABLED');
    if (config.respectsLiveBoundary !== true) blockers.push('WATCHER_LIVE_BOUNDARY_UNGUARDED');
    if (config.deduplicateBy !== 'content-digest') blockers.push('WATCHER_DEDUPE_DISABLED');
    configSafe = debounceOk && config.idempotent === true && config.autoPromote === false
      && config.respectsLiveBoundary === true && config.deduplicateBy === 'content-digest';
  }

  // 2) The work queue must carry no malformed, duplicate, or stale entries.
  const currentRun = pathFreeString(input.currentRun);
  const rawQueue = Array.isArray(input.queue) ? input.queue : null;
  if (rawQueue === null) blockers.push('QUEUE_MISSING');

  const seen = new Map<string, number>();
  if (rawQueue) for (const e of rawQueue) { const d = asSha256(asObject(e).itemDigest); if (d) seen.set(d, (seen.get(d) ?? 0) + 1); }

  const entries: QueueEntryResult[] = (rawQueue ?? []).map((e) => {
    const o = asObject(e);
    const itemDigest = asSha256(o.itemDigest) ?? null;
    const status = typeof o.status === 'string' ? o.status : null;
    const run = pathFreeString(o.run);
    const wellFormed = itemDigest !== null && status !== null && ALLOWED_STATUS.includes(status) && run !== null;
    const duplicate = itemDigest !== null && (seen.get(itemDigest) ?? 0) > 1;
    const fresh = run !== null && (currentRun === null || run === currentRun);
    if (itemDigest === null) blockers.push('ENTRY_DIGEST_MALFORMED');
    if (status === null || !ALLOWED_STATUS.includes(status ?? '')) blockers.push('ENTRY_STATUS_INVALID');
    if (run === null) blockers.push('ENTRY_RUN_MISSING');
    if (duplicate) blockers.push('DUPLICATE_QUEUE_ENTRY');
    if (run !== null && currentRun !== null && run !== currentRun) blockers.push('STALE_QUEUE_ENTRY');
    return { itemDigest, status, wellFormed, fresh, duplicate };
  });

  const uniqueBlockers = [...new Set(blockers)];
  const overall: WatchdogHygieneReport['overall'] = uniqueBlockers.length === 0 ? 'WATCHDOG_HYGIENE_CLEAN' : 'WATCHDOG_HYGIENE_VIOLATED';
  const withoutDigest: Omit<WatchdogHygieneReport, 'watchdogDigest'> = {
    report: 'phase-230-promotion-watchdog-hygiene',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    configSafe,
    queueCount: entries.length,
    uniqueCount: seen.size,
    entries,
    blockers: uniqueBlockers,
    disclaimers: WATCHDOG_DISCLAIMERS,
  };
  return { ...withoutDigest, watchdogDigest: digest('phase-230-watchdog-hygiene', JSON.stringify(withoutDigest)) };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function pathFreeString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value)) return null;
  return value;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
