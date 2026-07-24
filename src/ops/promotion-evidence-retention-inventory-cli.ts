import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildRetentionInventory,
  buildRetentionInventorySkeleton,
  type RetentionInventoryInput,
} from './promotion-evidence-retention-inventory.js';

// Phase 240 evidence retention and archival inventory CLI. Given the Phase 239 custody ledger and a separately
// supplied digest-only inventory, it checks that all NINE chain artifacts (Phases 231-239) are accounted for
// exactly once, that every entry claims only RETENTION, and that the inventory binds to this one ledger.
//
// It ARCHIVES NOTHING and DELETES NOTHING. With --skeletonout it writes only a BLANK inventory -- every
// artifact digest and every retention state PENDING -- which claims nothing and can never be COMPLETE.
//
// An inventory may never record a destruction: `retention` is a retention-only enum, and any purge/deletion
// vocabulary anywhere in the supplied record fails closed. It is also the highest-risk leak point in the
// stack, so any path, location or network endpoint fails closed too -- and is never echoed back.
//
// Supply --reports to BIND each claimed artifact digest against the real artifact. Without it the claimed
// digests were checked against nothing and the best available verdict is STRUCTURAL_ONLY, never COMPLETE.
//
// Honest limit: this proves an accounting, not an existence. It cannot show the artifacts exist, are readable,
// or will continue to; and it cannot tell a destroyed artifact re-listed as PENDING from an unfinished one.
//
// Exit 0 = COMPLETE, 1 = INVALID (fail closed), 2 = input read error, 3 = PENDING (nothing inventoried),
// 4 = STRUCTURAL_ONLY (accounted for, but nothing bound), 5 = NOT_ELIGIBLE (no closed custody ledger).

const EXIT: Readonly<Record<string, number>> = {
  INVENTORY_COMPLETE: 0,
  INVENTORY_INVALID: 1,
  INVENTORY_PENDING: 3,
  INVENTORY_STRUCTURAL_ONLY: 4,
  NOT_ELIGIBLE: 5,
};

function usage(): string {
  return [
    'usage: ops:promotion-evidence-retention-inventory --ledger <phase-239-report.json> \\',
    '         [--inventory <retention-inventory.json>] [--reports <artifacts-by-phase.json>] \\',
    '         [--out <report.json>] [--skeletonout <blank-inventory.json>]',
    '',
    'Local, non-live. Validates a separately supplied digest-only retention inventory over a Phase 239',
    'CUSTODY_LEDGER_INTACT whose custody has been RELEASED. Requires one-to-one coverage of all nine chain',
    'artifacts (Phases 231-239): omission, duplication, reordering and a wrong phase set each fail closed with',
    'their own code, as does transplantation onto a different ledger.',
    '',
    'An inventory may NEVER record a destruction -- retention is a retention-only enum and any purge/deletion',
    'vocabulary anywhere fails closed. Any path, location or network endpoint fails closed and is never echoed.',
    '',
    '--reports takes a JSON object keyed by phase ("231".."239") carrying the real artifacts, which BINDS each',
    'claimed digest. Without it, nothing was checked against anything: the verdict is capped at',
    'STRUCTURAL_ONLY. --skeletonout writes a blank inventory that claims nothing.',
    '',
    'Eligibility is checked on the whole Phase 239 body, not its headline. It archives and deletes nothing:',
    'archivedByThisTool, deletedByThisTool and retrievedByThisTool are false.',
    'Exit 0 = COMPLETE, 1 = INVALID, 2 = input error, 3 = PENDING, 4 = STRUCTURAL_ONLY, 5 = NOT_ELIGIBLE.',
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
  const input: RetentionInventoryInput = {};
  try {
    for (const [key, flag] of [['ledger', '--ledger'], ['inventory', '--inventory'], ['reports', '--reports']] as const) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }

  // Fail closed: a blank inventory is only emitted for a sound, eligible, released custody ledger.
  const skeleton = skeletonOut ? buildRetentionInventorySkeleton(input.ledger) : null;
  if (skeletonOut && skeleton) writeJson(skeletonOut, skeleton);

  const report = buildRetentionInventory(input);
  if (out) writeJson(out, report);
  console.log(JSON.stringify({
    report: 'phase-240-promotion-evidence-retention-inventory-capture',
    overall: report.overall,
    recordedInventory: report.recordedInventory,
    inventoryComplete: report.inventoryComplete,
    ledgerEligible: report.ledgerEligible,
    inventoryWellFormed: report.inventoryWellFormed,
    inventoryRedactionSafe: report.inventoryRedactionSafe,
    inventoryBound: report.inventoryBound,
    inventoryCoherent: report.inventoryCoherent,
    coverageComplete: report.coverageComplete,
    allEntriesBound: report.allEntriesBound,
    allEntriesRetained: report.allEntriesRetained,
    destructionClaimed: report.destructionClaimed,
    archivedByThisTool: report.archivedByThisTool,
    deletedByThisTool: report.deletedByThisTool,
    retrievedByThisTool: report.retrievedByThisTool,
    redactionSafe: true,
    entryCount: report.entryCount,
    entries: report.entries,
    boundDigests: report.boundDigests,
    fieldStates: report.fieldStates,
    boundary: report.boundary,
    blockers: report.blockers,
    inventoryDigest: report.inventoryDigest,
    ...(out ? { outputWritten: true } : {}),
    ...(skeletonOut ? { skeletonWritten: skeleton !== null } : {}),
  }, null, 2));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
