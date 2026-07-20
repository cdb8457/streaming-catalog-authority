import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildLivePreflightPlan, type LivePreflightPlanInput } from './promotion-live-preflight-plan.js';

// Offline live-execution preflight plan validator CLI. Validates a proposed future live run plan as DATA ONLY;
// it never executes, schedules, approves, or authorizes anything. Never touches the real Movies root, never
// contacts Jellyfin/network.

function usage(): string {
  return [
    'usage: ops:promotion-live-preflight-plan --plan <plan.json> [--out <report.json>]',
    '',
    'Local, non-live: PREFLIGHT_PLAN_VALID only when every item carries a PENDING approval field + exact',
    'source/destination sha256 digests, and the plan declares no-clobber + same-checksum + observed-state +',
    'rollback + withdrawal constraints, with no raw path / Jellyfin / network / media surface anywhere. It does',
    'NOT execute or authorize the plan and does not authorize Phase 231. Exit 0 = VALID, 1 = INVALID.',
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
  const input: LivePreflightPlanInput = {};
  try {
    const plan = valueAfter(args, '--plan');
    if (plan !== undefined) (input as Record<string, unknown>).plan = JSON.parse(readFileSync(plan, 'utf8'));
  } catch { console.error('plan file is missing or not valid JSON'); return 2; }
  const report = buildLivePreflightPlan(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-live-preflight-plan-capture',
    overall: report.overall,
    authorization: report.authorization,
    status: report.status,
    redactionSafe: true,
    itemCount: report.itemCount,
    policyChecks: report.policyChecks,
    blockers: report.blockers,
    planDigest: report.planDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.overall === 'PREFLIGHT_PLAN_VALID' ? 0 : 1;
}

process.exit(main());
