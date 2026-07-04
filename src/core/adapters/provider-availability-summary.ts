/**
 * Phase 57 - provider availability summary.
 *
 * Aggregates sanitized Phase 56 bridge reports into redaction-safe counts only. It is deliberately
 * pure and non-authoritative: no provider calls, no DB access, no persistence, no item rows, and no
 * provider detail echoing.
 */

export type ProviderAvailabilitySummaryReadiness = 'empty' | 'has-candidates' | 'all-skipped' | 'held';
export type ProviderAvailabilitySummaryStatus = 'available' | 'unavailable' | 'unknown' | 'stale' | 'invalid';
export type ProviderAvailabilitySummaryAction = 'candidate' | 'skip' | 'hold';

export interface ProviderAvailabilitySummary {
  readonly report: 'phase-57-provider-availability-summary';
  readonly source: 'sanitized-provider-availability-bridge-reports';
  readonly advisoryOnly: true;
  readonly persisted: false;
  readonly redactionSafe: true;
  readonly itemRowsIncluded: false;
  readonly providerDetailsIncluded: false;
  readonly rawRefsIncluded: false;
  readonly readiness: ProviderAvailabilitySummaryReadiness;
  readonly counts: {
    readonly total: number;
    readonly candidate: number;
    readonly skip: number;
    readonly hold: number;
    readonly available: number;
    readonly unavailable: number;
    readonly unknown: number;
    readonly stale: number;
    readonly invalid: number;
  };
}

interface SummaryInputReport {
  readonly decision?: {
    readonly status?: unknown;
    readonly action?: unknown;
  };
}

export function summarizeProviderAvailability(reports: readonly unknown[]): ProviderAvailabilitySummary {
  const counts = {
    total: 0,
    candidate: 0,
    skip: 0,
    hold: 0,
    available: 0,
    unavailable: 0,
    unknown: 0,
    stale: 0,
    invalid: 0,
  };

  for (const report of reports) {
    counts.total++;
    const input = isRecord(report) ? report as SummaryInputReport : {};
    const decision = isRecord(input.decision) ? input.decision : {};
    const status = sanitizeStatus(decision.status);
    const action = sanitizeAction(decision.action);
    counts[status]++;
    counts[action]++;
  }

  return {
    report: 'phase-57-provider-availability-summary',
    source: 'sanitized-provider-availability-bridge-reports',
    advisoryOnly: true,
    persisted: false,
    redactionSafe: true,
    itemRowsIncluded: false,
    providerDetailsIncluded: false,
    rawRefsIncluded: false,
    readiness: readiness(counts),
    counts,
  };
}

function sanitizeStatus(status: unknown): ProviderAvailabilitySummaryStatus {
  return status === 'available' || status === 'unavailable' || status === 'unknown' || status === 'stale'
    ? status
    : 'invalid';
}

function sanitizeAction(action: unknown): ProviderAvailabilitySummaryAction {
  return action === 'candidate' || action === 'skip' ? action : 'hold';
}

function readiness(counts: ProviderAvailabilitySummary['counts']): ProviderAvailabilitySummaryReadiness {
  if (counts.total === 0) return 'empty';
  if (counts.hold > 0) return 'held';
  if (counts.candidate > 0) return 'has-candidates';
  return 'all-skipped';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
