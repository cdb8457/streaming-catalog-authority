import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildCustodyLedger,
  buildCustodyLedgerGenesisSkeleton,
  type CustodyLedgerInput,
} from './promotion-chain-custody-ledger.js';

// Phase 239 append-only promotion-chain custody ledger CLI. Given the Phase 238 source-record verification and
// a separately supplied array of human custody events, it checks the ledger as a hash-linked append-only chain:
// contiguous sequence from a genesis, each event naming the recomputed digest of the one before it, a valid
// transition, a custodian digest, a strict UTC time, and every chain binding tied to this one operation.
//
// It NEVER infers custody. With --skeletonout it writes only a BLANK genesis -- custodian and time PENDING --
// which validates as CUSTODY_LEDGER_PENDING and claims nothing. Completing it changes the body, so the
// custodian must recompute `eventDigest` before appending.
//
// Honest limit: event digests are not signatures. An edit to any event WITH SUCCESSORS is detectable because
// every later link breaks; resealing the tail, appending to it, or rebuilding the ledger from genesis is not.
//
// Exit 0 = INTACT, 1 = INVALID (fail closed), 2 = input read error, 3 = PENDING (blank genesis, nothing
// claimed), 5 = NOT_ELIGIBLE (no verified source-record set for custody to be of).

const EXIT: Readonly<Record<string, number>> = {
  CUSTODY_LEDGER_INTACT: 0,
  CUSTODY_LEDGER_INVALID: 1,
  CUSTODY_LEDGER_PENDING: 3,
  NOT_ELIGIBLE: 5,
};

function usage(): string {
  return [
    'usage: ops:promotion-chain-custody-ledger --verification <phase-238-report.json> \\',
    '         [--events <custody-events.json>] [--out <report.json>] [--skeletonout <genesis-event.json>]',
    '',
    'Local, non-live. Validates a separately supplied append-only custody ledger over a Phase 238',
    'SOURCE_RECORDS_VERIFIED result. Detects fork, truncation, reorder, duplicate, splice, reseal, invalid',
    'transition, non-monotonic time, unknown fields and raw/live data -- each with its own fixed code.',
    '',
    '--events takes a JSON ARRAY of custody events. --skeletonout writes a blank genesis that claims nothing.',
    'Eligibility is checked on the whole Phase 238 body, not its headline; anything short of a sound',
    'SOURCE_RECORDS_VERIFIED is NOT_ELIGIBLE and no skeleton is emitted.',
    '',
    'It holds no custody and creates no events: custodyHeldByThisTool and eventsCreatedByThisTool are false.',
    'Exit 0 = INTACT, 1 = INVALID, 2 = input error, 3 = PENDING, 5 = NOT_ELIGIBLE.',
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
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const skeletonOut = valueAfter(args, '--skeletonout');
  const input: CustodyLedgerInput = {};
  try {
    for (const [key, flag] of [['verification', '--verification'], ['events', '--events']] as const) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }

  // Fail closed: a genesis is only emitted for a sound, eligible Phase 238 verification.
  const skeleton = skeletonOut ? buildCustodyLedgerGenesisSkeleton(input.verification) : null;
  if (skeletonOut && skeleton) writeJson(skeletonOut, skeleton);

  const report = buildCustodyLedger(input);
  if (out) writeJson(out, report);
  console.log(JSON.stringify({
    report: 'phase-239-promotion-chain-custody-ledger-capture',
    overall: report.overall,
    ledgerIntact: report.ledgerIntact,
    verificationEligible: report.verificationEligible,
    eventsWellFormed: report.eventsWellFormed,
    eventsRedactionSafe: report.eventsRedactionSafe,
    chainLinked: report.chainLinked,
    transitionsValid: report.transitionsValid,
    eventCount: report.eventCount,
    terminalTransition: report.terminalTransition,
    headEventDigest: report.headEventDigest,
    custodyHeldByThisTool: report.custodyHeldByThisTool,
    eventsCreatedByThisTool: report.eventsCreatedByThisTool,
    redactionSafe: true,
    events: report.events,
    boundDigests: report.boundDigests,
    boundary: report.boundary,
    blockers: report.blockers,
    ledgerDigest: report.ledgerDigest,
    ...(out ? { outputWritten: true } : {}),
    ...(skeletonOut ? { skeletonWritten: skeleton !== null } : {}),
  }, null, 2));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
