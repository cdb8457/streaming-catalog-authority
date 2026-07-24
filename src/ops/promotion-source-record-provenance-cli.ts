import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildProvenanceCommitment,
  buildProvenanceCommitmentSkeleton,
  type ProvenanceCommitmentInput,
} from './promotion-source-record-provenance.js';

// Phase 237 source-record provenance commitment validator CLI. Given the Phase 236 replay report and a
// separately supplied human provenance manifest, it validates that the manifest is well-formed, redaction-safe,
// bound to that replay by digest, pairs each of the four human source records with the report digest its phase
// actually produced, and is coherent with the commitment decision recorded in it.
//
// It commits NOTHING itself and verifies NO identity: committedByThisTool and verifiedIdentityByThisTool are
// false. It holds no source record and computes no content digest -- it checks digests a human supplied. With
// --skeletonout it writes only an all-PENDING blank manifest for a human to complete; it never creates or
// infers a COMMITTED manifest and never invents a content digest.
//
// NOT_ELIGIBLE is distinct from INVALID and takes precedence: it means the CHAIN has nothing to commit
// provenance for (the replay is absent, not genuine, or not a fully verified closed chain), not that the
// supplied manifest is broken.
//
// Self-digests and content digests are not signatures and do not establish authorship.
//
// Exit 0 = COMMITTED, 1 = INVALID (fail closed), 2 = input read error, 3 = PENDING, 4 = DECLINED,
// 5 = NOT_ELIGIBLE.

const EXIT: Readonly<Record<string, number>> = {
  PROVENANCE_COMMITTED: 0,
  PROVENANCE_INVALID: 1,
  PROVENANCE_PENDING: 3,
  PROVENANCE_DECLINED: 4,
  NOT_ELIGIBLE: 5,
};

function usage(): string {
  return [
    'usage: ops:promotion-source-record-provenance --replay <phase-236-report.json> \\',
    '         [--manifest <provenance-manifest.json>] [--out <report.json>] [--skeletonout <manifest.json>]',
    '',
    'Local, non-live. Phase 236 proves the chain is consistent but does NOT pin WHICH human source records',
    'produced it -- identities, timestamps and the observed after-state are all swappable. This validator',
    'checks a separately supplied human manifest committing the content digests of the four human source',
    'records (Phases 232-235) to one replay digest and the five operation digests. Each entry must pair its',
    'phase with the report digest that phase actually produced, so substitution, omission, duplication,',
    'reordering, mismatched pairing and transplantation onto another replay all fail closed.',
    '',
    'It commits nothing and verifies no identity. Content digests are NOT signatures: a committer who controls',
    'the records can commit to any digests they like. What it buys is a point-in-time anchor, so a LATER',
    'substitution of any of those four records becomes detectable.',
    '',
    'NOT_ELIGIBLE means the chain has nothing to commit provenance for; no manifest can override it.',
    'Exit 0 = COMMITTED, 1 = INVALID, 2 = input error, 3 = PENDING, 4 = DECLINED, 5 = NOT_ELIGIBLE.',
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
  const input: ProvenanceCommitmentInput = {};
  const map: Array<[keyof ProvenanceCommitmentInput, string]> = [['replay', '--replay'], ['manifest', '--manifest']];
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }

  // Fail closed: a skeleton is only emitted for a genuine, fully verified closed replay.
  const skeleton = skeletonOut ? buildProvenanceCommitmentSkeleton(input.replay) : null;
  if (skeletonOut && skeleton) writeJson(skeletonOut, skeleton);

  const report = buildProvenanceCommitment(input);
  if (out) writeJson(out, report);
  console.log(JSON.stringify({
    report: 'phase-237-promotion-source-record-provenance-commitment-capture',
    overall: report.overall,
    recordedCommitment: report.recordedCommitment,
    provenanceCommitted: report.provenanceCommitted,
    replayEligible: report.replayEligible,
    committedByThisTool: report.committedByThisTool,
    verifiedIdentityByThisTool: report.verifiedIdentityByThisTool,
    redactionSafe: true,
    manifestWellFormed: report.manifestWellFormed,
    manifestRedactionSafe: report.manifestRedactionSafe,
    manifestBound: report.manifestBound,
    manifestCoherent: report.manifestCoherent,
    sourceRecordCount: report.sourceRecordCount,
    sourceRecords: report.sourceRecords,
    sourceCommitmentDigest: report.sourceCommitmentDigest,
    boundDigests: report.boundDigests,
    fieldStates: report.fieldStates,
    boundary: report.boundary,
    blockers: report.blockers,
    provenanceDigest: report.provenanceDigest,
    ...(out ? { outputWritten: true } : {}),
    ...(skeletonOut ? { skeletonWritten: skeleton !== null } : {}),
  }, null, 2));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
