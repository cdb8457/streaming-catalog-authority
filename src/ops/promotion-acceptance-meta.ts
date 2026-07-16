import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// Local, non-live acceptance meta-check. For every Phase 230 local op it confirms the presence of a
// module, a CLI, a test, a doc, ops+test package scripts, gate inclusion, and non-live boundary language
// in the doc, emitting a machine-readable meta-check report. It reads files + package.json only; it
// performs no promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes
// nothing live. LOCAL_OPS_REGISTRY is the single source of truth for the local op set (also consumed by
// the closure guard).

export interface LocalOp {
  readonly base: string;
  readonly doc: string;
}

export const LOCAL_OPS_REGISTRY: readonly LocalOp[] = [
  { base: 'promotion-approval', doc: 'PHASE_230_PROMOTION_APPROVAL_ATTESTATION' },
  { base: 'promotion-evidence-review', doc: 'PHASE_230_PROMOTION_EVIDENCE_REVIEW' },
  { base: 'promotion-readiness', doc: 'PHASE_230_PROMOTION_READINESS' },
  { base: 'promotion-acceptance-seal', doc: 'PHASE_230_PROMOTION_ACCEPTANCE_SEAL' },
  { base: 'promotion-rehearsal', doc: 'PHASE_230_PROMOTION_REHEARSAL' },
  { base: 'promotion-rehearsal-matrix', doc: 'PHASE_230_PROMOTION_REHEARSAL_MATRIX' },
  { base: 'promotion-artifact-integrity', doc: 'PHASE_230_PROMOTION_ARTIFACT_INTEGRITY' },
  { base: 'promotion-artifact-schema', doc: 'PHASE_230_PROMOTION_ARTIFACT_SCHEMA' },
  { base: 'promotion-dashboard', doc: 'PHASE_230_PROMOTION_DASHBOARD' },
  { base: 'promotion-handoff', doc: 'PHASE_230_PROMOTION_HANDOFF' },
  { base: 'promotion-fixture-bundle', doc: 'PHASE_230_PROMOTION_FIXTURE_BUNDLE' },
  { base: 'promotion-bundle-replay', doc: 'PHASE_230_PROMOTION_BUNDLE_REPLAY' },
  { base: 'promotion-evidence-packet', doc: 'PHASE_230_PROMOTION_EVIDENCE_PACKET' },
  { base: 'promotion-bundle-diff', doc: 'PHASE_230_PROMOTION_BUNDLE_DIFF' },
  { base: 'promotion-tamper-corpus', doc: 'PHASE_230_PROMOTION_TAMPER_CORPUS' },
  { base: 'promotion-review-transcript', doc: 'PHASE_230_PROMOTION_REVIEW_TRANSCRIPT' },
  { base: 'promotion-provenance-ledger', doc: 'PHASE_230_PROMOTION_PROVENANCE_LEDGER' },
  { base: 'promotion-gate-dag', doc: 'PHASE_230_PROMOTION_GATE_DAG' },
  { base: 'promotion-changelog', doc: 'PHASE_230_PROMOTION_CHANGELOG' },
  { base: 'promotion-archive-manifest', doc: 'PHASE_230_PROMOTION_ARCHIVE_MANIFEST' },
  { base: 'promotion-acceptance-meta', doc: 'PHASE_230_PROMOTION_ACCEPTANCE_META' },
  { base: 'promotion-injection-corpus', doc: 'PHASE_230_PROMOTION_INJECTION_CORPUS' },
  { base: 'promotion-review-bundle', doc: 'PHASE_230_PROMOTION_REVIEW_BUNDLE' },
  { base: 'promotion-consistency-matrix', doc: 'PHASE_230_PROMOTION_CONSISTENCY_MATRIX' },
  { base: 'promotion-self-digest-verifier', doc: 'PHASE_230_PROMOTION_SELF_DIGEST_VERIFIER' },
  { base: 'promotion-cli-contract', doc: 'PHASE_230_PROMOTION_CLI_CONTRACT' },
  { base: 'promotion-determinism', doc: 'PHASE_230_PROMOTION_DETERMINISM' },
];

export interface OpMetaCheck {
  readonly base: string;
  readonly hasModule: boolean;
  readonly hasCli: boolean;
  readonly hasTest: boolean;
  readonly hasDoc: boolean;
  readonly hasScripts: boolean;
  readonly inGate: boolean;
  readonly hasBoundary: boolean;
  readonly ok: boolean;
}

export interface AcceptanceMetaReport {
  readonly report: 'phase-230-promotion-acceptance-meta';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly ok: boolean;
  readonly ops: readonly OpMetaCheck[];
  readonly incomplete: readonly string[];
  readonly metaDigest: string;
}

export function buildAcceptanceMetaCheck(projectRoot: string): AcceptanceMetaReport {
  const exists = (rel: string): boolean => existsSync(`${projectRoot}/${rel}`);
  const readSafe = (rel: string): string => { try { return readFileSync(`${projectRoot}/${rel}`, 'utf8'); } catch { return ''; } };
  const pkg = JSON.parse(readSafe('package.json') || '{"scripts":{}}') as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const gate = scripts['test:phase230-local'] ?? '';

  const ops: OpMetaCheck[] = LOCAL_OPS_REGISTRY.map(({ base, doc }) => {
    const hasModule = exists(`src/ops/${base}.ts`);
    const hasCli = exists(`src/ops/${base}-cli.ts`);
    const hasTest = exists(`test/${base}.ts`);
    const hasDoc = exists(`docs/${doc}.md`);
    const hasScripts = typeof scripts[`ops:${base}`] === 'string' && typeof scripts[`test:${base}`] === 'string';
    const inGate = gate.includes(`tsx test/${base}.ts`);
    const docText = hasDoc ? readSafe(`docs/${doc}.md`) : '';
    const hasBoundary = docText.includes('Phase 231') && /no Phase 231|does not authorize Phase 231|no live-promotion|no live Jellyfin|never contacts Jellyfin/i.test(docText);
    const ok = hasModule && hasCli && hasTest && hasDoc && hasScripts && inGate && hasBoundary;
    return { base, hasModule, hasCli, hasTest, hasDoc, hasScripts, inGate, hasBoundary, ok };
  });

  const incomplete = ops.filter((o) => !o.ok).map((o) => o.base);
  const ok = incomplete.length === 0;
  const withoutDigest: Omit<AcceptanceMetaReport, 'metaDigest'> = {
    report: 'phase-230-promotion-acceptance-meta',
    version: 1,
    redactionSafe: true,
    ok,
    ops,
    incomplete,
  };
  return { ...withoutDigest, metaDigest: digest('phase-230-acceptance-meta', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
