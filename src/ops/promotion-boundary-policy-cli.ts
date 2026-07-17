import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoundaryPolicy } from './promotion-boundary-policy.js';

// Offline static live-boundary policy CLI. Compiles the closed-live-boundary policy and verifies it
// statically over the repo. Never promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-boundary-policy [--out <policy.json>]',
    '',
    'Local, non-live: BOUNDARY_POLICY_ENFORCED when no local tool source carries a live hook, every op doc',
    'states the non-live boundary, and only the rehearsal invokes the guarded promotion service. It',
    'authorizes NOTHING live and does not authorize Phase 231. Exit 0 = ENFORCED, 1 = VIOLATED.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const policy = buildBoundaryPolicy(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(policy, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-boundary-policy-capture',
    overall: policy.overall,
    authorization: policy.authorization,
    redactionSafe: true,
    ruleCount: policy.ruleCount,
    hookCount: policy.hookCount,
    scannedSources: policy.scannedSources,
    scannedDocs: policy.scannedDocs,
    rules: policy.rules,
    violations: policy.violations,
    policyDigest: policy.policyDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return policy.overall === 'BOUNDARY_POLICY_ENFORCED' ? 0 : 1;
}

process.exit(main());
