import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyFinalBundleReplay, type FinalBundleReplayVerifierInput } from './promotion-final-bundle-replay-verifier.js';

// Offline final-bundle replay verifier CLI. Re-derives the operator acceptance trace and the final
// coordinator readiness bundle from the supplied leaves and confirms the supplied final bundle reproduces
// exactly. It authorizes nothing (status PENDING, live boundary CLOSED). Never touches the real Movies root,
// never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-final-bundle-replay-verifier --approvalrequest <f> --livepreflight <f> --noliveguard <f> --checklistv2 <f> --acceptancetrace <f> --selfdigest <f> --finalbundle <f> [--out <replay.json>]',
    '',
    'Local, non-live: FINAL_BUNDLE_REPLAY_VERIFIED only when the supplied final bundle reproduces exactly',
    'from its inputs -- recomputed trace/self-digest/final-bundle digests match, the reviewed commit binds,',
    'no input claims a live authorization, the observed-state requirement is present, and redaction is proven',
    '(no raw path). The live boundary stays CLOSED and Phase 231 authorization is NONE. Exit 0 = VERIFIED, 1 = BLOCKED.',
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
  const input: Record<string, unknown> = {};
  try {
    const flags: Array<[string, keyof FinalBundleReplayVerifierInput, string]> = [
      ['--approvalrequest', 'approvalRequest', 'approvalRequest'],
      ['--livepreflight', 'livePreflight', 'livePreflight'],
      ['--noliveguard', 'noLiveGuard', 'noLiveGuard'],
      ['--checklistv2', 'reviewChecklistV2', 'reviewChecklistV2'],
      ['--acceptancetrace', 'acceptanceTrace', 'acceptanceTrace'],
      ['--selfdigest', 'selfDigest', 'selfDigest'],
      ['--finalbundle', 'finalBundle', 'finalBundle'],
    ];
    for (const [flag, key, label] of flags) {
      const path = valueAfter(args, flag);
      if (path !== undefined) input[key] = readJson(path, label);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const report = verifyFinalBundleReplay(input as FinalBundleReplayVerifierInput);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-final-bundle-replay-verifier-capture',
    overall: report.overall,
    authorization: report.authorization,
    status: report.status,
    redactionSafe: true,
    liveBoundaryStatus: report.liveBoundaryStatus,
    phase231Authorization: report.phase231Authorization,
    checks: report.checks,
    blockers: report.blockers,
    replayVerifierDigest: report.replayVerifierDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.overall === 'FINAL_BUNDLE_REPLAY_VERIFIED' ? 0 : 1;
}

process.exit(main());
