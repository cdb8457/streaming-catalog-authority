import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildFinalCoordinatorReadinessBundle, type FinalReadinessBundleInput } from './promotion-final-coordinator-readiness-bundle.js';

// Offline final coordinator readiness bundle CLI. Consumes the acceptance trace + no-live guard + live
// preflight plan + approval request packet + review checklist v2 + self-digest verification into one compact,
// redaction-safe coordinator artifact. It authorizes nothing (status PENDING, live boundary CLOSED). Never
// touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-final-coordinator-readiness-bundle --acceptancetrace <f> --noliveguard <f> --livepreflight <f> --approvalrequest <f> --checklistv2 <f> --selfdigest <f> [--out <bundle.json>]',
    '',
    'Local, non-live: FINAL_READINESS_BUNDLE_READY when every component re-verifies, no input claims a live',
    'authorization, redaction safety is proven, and the observed-state requirement is present. The live',
    'boundary stays CLOSED and Phase 231 authorization is NONE. Exit 0 = READY, 1 = BLOCKED.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}
function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} file is missing or not valid JSON`); }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const input: FinalReadinessBundleInput = {};
  try {
    const at = valueAfter(args, '--acceptancetrace');
    const ng = valueAfter(args, '--noliveguard');
    const lp = valueAfter(args, '--livepreflight');
    const ar = valueAfter(args, '--approvalrequest');
    const cv = valueAfter(args, '--checklistv2');
    const sd = valueAfter(args, '--selfdigest');
    if (at !== undefined) (input as Record<string, unknown>).acceptanceTrace = readJson(at, 'acceptanceTrace');
    if (ng !== undefined) (input as Record<string, unknown>).noLiveGuard = readJson(ng, 'noLiveGuard');
    if (lp !== undefined) (input as Record<string, unknown>).livePreflight = readJson(lp, 'livePreflight');
    if (ar !== undefined) (input as Record<string, unknown>).approvalRequest = readJson(ar, 'approvalRequest');
    if (cv !== undefined) (input as Record<string, unknown>).reviewChecklistV2 = readJson(cv, 'reviewChecklistV2');
    if (sd !== undefined) (input as Record<string, unknown>).selfDigest = readJson(sd, 'selfDigest');
  } catch (err) { console.error((err as Error).message); return 2; }
  const bundle = buildFinalCoordinatorReadinessBundle(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-final-coordinator-readiness-bundle-capture',
    overall: bundle.overall,
    authorization: bundle.authorization,
    status: bundle.status,
    redactionSafe: true,
    liveBoundaryStatus: bundle.liveBoundaryStatus,
    phase231Authorization: bundle.phase231Authorization,
    nextAction: bundle.nextAction,
    reportIds: bundle.reportIds,
    openBlockers: bundle.openBlockers,
    readinessBundleDigest: bundle.readinessBundleDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return bundle.overall === 'FINAL_READINESS_BUNDLE_READY' ? 0 : 1;
}

process.exit(main());
