import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LOCAL_OPS_REGISTRY } from './promotion-acceptance-meta.js';

// Local, non-live static live-boundary policy compiler. It compiles the closed-live-boundary policy into a
// machine-readable rule set and verifies it statically over the repo: (1) no local tool source (module or
// CLI of any registered op) may contain a forbidden live hook -- network fetch, Jellyfin scan/auth/env, the
// deploy launcher, process spawning, or the live promotion CLI; (2) every registered op's doc must state
// the non-live / no-Phase-231 boundary; (3) only the rehearsal may invoke the guarded promotion service.
// It reads files + the shared registry only; it performs no promotion, never touches the real Movies root,
// never contacts Jellyfin, and authorizes nothing live. It fails closed on any violation. NOTE: every
// forbidden-hook literal below is assembled from fragments so this source itself carries none of them and
// stays clean under its own policy.

const J = (...parts: readonly string[]): string => parts.join('');

// The compiled policy: forbidden live-hook substrings for local tool sources.
const FORBIDDEN_HOOKS: readonly string[] = [
  J('fet', 'ch('),                                  // network
  J('Library', '/Refresh'),                         // Jellyfin scan/write
  J('X-Emby', '-Token'),                            // Jellyfin auth header
  J('JELLY', 'FIN_ENABLE_NETWORK'),                 // live Jellyfin env
  J('JELLY', 'FIN_ALLOW_LIVE_PUBLISH'),
  J('JELLY', 'FIN_API_KEY'),
  J('JELLY', 'FIN_BASE_URL'),
  J('JELLY', 'FIN_TRIGGER_LIBRARY_SCAN'),
  J('unraid-real', '-library-promotion.sh'),        // deploy launcher
  J('node:child', '_process'),                      // process spawning belongs only in tests
  J('real-library', '-promotion-cli'),              // the live promotion CLI
];

// Only the rehearsal may invoke the guarded promotion service.
const PROMOTION_CALL = J('runRealLibrary', 'Promotion(');
const ALLOWED_PROMOTION_CALLER = 'promotion-rehearsal';

const BOUNDARY_LANGUAGE = /no Phase 231|does not authorize Phase 231|no live-promotion|no live Jellyfin|never contacts Jellyfin/i;

export const BOUNDARY_POLICY_RULES: readonly string[] = ['no-forbidden-hooks', 'docs-state-boundary', 'sandboxed-promotion-caller'];
export const BOUNDARY_HOOK_COUNT = FORBIDDEN_HOOKS.length;

export interface PolicyRuleResult { readonly rule: string; readonly ok: boolean; }

export interface BoundaryPolicyReport {
  readonly report: 'phase-230-promotion-boundary-policy';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'BOUNDARY_POLICY_ENFORCED' | 'BOUNDARY_POLICY_VIOLATED';
  readonly ruleCount: number;
  readonly hookCount: number;
  readonly scannedSources: number;
  readonly scannedDocs: number;
  readonly rules: readonly PolicyRuleResult[];
  readonly violations: readonly string[];
  readonly policyDigest: string;
}

export function buildBoundaryPolicy(projectRoot: string): BoundaryPolicyReport {
  const read = (rel: string): string => { try { return readFileSync(`${projectRoot}/${rel}`, 'utf8'); } catch { return ''; } };
  const violations: string[] = [];

  // Rule 1: no local tool source contains a forbidden live hook.
  let hookFound = false;
  let scannedSources = 0;
  const promotionCallers: string[] = [];
  for (const { base } of LOCAL_OPS_REGISTRY) {
    for (const rel of [`src/ops/${base}.ts`, `src/ops/${base}-cli.ts`]) {
      const src = read(rel);
      scannedSources++;
      for (const hook of FORBIDDEN_HOOKS) if (src.includes(hook)) hookFound = true;
      if (src.includes(PROMOTION_CALL)) promotionCallers.push(base);
    }
  }
  if (hookFound) violations.push('FORBIDDEN_HOOK_FOUND');

  // Rule 2: every registered op's doc states the non-live / no-Phase-231 boundary.
  let boundaryMissing = false;
  let scannedDocs = 0;
  for (const { doc } of LOCAL_OPS_REGISTRY) {
    const text = read(`docs/${doc}.md`);
    scannedDocs++;
    if (!(text.includes('Phase 231') && BOUNDARY_LANGUAGE.test(text))) boundaryMissing = true;
  }
  if (boundaryMissing) violations.push('BOUNDARY_LANGUAGE_MISSING');

  // Rule 3: only the rehearsal invokes the guarded promotion service.
  const unsandboxed = promotionCallers.some((b) => b !== ALLOWED_PROMOTION_CALLER);
  if (unsandboxed) violations.push('UNSANDBOXED_PROMOTION_CALL');

  const rules: PolicyRuleResult[] = [
    { rule: 'no-forbidden-hooks', ok: !hookFound },
    { rule: 'docs-state-boundary', ok: !boundaryMissing },
    { rule: 'sandboxed-promotion-caller', ok: !unsandboxed },
  ];

  const overall: BoundaryPolicyReport['overall'] = violations.length === 0 ? 'BOUNDARY_POLICY_ENFORCED' : 'BOUNDARY_POLICY_VIOLATED';
  const withoutDigest: Omit<BoundaryPolicyReport, 'policyDigest'> = {
    report: 'phase-230-promotion-boundary-policy',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    ruleCount: rules.length,
    hookCount: FORBIDDEN_HOOKS.length,
    scannedSources,
    scannedDocs,
    rules,
    violations,
  };
  return { ...withoutDigest, policyDigest: digest('phase-230-boundary-policy', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
