import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LOCAL_OPS_REGISTRY } from './promotion-acceptance-meta.js';
import { buildBoundaryPolicy } from './promotion-boundary-policy.js';

// Local, non-live FINAL boundary audit. It re-verifies the compiled boundary policy and then audits beyond
// it: no registered op source may carry a network endpoint URL (the corpus payload modules are excluded --
// they hold adversarial text as data), no registered op source may read the process environment (so every
// tool stays deterministic and cannot be steered toward a live surface by env), the local gate must
// reference ONLY local suites, and the human-facing index docs must still state the Phase 231 boundary. It
// reads files + the shared registry only; it performs no promotion, never touches the real Movies root,
// never contacts Jellyfin, and authorizes nothing live. Every probed literal is fragment-assembled so this
// source stays clean under its own audit.

const J = (...parts: readonly string[]): string => parts.join('');

const NETWORK_MARKERS: readonly string[] = [J('http', '://'), J('https', '://'), J('ws', '://'), J('wss', '://')];
const ENV_MARKER = J('process.', 'env');

// Corpus payload modules: they carry adversarial text as data and are excluded from the URL rule only.
const PAYLOAD_MODULES: readonly string[] = [
  'promotion-injection-corpus', 'promotion-tamper-corpus', 'promotion-negative-evidence-corpus', 'promotion-redaction-corpus',
];

// Test-only suites + the guarded service that legitimately appear in the local gate.
const NON_TOOL_SUITES: readonly string[] = ['real-library-promotion', 'promotion-live-boundary-guard', 'phase230-local-suite-manifest', 'phase230-closure'];

const INDEX_DOCS: readonly string[] = ['PHASE_230_LOCAL_TOOLING_INDEX', 'PHASE_230_LOCAL_CLOSURE_INDEX', 'PHASE_230_LOCAL_SAFETY_SUITE'];

export interface AuditRuleResult { readonly rule: string; readonly ok: boolean; }

export interface BoundaryAuditReport {
  readonly report: 'phase-230-promotion-boundary-audit';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'BOUNDARY_AUDIT_CLEAN' | 'BOUNDARY_AUDIT_FAILED';
  readonly ruleCount: number;
  readonly scannedSources: number;
  readonly scannedDocs: number;
  readonly rules: readonly AuditRuleResult[];
  readonly violations: readonly string[];
  readonly auditDigest: string;
}

export function buildBoundaryAudit(projectRoot: string): BoundaryAuditReport {
  const read = (rel: string): string => { try { return readFileSync(`${projectRoot}/${rel}`, 'utf8'); } catch { return ''; } };
  const violations: string[] = [];

  // Rule 1: the compiled boundary policy must be enforced.
  const policy = buildBoundaryPolicy(projectRoot);
  const policyOk = policy.overall === 'BOUNDARY_POLICY_ENFORCED';
  if (!policyOk) violations.push('AUDIT_POLICY_VIOLATED');

  // Rules 2 + 3: scan every registered op source.
  let urlFound = false;
  let envFound = false;
  let scannedSources = 0;
  for (const { base } of LOCAL_OPS_REGISTRY) {
    for (const rel of [`src/ops/${base}.ts`, `src/ops/${base}-cli.ts`]) {
      const src = read(rel);
      scannedSources++;
      if (!PAYLOAD_MODULES.includes(base)) {
        for (const marker of NETWORK_MARKERS) if (src.includes(marker)) urlFound = true;
      }
      if (src.includes(ENV_MARKER)) envFound = true;
    }
  }
  if (urlFound) violations.push('AUDIT_NETWORK_URL_FOUND');
  if (envFound) violations.push('AUDIT_ENV_READ_FOUND');

  // Rule 4: the local gate must exist and reference ONLY local suites.
  const pkg = JSON.parse(read('package.json') || '{"scripts":{}}') as { scripts?: Record<string, string> };
  const gate = (pkg.scripts ?? {})['test:phase230-local'] ?? '';
  const allowed = new Set<string>([...LOCAL_OPS_REGISTRY.map((r) => r.base), ...NON_TOOL_SUITES]);
  const referenced = [...gate.matchAll(/tsx test\/([a-z0-9-]+)\.ts/g)].map((m) => m[1]!);
  const gateOk = referenced.length > 0 && referenced.every((s) => allowed.has(s));
  if (!gateOk) violations.push('AUDIT_NON_LOCAL_SUITE');

  // Rule 5: the human-facing index docs must still state the Phase 231 boundary.
  let docDrift = false;
  let scannedDocs = 0;
  for (const doc of INDEX_DOCS) {
    const text = read(`docs/${doc}.md`);
    scannedDocs++;
    if (!(text.includes('Phase 231') && /no Phase 231|does not authorize Phase 231|no live-promotion|no live Jellyfin|never contacts Jellyfin/i.test(text))) docDrift = true;
  }
  if (docDrift) violations.push('AUDIT_DOC_DRIFT');

  const rules: AuditRuleResult[] = [
    { rule: 'policy-enforced', ok: policyOk },
    { rule: 'no-network-endpoints', ok: !urlFound },
    { rule: 'no-env-reads', ok: !envFound },
    { rule: 'gate-only-local', ok: gateOk },
    { rule: 'index-docs-state-boundary', ok: !docDrift },
  ];

  const overall: BoundaryAuditReport['overall'] = violations.length === 0 ? 'BOUNDARY_AUDIT_CLEAN' : 'BOUNDARY_AUDIT_FAILED';
  const withoutDigest: Omit<BoundaryAuditReport, 'auditDigest'> = {
    report: 'phase-230-promotion-boundary-audit',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    ruleCount: rules.length,
    scannedSources,
    scannedDocs,
    rules,
    violations,
  };
  return { ...withoutDigest, auditDigest: digest('phase-230-boundary-audit', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
