import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyPromotionChainReplay, type ChainReplayInput } from './promotion-chain-replay.js';

// Phase 236 end-to-end promotion chain replay verifier CLI. Given any prefix of the five chain reports
// (231 gate, 232 authorization, 233 observation, 234 disposition, 235 closure), it re-derives every
// inter-phase link and checks that all five operation digests are identical across every supplied report --
// catching a SPLICED chain that no single phase can see.
//
// Structural checks alone are RESEALABLE, so they earn only CHAIN_REPLAY_STRUCTURAL_ONLY. A VERIFIED verdict
// additionally requires the --source* records: each phase's own validator is re-run over the record it consumed
// and must reproduce that report's self-digest exactly.
//
// Absence is normal: the chain legitimately stops partway, which is not an error.
// It replays records and does nothing else -- no run, no capture, no closure, no authorization. It never runs
// the promotion launcher, reads or writes the real Movies library, contacts Jellyfin, or reads the secret
// approval file.
//
// Exit 0 = VERIFIED_CLOSED (re-derived end to end over one operation a human closed out), 1 = NOT_REPLAYABLE
// (fail closed), 2 = input read error, 3 = VERIFIED_OPEN (re-derived, not closed out), 4 = NO_INPUT,
// 5 = STRUCTURAL_ONLY (self-consistent but unverified -- source records not supplied).

const EXIT: Readonly<Record<string, number>> = {
  CHAIN_REPLAY_VERIFIED_CLOSED: 0,
  CHAIN_NOT_REPLAYABLE: 1,
  CHAIN_REPLAY_VERIFIED_OPEN: 3,
  CHAIN_REPLAY_NO_INPUT: 4,
  CHAIN_REPLAY_STRUCTURAL_ONLY: 5,
};

function usage(): string {
  return [
    'usage: ops:promotion-chain-replay [--gate <231.json>] [--authorization <232.json>] \\',
    '         [--observation <233.json>] [--disposition <234.json>] [--closure <235.json>] [--out <report.json>]',
    '         [--sourcegateevidence <f>] [--sourceauthorizationdecision <f>] [--sourceobservation <f>] \\',
    '         [--sourcedisposition <f>] [--sourceclosure <f>]',
    '',
    'Local, non-live. Replays the promotion record chain in one pass: every supplied report must recompute its',
    'own self-digest, every inter-phase link must re-derive against the parent report\'s own digest, the supplied',
    'set must be a contiguous prefix starting at Phase 231, and -- the point of this phase -- all five operation',
    'digests must be IDENTICAL across every report, anchored to the Phase 231 template. A spliced chain assembled',
    'from two operations fails here even though each report is individually valid.',
    '',
    'Those checks are all RESEALABLE, so on their own they earn only STRUCTURAL_ONLY. Supply the --source*',
    'records each phase consumed to unlock a VERIFIED verdict: each phase re-runs its OWN exported validator',
    'over that source and must reproduce the supplied report self-digest exactly. One unproven phase caps the',
    'whole verdict at STRUCTURAL_ONLY.',
    '',
    'Any subset may be omitted; a chain that stops partway is not an error.',
    'It replays only: performedByThisTool and capturedByThisTool are false.',
    'Exit 0 = VERIFIED_CLOSED, 1 = NOT_REPLAYABLE, 2 = input error, 3 = VERIFIED_OPEN, 4 = NO_INPUT,',
    '5 = STRUCTURAL_ONLY.',
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
  const input: ChainReplayInput = {};
  const map: Array<[keyof ChainReplayInput, string]> = [
    ['gate', '--gate'], ['authorization', '--authorization'], ['observation', '--observation'],
    ['disposition', '--disposition'], ['closure', '--closure'],
  ];
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
    const sources: Record<string, unknown> = {};
    const sourceMap: Array<[string, string]> = [
      ['gateEvidence', '--sourcegateevidence'], ['authorizationDecision', '--sourceauthorizationdecision'],
      ['observation', '--sourceobservation'], ['disposition', '--sourcedisposition'], ['closure', '--sourceclosure'],
    ];
    for (const [key, flag] of sourceMap) {
      const p = valueAfter(args, flag);
      if (p !== undefined) sources[key] = readJson(p, key);
    }
    if (Object.keys(sources).length > 0) (input as Record<string, unknown>).sources = sources;
  } catch (err) { console.error((err as Error).message); return 2; }

  const report = verifyPromotionChainReplay(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-236-promotion-chain-replay-verification-capture',
    overall: report.overall,
    terminalPhase: report.terminalPhase,
    chainComplete: report.chainComplete,
    operationClosed: report.operationClosed,
    semanticallyRederived: report.semanticallyRederived,
    identityAnchored: report.identityAnchored,
    suppliedCount: report.suppliedCount,
    replayedByThisTool: report.replayedByThisTool,
    performedByThisTool: report.performedByThisTool,
    capturedByThisTool: report.capturedByThisTool,
    redactionSafe: true,
    phases: report.phases,
    operationDigests: report.operationDigests,
    chainDigests: report.chainDigests,
    boundary: report.boundary,
    blockers: report.blockers,
    replayDigest: report.replayDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
