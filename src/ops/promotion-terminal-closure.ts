import { createHash } from 'node:crypto';

// Local, non-live TERMINAL closure manifest -- the final record tying together all the local evidence. It
// consumes the transcript verification, the evidence minimizer / redaction proof, the commit-range closure,
// the regression oracle, and the coordinator readiness manifest, and confirms terminal closure only when
// every one is present, valid, green, and carries a valid self-digest (recorded in boundDigests). It
// restates the remaining human gates and the closed live-boundary. It reads parsed JSON only; it performs
// no promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes nothing live.
// CONFIRMED means the local evidence chain is complete for coordinator review -- it is NOT an approval, a
// merge, or a Phase 231 / live-promotion authorization.

export interface TerminalClosureInput {
  readonly transcriptVerification?: unknown;
  readonly evidenceMinimizer?: unknown;
  readonly commitRangeClosure?: unknown;
  readonly regressionOracle?: unknown;
  readonly coordinatorReadiness?: unknown;
}

export const TERMINAL_HUMAN_GATES: readonly string[] = [
  'Human review of the commit range and diff.',
  'Running the full `npm test` aggregate (legacy/live/CRLF/DB suites) if desired.',
  'Explicit coordinator ACCEPT recorded via the acceptance seal.',
  'The merge / tag / push-to-master action itself -- a human operator step NOT performed or authorized here.',
  'Phase 231 authorization, which is NOT granted by any tool, doc, or artifact here.',
];

export const TERMINAL_BOUNDARY =
  'No deploy launcher run, no real media-library write, no live Jellyfin call, no merge/tag/push/master, and no Phase 231 or live-promotion authorization is implied or performed by this manifest.';

export const TERMINAL_DISCLAIMERS: readonly string[] = [
  'CONFIRMED terminal closure is NOT an approval, a merge, or a live promotion.',
  'This manifest does NOT authorize Phase 231.',
  'No live Jellyfin call or real media write is implied or performed by this manifest.',
  'This is a redaction-safe, deterministic aggregation of offline records only.',
];

export interface ClosureComponent { readonly component: string; readonly present: boolean; readonly ok: boolean; }

export interface TerminalClosureManifest {
  readonly report: 'phase-230-promotion-terminal-closure-manifest';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'TERMINAL_CLOSURE_CONFIRMED' | 'TERMINAL_CLOSURE_NOT_CONFIRMED';
  readonly components: readonly ClosureComponent[];
  readonly boundDigests: Readonly<Record<string, string>>;
  readonly humanGates: readonly string[];
  readonly boundary: string;
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly terminalDigest: string;
}

interface Spec {
  readonly key: keyof TerminalClosureInput;
  readonly component: string;
  readonly report: string;
  readonly ok: (o: Record<string, unknown>) => boolean;
  readonly digestField: string;
  readonly missing: string;
  readonly invalid: string;
  readonly notOk: string;
}

const SPECS: readonly Spec[] = [
  { key: 'transcriptVerification', component: 'transcript-verification', report: 'phase-230-promotion-transcript-verification', ok: (o) => o.overall === 'TRANSCRIPT_VERIFIED', digestField: 'verificationDigest', missing: 'TRANSCRIPT_VERIFICATION_MISSING', invalid: 'TRANSCRIPT_VERIFICATION_INVALID', notOk: 'TRANSCRIPT_VERIFICATION_NOT_VERIFIED' },
  { key: 'evidenceMinimizer', component: 'evidence-minimizer', report: 'phase-230-promotion-evidence-minimizer', ok: (o) => o.overall === 'MINIMIZED_CLEAN', digestField: 'minimizerDigest', missing: 'EVIDENCE_MINIMIZER_MISSING', invalid: 'EVIDENCE_MINIMIZER_INVALID', notOk: 'EVIDENCE_MINIMIZER_NOT_CLEAN' },
  { key: 'commitRangeClosure', component: 'commit-range-closure', report: 'phase-230-promotion-commit-range-closure', ok: (o) => o.overall === 'RANGE_CLOSED', digestField: 'closureDigest', missing: 'COMMIT_RANGE_CLOSURE_MISSING', invalid: 'COMMIT_RANGE_CLOSURE_INVALID', notOk: 'COMMIT_RANGE_NOT_CLOSED' },
  { key: 'regressionOracle', component: 'regression-oracle', report: 'phase-230-promotion-regression-oracle', ok: (o) => o.overall === 'ORACLE_COMPLETE', digestField: 'oracleDigest', missing: 'REGRESSION_ORACLE_MISSING', invalid: 'REGRESSION_ORACLE_INVALID', notOk: 'REGRESSION_ORACLE_INCOMPLETE' },
  { key: 'coordinatorReadiness', component: 'coordinator-readiness', report: 'phase-230-promotion-coordinator-readiness-manifest', ok: (o) => o.overall === 'COORDINATOR_READINESS_CONFIRMED', digestField: 'readinessDigest', missing: 'COORDINATOR_READINESS_MISSING', invalid: 'COORDINATOR_READINESS_INVALID', notOk: 'COORDINATOR_READINESS_NOT_CONFIRMED' },
];

export function buildTerminalClosure(input: TerminalClosureInput): TerminalClosureManifest {
  const blockers: string[] = [];
  const boundDigests: Record<string, string> = {};
  const components: ClosureComponent[] = SPECS.map((spec) => {
    const value = input[spec.key];
    if (value === undefined) { blockers.push(spec.missing); return { component: spec.component, present: false, ok: false }; }
    const obj = asObject(value);
    if (obj.report !== spec.report) { blockers.push(spec.invalid); return { component: spec.component, present: true, ok: false }; }
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
  const overall: TerminalClosureManifest['overall'] = uniqueBlockers.length === 0 ? 'TERMINAL_CLOSURE_CONFIRMED' : 'TERMINAL_CLOSURE_NOT_CONFIRMED';
  const withoutDigest: Omit<TerminalClosureManifest, 'terminalDigest'> = {
    report: 'phase-230-promotion-terminal-closure-manifest',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    components,
    boundDigests,
    humanGates: TERMINAL_HUMAN_GATES,
    boundary: TERMINAL_BOUNDARY,
    blockers: uniqueBlockers,
    disclaimers: TERMINAL_DISCLAIMERS,
  };
  return { ...withoutDigest, terminalDigest: digest('phase-230-terminal-closure', JSON.stringify(withoutDigest)) };
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
