import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// Local, non-live aggregator digest fail-open audit. Every aggregator that BINDS component self-digests
// (terminal-closure, coordinator-readiness, review-automation, chain-bundle, reviewer-pack, and the
// pack-component-integrity verifier) must RECOMPUTE each component's self-digest against its body -- not
// merely presence/format-validate the digest field. This guard proves that structurally: for each binder it
// requires the module to (a) delegate to the authoritative self-digest verifier, (b) fail closed with
// COMPONENT_DIGEST_MISMATCH when a well-formed digest does not recompute, and (c) carry a test that asserts
// that rejection (a green-status-but-tampered-body case). A binder that only validates shape is a fail-open
// and is reported. It reads source files + hashes only; it performs no promotion, never touches the real
// Movies root, never contacts Jellyfin, and authorizes nothing live. It carries no raw paths -- only op
// short-names, booleans, counts, and fixed-language codes -- and does not authorize Phase 231.

// A binder EMITS a COMPONENT_DIGEST_* blocker (a `blockers.push(...)`, not a data literal). This is the
// authoritative selector; declaration files (blocker-taxonomy, gate-dag) merely list the codes as data.
const BINDER_EMIT = /blockers\.push\('COMPONENT_DIGEST_(?:MISSING|MISMATCH)'\)/;
// The recompute delegation and the fail-closed mismatch emit a binder must carry.
const RECOMPUTE_CALL = /verifySelfDigests\(/;
const MISMATCH_EMIT = /blockers\.push\('COMPONENT_DIGEST_MISMATCH'\)/;
const MISMATCH_TOKEN = 'COMPONENT_DIGEST_MISMATCH';

export interface AggregatorAuditResult {
  readonly aggregator: string;
  readonly recomputes: boolean;       // delegates to the self-digest verifier
  readonly mismatchEnforced: boolean; // fails closed with COMPONENT_DIGEST_MISMATCH
  readonly mismatchTested: boolean;   // a test asserts the recompute rejection
  readonly conformant: boolean;
}

export interface AggregatorDigestAuditReport {
  readonly report: 'phase-230-promotion-aggregator-digest-audit';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'AGGREGATOR_AUDIT_CLEAN' | 'AGGREGATOR_AUDIT_FAILED';
  readonly binderCount: number;
  readonly conformantCount: number;
  readonly aggregators: readonly AggregatorAuditResult[];
  readonly gaps: readonly string[];
  readonly auditDigest: string;
}

export interface AggregatorSource {
  readonly name: string;
  readonly moduleSrc: string;
  readonly testSrc: string;
}

// Pure core: given each binder's module + test source, prove it recomputes rather than shape-validates.
export function auditAggregators(inputs: readonly AggregatorSource[]): AggregatorDigestAuditReport {
  const gaps: string[] = [];
  const aggregators: AggregatorAuditResult[] = [...inputs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((input) => {
      const recomputes = RECOMPUTE_CALL.test(input.moduleSrc);
      const mismatchEnforced = MISMATCH_EMIT.test(input.moduleSrc);
      const mismatchTested = input.testSrc.includes(MISMATCH_TOKEN);
      if (!recomputes) gaps.push('RECOMPUTE_ABSENT');
      if (!mismatchEnforced) gaps.push('MISMATCH_NOT_ENFORCED');
      if (!mismatchTested) gaps.push('MISMATCH_UNTESTED');
      const conformant = recomputes && mismatchEnforced && mismatchTested;
      return { aggregator: input.name, recomputes, mismatchEnforced, mismatchTested, conformant };
    });

  if (aggregators.length === 0) gaps.push('NO_BINDERS_FOUND');

  const uniqueGaps = [...new Set(gaps)];
  const overall: AggregatorDigestAuditReport['overall'] = uniqueGaps.length === 0 ? 'AGGREGATOR_AUDIT_CLEAN' : 'AGGREGATOR_AUDIT_FAILED';
  const withoutDigest: Omit<AggregatorDigestAuditReport, 'auditDigest'> = {
    report: 'phase-230-promotion-aggregator-digest-audit',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    binderCount: aggregators.length,
    conformantCount: aggregators.filter((a) => a.conformant).length,
    aggregators,
    gaps: uniqueGaps,
  };
  return { ...withoutDigest, auditDigest: digest('phase-230-aggregator-digest-audit', JSON.stringify(withoutDigest)) };
}

// Filesystem wrapper: discover the component-digest binders in src/ops and audit each against its test.
export function buildAggregatorDigestAudit(projectRoot: string): AggregatorDigestAuditReport {
  const read = (rel: string): string => { try { return readFileSync(`${projectRoot}/${rel}`, 'utf8'); } catch { return ''; } };
  let files: string[] = [];
  try { files = readdirSync(`${projectRoot}/src/ops`).filter((f) => f.endsWith('.ts') && !f.endsWith('-cli.ts')); } catch { files = []; }

  const inputs: AggregatorSource[] = [];
  for (const f of files) {
    // This audit module itself carries COMPONENT_DIGEST_* tokens as regex/search literals; exclude it so it
    // is never mistaken for a binder (it does not bind or recompute component digests).
    if (f === 'promotion-aggregator-digest-audit.ts') continue;
    const moduleSrc = read(`src/ops/${f}`);
    if (!BINDER_EMIT.test(moduleSrc)) continue;
    const base = f.replace(/\.ts$/, '');                 // e.g. promotion-terminal-closure
    const name = base.replace(/^promotion-/, '');        // e.g. terminal-closure (path-free enum label)
    const testRel = `test/${base}.ts`;
    const testSrc = existsSync(`${projectRoot}/${testRel}`) ? read(testRel) : '';
    inputs.push({ name, moduleSrc, testSrc });
  }
  return auditAggregators(inputs);
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
