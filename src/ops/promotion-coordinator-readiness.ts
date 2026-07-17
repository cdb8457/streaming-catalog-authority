import { createHash } from 'node:crypto';

// Local, non-live FINAL coordinator readiness manifest -- the terminal record of the Phase 230 hardening
// batch. It consumes the acceptance preflight, the failure-mode matrix, the report schema strictness pass,
// the final boundary audit, and the CLI ergonomics guard, and confirms coordinator readiness only when
// every one is present, valid, green, and carries a valid self-digest (recorded in boundDigests). It reads
// parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin,
// and authorizes nothing live. CONFIRMED means "the machine-side evidence is complete for coordinator
// review" -- it is NOT an approval, a merge, or a Phase 231 authorization, and the human gates remain.

export interface CoordinatorReadinessInput {
  readonly acceptancePreflight?: unknown;
  readonly failureMatrix?: unknown;
  readonly reportSchema?: unknown;
  readonly boundaryAudit?: unknown;
  readonly cliErgonomics?: unknown;
}

export const READINESS_HUMAN_GATES: readonly string[] = [
  'Human review of the commit range and diff.',
  'Running the full `npm test` aggregate (legacy/live/CRLF/DB suites) if desired.',
  'Explicit coordinator ACCEPT recorded via the acceptance seal.',
  'The merge / tag / push-to-master action itself -- a human operator step NOT performed or authorized here.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const READINESS_DISCLAIMERS: readonly string[] = [
  'CONFIRMED readiness is NOT an approval, a merge, or a live promotion.',
  'This manifest does NOT authorize Phase 231.',
  'No live Jellyfin call or real Movies write is implied or performed by this manifest.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface ReadinessComponent { readonly component: string; readonly present: boolean; readonly ok: boolean; }

export interface CoordinatorReadinessManifest {
  readonly report: 'phase-230-promotion-coordinator-readiness-manifest';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'COORDINATOR_READINESS_CONFIRMED' | 'COORDINATOR_READINESS_NOT_CONFIRMED';
  readonly components: readonly ReadinessComponent[];
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly humanGates: readonly string[];
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly readinessDigest: string;
}

interface Spec {
  readonly key: keyof CoordinatorReadinessInput;
  readonly component: string;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly digestField: string;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
}

const SPECS: readonly Spec[] = [
  { key: 'acceptancePreflight', component: 'acceptance-preflight', report: 'phase-230-promotion-acceptance-preflight', ok: (o) => o.overall === 'PREFLIGHT_READY', digestField: 'preflightDigest', missing: 'ACCEPTANCE_PREFLIGHT_MISSING', invalid: 'ACCEPTANCE_PREFLIGHT_INVALID', notOk: 'ACCEPTANCE_PREFLIGHT_NOT_READY' },
  { key: 'failureMatrix', component: 'failure-matrix', report: 'phase-230-promotion-failure-mode-matrix', ok: (o) => o.overall === 'FAILURE_MATRIX_COMPLETE', digestField: 'failureMatrixDigest', missing: 'FAILURE_MATRIX_MISSING', invalid: 'FAILURE_MATRIX_INVALID', notOk: 'FAILURE_MATRIX_INCOMPLETE' },
  { key: 'reportSchema', component: 'report-schema', report: 'phase-230-promotion-report-schema', ok: (o) => o.overall === 'REPORT_SCHEMA_OK', digestField: 'reportSchemaDigest', missing: 'REPORT_SCHEMA_MISSING', invalid: 'REPORT_SCHEMA_INVALID', notOk: 'REPORT_SCHEMA_NOT_OK' },
  { key: 'boundaryAudit', component: 'boundary-audit', report: 'phase-230-promotion-boundary-audit', ok: (o) => o.overall === 'BOUNDARY_AUDIT_CLEAN', digestField: 'auditDigest', missing: 'BOUNDARY_AUDIT_MISSING', invalid: 'BOUNDARY_AUDIT_INVALID', notOk: 'BOUNDARY_AUDIT_FAILED' },
  { key: 'cliErgonomics', component: 'cli-ergonomics', report: 'phase-230-promotion-cli-ergonomics', ok: (o) => o.overall === 'CLI_ERGONOMICS_OK', digestField: 'ergonomicsDigest', missing: 'CLI_ERGONOMICS_MISSING', invalid: 'CLI_ERGONOMICS_INVALID', notOk: 'CLI_ERGONOMICS_NOT_OK' },
];

export function buildCoordinatorReadiness(input: CoordinatorReadinessInput): CoordinatorReadinessManifest {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};
  const components: ReadinessComponent[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) { blockers.push(spec.missing); return { component: spec.component, present: false, ok: false }; }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { component: spec.component, present: true, ok: false }; }
    // Fail closed on the binding digest: every present input must carry a valid sha256 self-digest.
    const rawDigest = obj[spec.digestField];
    const d = asSha256(rawDigest);
    if (rawDigest === undefined) blockers.push('COMPONENT_DIGEST_MISSING');
    else if (d === undefined) blockers.push('COMPONENT_DIGEST_INVALID');
    if (d) boundDigests[spec.component] = d;
    const okState = spec.ok(obj);
    if (!okState) blockers.push(spec.notOk);
    return { component: spec.component, present: true, ok: okState && d !== undefined };
  });

  const uniqueBlockers = [...new Set(blockers)];
  const overall: CoordinatorReadinessManifest['overall'] = uniqueBlockers.length === 0 ? 'COORDINATOR_READINESS_CONFIRMED' : 'COORDINATOR_READINESS_NOT_CONFIRMED';
  const withoutDigest: Omit<CoordinatorReadinessManifest, 'readinessDigest'> = {
    report: 'phase-230-promotion-coordinator-readiness-manifest',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    components,
    boundDigests,
    humanGates: READINESS_HUMAN_GATES,
    blockers: uniqueBlockers,
    disclaimers: READINESS_DISCLAIMERS,
  };
  return { ...withoutDigest, readinessDigest: digest('phase-230-coordinator-readiness', JSON.stringify(withoutDigest)) };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
