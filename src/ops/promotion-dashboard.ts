import { createHash } from 'node:crypto';

// Local, non-live offline acceptance dashboard. It consumes the rehearsal-matrix manifest, the
// artifact-integrity report, the artifact-schema report, and the coordinator handoff packet, and
// renders a single redaction-safe dashboard that is READY only when ALL FOUR are green. It reads parsed
// JSON only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin, and
// authorizes nothing live.

export interface DashboardInput {
  readonly matrix?: unknown;
  readonly integrity?: unknown;
  readonly schema?: unknown;
  readonly handoff?: unknown;
}

export interface DashboardPanel {
  readonly source: 'matrix' | 'integrity' | 'schema' | 'handoff';
  readonly present: boolean;
  readonly ok: boolean;
  readonly status?: string;
  readonly digest?: string;
}

export interface AcceptanceDashboard {
  readonly report: 'phase-230-promotion-acceptance-dashboard';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'DASHBOARD_READY' | 'DASHBOARD_BLOCKED';
  readonly panels: readonly DashboardPanel[];
  readonly blockers: readonly string[];
  readonly dashboardDigest: string;
}

export function buildAcceptanceDashboard(input: DashboardInput): AcceptanceDashboard {
  const blockers: string[] = [];
  const panels: DashboardPanel[] = [];

  panels.push(evaluate('matrix', input.matrix, {
    report: 'phase-230-promotion-rehearsal-matrix', okField: (o) => o.outcome === 'MATRIX_PASS',
    statusField: 'outcome', digestField: 'matrixDigest',
    missing: 'MATRIX_MISSING', invalid: 'MATRIX_INVALID', notOk: 'MATRIX_NOT_PASS',
  }, blockers));

  panels.push(evaluate('integrity', input.integrity, {
    report: 'phase-230-promotion-artifact-integrity', okField: (o) => o.ok === true,
    statusField: 'ok', digestField: 'integrityDigest',
    missing: 'INTEGRITY_MISSING', invalid: 'INTEGRITY_INVALID', notOk: 'INTEGRITY_NOT_OK',
  }, blockers));

  panels.push(evaluate('schema', input.schema, {
    report: 'phase-230-promotion-artifact-schema', okField: (o) => o.ok === true,
    statusField: 'ok', digestField: 'schemaDigest',
    missing: 'SCHEMA_MISSING', invalid: 'SCHEMA_INVALID', notOk: 'SCHEMA_NOT_OK',
  }, blockers));

  panels.push(evaluate('handoff', input.handoff, {
    report: 'phase-230-promotion-coordinator-handoff', okField: (o) => o.handoffState === 'READY_FOR_COORDINATOR' && o.authorization === 'NONE',
    statusField: 'handoffState', digestField: 'handoffDigest',
    missing: 'HANDOFF_MISSING', invalid: 'HANDOFF_INVALID', notOk: 'HANDOFF_NOT_READY',
  }, blockers));

  const overall: AcceptanceDashboard['overall'] = blockers.length === 0 ? 'DASHBOARD_READY' : 'DASHBOARD_BLOCKED';
  const withoutDigest: Omit<AcceptanceDashboard, 'dashboardDigest'> = {
    report: 'phase-230-promotion-acceptance-dashboard',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    panels,
    blockers,
  };
  return { ...withoutDigest, dashboardDigest: digest('phase-230-acceptance-dashboard', JSON.stringify(withoutDigest)) };
}

interface PanelSpec {
  readonly report: string;
  readonly okField: (o: Record<string, unknown>) => boolean;
  readonly statusField: string;
  readonly digestField: string;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
}

function evaluate(source: DashboardPanel['source'], value: unknown, spec: PanelSpec, blockers: string[]): DashboardPanel {
  if (value === undefined) {
    blockers.push(spec.missing);
    return { source, present: false, ok: false };
  }
  const obj = asObject(value);
  if (obj.report !== spec.report) {
    blockers.push(spec.invalid);
    return { source, present: true, ok: false };
  }
  const ok = spec.okField(obj);
  if (!ok) blockers.push(spec.notOk);
  const rawStatus = obj[spec.statusField];
  const status = typeof rawStatus === 'string' ? rawStatus : (typeof rawStatus === 'boolean' ? String(rawStatus) : undefined);
  const rawDigest = obj[spec.digestField];
  return {
    source, present: true, ok,
    ...(status !== undefined ? { status } : {}),
    ...(isSha256(rawDigest) ? { digest: rawDigest as string } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
