import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildSuppliedSourceVerification,
  buildSuppliedSourceVerificationSkeleton,
  type SuppliedSourceVerificationInput,
} from './promotion-supplied-source-record-verification.js';

// Phase 238 supplied-source-record verification CLI. Given the Phase 237 commitment report, the manifest it
// was made over, the Phase 231-235 reports and the four supplied human source records, it canonically digests
// each record, compares it to the digest committed for that phase, re-runs each phase's own validator to prove
// the report is the honest output of that record, and records a human verification decision.
//
// It retrieves NOTHING and verifies NO identity: retrievedByThisTool and identityVerifiedByThisTool are false.
// verifiedByThisTool is true because it genuinely does compute the comparison. With --skeletonout it writes
// only an all-PENDING blank verification record; it never creates or infers a VERIFIED one.
//
// Verification proves ONLY that the supplied bytes match the committed digests and re-derive their reports. It
// establishes no authorship, and it does not establish that these records are the ones historically used.
//
// A content mismatch is a FINDING, not an input error: mismatches make VERIFIED impossible but leave a human
// DECLINE open. Only a malformed, unbound or incoherent submission is INVALID -- as is affirming verification
// while mismatches stand.
//
// Exit 0 = VERIFIED, 1 = INVALID (fail closed), 2 = input read error, 3 = PENDING, 4 = DECLINED,
// 5 = NOT_ELIGIBLE.

const EXIT: Readonly<Record<string, number>> = {
  SOURCE_RECORDS_VERIFIED: 0,
  SOURCE_RECORDS_INVALID: 1,
  SOURCE_RECORDS_PENDING: 3,
  SOURCE_RECORDS_DECLINED: 4,
  NOT_ELIGIBLE: 5,
};

function usage(): string {
  return [
    'usage: ops:promotion-supplied-source-record-verification --commitment <phase-237-report.json> \\',
    '         --manifest <provenance-manifest.json> \\',
    '         --gate <231.json> --authorization <232.json> --observation <233.json> \\',
    '         --disposition <234.json> --closure <235.json> \\',
    '         --sourceauthorization <f> --sourceobservation <f> --sourcedisposition <f> --sourceclosure <f> \\',
    '         [--verification <decision.json>] [--out <report.json>] [--skeletonout <decision.json>]',
    '',
    'Local, non-live. Phase 237 records a human commitment to four content digests but never recomputes them.',
    'This phase is where the bytes are checked: each supplied source record is canonically digested (recursively',
    'key-sorted JSON, so key order does not matter) and compared to the digest committed for its phase, each',
    'supplied report must be the one committed, and each phase re-runs its OWN validator over the supplied',
    'record against the SUPPLIED parent -- so a doctored parent cannot be laundered by a clean child.',
    '',
    'Verification proves ONLY that the supplied bytes match the commitment. It is not a signature, establishes',
    'no authorship, and does not establish that these records are the ones historically used.',
    '',
    'NOT_ELIGIBLE means there is no sound commitment to verify against; no submission can override it.',
    'Exit 0 = VERIFIED, 1 = INVALID, 2 = input error, 3 = PENDING, 4 = DECLINED, 5 = NOT_ELIGIBLE.',
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
  const input: Record<string, unknown> = {};
  const reports: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  try {
    for (const [key, flag] of [['commitment', '--commitment'], ['manifest', '--manifest'], ['verification', '--verification']] as const) {
      const p = valueAfter(args, flag);
      if (p !== undefined) input[key] = readJson(p, key);
    }
    for (const [key, flag] of [
      ['gate', '--gate'], ['authorization', '--authorization'], ['observation', '--observation'],
      ['disposition', '--disposition'], ['closure', '--closure'],
    ] as const) {
      const p = valueAfter(args, flag);
      if (p !== undefined) reports[key] = readJson(p, key);
    }
    for (const [key, flag] of [
      ['authorizationDecision', '--sourceauthorization'], ['observation', '--sourceobservation'],
      ['disposition', '--sourcedisposition'], ['closure', '--sourceclosure'],
    ] as const) {
      const p = valueAfter(args, flag);
      if (p !== undefined) sources[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  if (Object.keys(reports).length > 0) input.reports = reports;
  if (Object.keys(sources).length > 0) input.sources = sources;

  // Fail closed: a skeleton is only emitted for a genuine, sound PROVENANCE_COMMITTED commitment.
  const skeleton = skeletonOut ? buildSuppliedSourceVerificationSkeleton(input.commitment) : null;
  if (skeletonOut && skeleton) writeJson(skeletonOut, skeleton);

  const report = buildSuppliedSourceVerification(input as SuppliedSourceVerificationInput);
  if (out) writeJson(out, report);
  console.log(JSON.stringify({
    report: 'phase-238-promotion-supplied-source-record-verification-capture',
    overall: report.overall,
    recordedVerification: report.recordedVerification,
    sourceRecordsVerified: report.sourceRecordsVerified,
    commitmentEligible: report.commitmentEligible,
    manifestBoundToCommitment: report.manifestBoundToCommitment,
    verifiedByThisTool: report.verifiedByThisTool,
    retrievedByThisTool: report.retrievedByThisTool,
    identityVerifiedByThisTool: report.identityVerifiedByThisTool,
    redactionSafe: true,
    verificationWellFormed: report.verificationWellFormed,
    verificationRedactionSafe: report.verificationRedactionSafe,
    verificationBound: report.verificationBound,
    verificationCoherent: report.verificationCoherent,
    sourcesRedactionSafe: report.sourcesRedactionSafe,
    allContentDigestsMatched: report.allContentDigestsMatched,
    allReportsRederived: report.allReportsRederived,
    sourceRecordCount: report.sourceRecordCount,
    sourceRecords: report.sourceRecords,
    mismatches: report.mismatches,
    boundDigests: report.boundDigests,
    fieldStates: report.fieldStates,
    boundary: report.boundary,
    blockers: report.blockers,
    verificationDigest: report.verificationDigest,
    ...(out ? { outputWritten: true } : {}),
    ...(skeletonOut ? { skeletonWritten: skeleton !== null } : {}),
  }, null, 2));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
