import { createCustodian, loadCustodianConfig } from '../core/crypto/custodian-factory.js';
import { closePool, getPool } from '../db/pool.js';
import {
  DEFAULT_PROOF_SAMPLE,
  MAX_PROOF_SAMPLE,
  proveCustody,
  renderCustodyProof,
} from './custody-proof.js';
import { isDirectRun } from './direct-run.js';

// Phase 302 (corrected) — `npm run ops:custody-proof`.
//
// IT RUNS INSIDE THE STACK, unlike the maintenance commands, because the thing it proves is a property of the
// running installation: that the key material in front of it opens the ciphertext in its database. It is the
// step `ops:complete-restore` runs last, and it is worth running on its own whenever an operator wants to
// know that the answer is still yes.
//
// IT IS READ-ONLY AND IT TAKES NO CREDENTIAL. Two `SELECT`s and a decryption, through the least-privileged
// runtime role and the custodian the environment already configures. It writes nothing and repairs nothing.
//
// EXIT CODES CARRY THE VERDICT, because a scheduler reads those and not a paragraph:
//
//   0  PROVEN — every record attempted decrypted.
//   1  NOT_PROVEN — at least one did not. After a restore this is what a keystore from another moment
//      looks like, and the installation will otherwise report itself healthy.
//   4  NO_ENCRYPTED_RECORDS — nothing encrypted to try. NOT a pass, and deliberately its own code so a
//      scheduler cannot collapse it into one.

export const CUSTODY_PROOF_EXIT_PROVEN = 0;
export const CUSTODY_PROOF_EXIT_NOT_PROVEN = 1;
export const CUSTODY_PROOF_EXIT_USAGE = 2;
export const CUSTODY_PROOF_EXIT_ERROR = 3;
export const CUSTODY_PROOF_EXIT_NOTHING_TO_PROVE = 4;

export function usage(): string {
  return [
    'usage: npm run ops:custody-proof [-- --json] [--sample <n>]',
    '',
    'Proves that this installation can DECRYPT its own catalog, through the shipped catalog authority and',
    'this installation\'s own custodian. Read-only: two SELECTs and a decryption. It writes nothing.',
    '',
    'This is the check that a keystore from the wrong moment fails. Everything else about such an',
    'installation — the doctor, the schema version, the web UI — reports itself healthy, because an item',
    'nobody can read is indistinguishable from an item that was correctly erased.',
    '',
    'options:',
    `  --sample <n>   how many active encrypted records to attempt (1-${MAX_PROOF_SAMPLE}, default ${DEFAULT_PROOF_SAMPLE})`,
    '  --json         print the machine-readable report',
    '',
    'It prints a verdict, counts and a bound. No title, no provider reference, no item id, no key id, no',
    'host path and no address ever reaches its output.',
    '',
    'exit codes: 0 proven | 1 NOT proven | 2 bad usage | 3 it could not run | 4 nothing encrypted to prove',
  ].join('\n');
}

export function parseSample(argv: readonly string[]): number | undefined {
  const index = argv.indexOf('--sample');
  if (index < 0) return undefined;
  const raw = argv[index + 1];
  if (raw === undefined) throw new Error('--sample needs a value');
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PROOF_SAMPLE) {
    throw new Error(`--sample must be a whole number between 1 and ${MAX_PROOF_SAMPLE}`);
  }
  return value;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage()); return CUSTODY_PROOF_EXIT_PROVEN; }
  const json = argv.includes('--json');
  let sample: number | undefined;
  try {
    sample = parseSample(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error('');
    console.error(usage());
    return CUSTODY_PROOF_EXIT_USAGE;
  }

  try {
    const report = await proveCustody(getPool(), createCustodian(loadCustodianConfig()),
      sample === undefined ? {} : { sample });
    console.log(json ? JSON.stringify(report, null, 2) : renderCustodyProof(report));
    if (report.verdict === 'PROVEN') return CUSTODY_PROOF_EXIT_PROVEN;
    return report.verdict === 'NO_ENCRYPTED_RECORDS'
      ? CUSTODY_PROOF_EXIT_NOTHING_TO_PROVE
      : CUSTODY_PROOF_EXIT_NOT_PROVEN;
  } catch {
    // NO MESSAGE FROM A FOREIGN ERROR. A driver's or the runtime's message routinely carries the connection
    // string or the absolute path it failed on, and this command's whole discipline is that nothing from
    // inside the installation reaches its output.
    console.error('the custody proof could not run: the database or the custodian could not be reached. '
      + 'Nothing was read and nothing was changed.');
    return CUSTODY_PROOF_EXIT_ERROR;
  } finally {
    await closePool();
  }
}

if (isDirectRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = CUSTODY_PROOF_EXIT_ERROR; });
}
