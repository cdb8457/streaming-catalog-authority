import type { Pool } from 'pg';
import { CatalogAuthority } from '../core/catalog/authority.js';
import type { KeyCustodian } from '../core/crypto/custodian.js';

// Phase 302 (corrected) — proving that this installation can actually DECRYPT its own catalog.
//
// -----------------------------------------------------------------------------------------------------
// WHAT WAS WRONG, AND IT WAS THE CENTRAL CLAIM OF THE TRANCHE.
// -----------------------------------------------------------------------------------------------------
//
// The restore's "decryption proof" ran `ops:collections status`. That command reads the managed-collection
// and history tables and COUNTS ROWS. It never constructs a `CatalogAuthority`, never asks the custodian for
// a key, and never decrypts anything — so it answers exactly as well on an installation whose keystore is
// missing, wrong, or from another moment as on one whose keystore is correct.
//
// The whole reason the keystore is a backup component is that an installation without it STARTS, PASSES
// EVERY CHECK AND REPORTS ITSELF HEALTHY, because a fail-closed unreadable item is indistinguishable from a
// correctly erased one. A "proof" that consists of another liveness check is not weaker than nothing — it is
// worse, because it carries the word "proof".
//
// -----------------------------------------------------------------------------------------------------
// SO THIS ONE DECRYPTS, THROUGH THE REAL PATH.
// -----------------------------------------------------------------------------------------------------
//
// It selects active, encrypted items straight from the tables, and for each one calls the SHIPPED
// `CatalogAuthority.readIdentity` — which asks the custodian for the key, decrypts the envelope, decrypts
// every provider ref, and re-checks the lineage at its linearization point. If the keystore in front of it is
// not the keystore those items were encrypted under, this returns null and the proof fails. There is no way
// to satisfy it without the key material.
//
// IT IS READ-ONLY. Two `SELECT`s and a decryption. It writes nothing, it repairs nothing, and it runs
// entirely inside the privileges the least-privileged runtime role already has.
//
// -----------------------------------------------------------------------------------------------------
// AND IT IS HONEST ABOUT AN EMPTY CATALOG.
// -----------------------------------------------------------------------------------------------------
//
// An installation with no encrypted records cannot prove custody, because there is nothing encrypted to
// decrypt. That is a real and permanent state for a fresh installation, and the temptation is to report it as
// a pass. It is reported as `NO_ENCRYPTED_RECORDS` with `proven: false`, and every caller — including the
// restore — is required to distinguish it from `PROVEN`. "I had nothing to check" is not "I checked".
//
// -----------------------------------------------------------------------------------------------------
// NOTHING FROM INSIDE THE CATALOG REACHES THE OUTPUT.
// -----------------------------------------------------------------------------------------------------
//
// No title, no year, no external id, no provider ref type or value, no item id, no key id, no host path and
// no address. The report is a verdict, five counts and a bound. The decrypted identity is never returned from
// the closure that sees it, never stringified and never logged — `readIdentity`'s own zeroization of the DEK
// is what disposes of the key material, and this module simply does not carry the plaintext anywhere.

export const CUSTODY_PROOF_REPORT = 'phase-302-custody-proof';
export const CUSTODY_PROOF_VERSION = 1;

/**
 * How many active encrypted records this proof attempts, by default.
 *
 * THE BOUND IS A DOCUMENTED POLICY, NOT AN IMPLEMENTATION DETAIL. A catalog can hold far more records than
 * anybody wants to decrypt at the end of a restore, and an unbounded proof is one an operator learns to skip.
 * The sample is taken in a deterministic order (by opaque id) so two runs against an unchanged catalog attempt
 * the same records, and the report states both how many exist and how many were attempted — so a reader can
 * always see the difference between "all of them" and "the first twenty-five of them".
 */
export const DEFAULT_PROOF_SAMPLE = 25;

/** The largest sample this command will accept. Above this it is not a proof, it is a batch job. */
export const MAX_PROOF_SAMPLE = 1000;

/**
 * What happened to one attempted record. A closed set, and never an id.
 *
 * `decrypted` is the only one that proves anything. The other four are the distinct ways custody can be
 * absent, kept apart because they mean different things to an operator: a key that was never in this keystore
 * is a WRONG keystore, and a key that was deliberately destroyed is a CORRECT erasure.
 */
export type ProofOutcome =
  | 'decrypted'
  | 'key-not-found'
  | 'key-destroyed'
  | 'undecryptable'
  | 'custodian-error';

export const PROOF_OUTCOMES: readonly ProofOutcome[] = Object.freeze([
  'decrypted', 'key-not-found', 'key-destroyed', 'undecryptable', 'custodian-error',
]);

/**
 * The verdict.
 *
 *   * `PROVEN` — every attempted record decrypted, and at least one was attempted.
 *   * `NOT_PROVEN` — at least one attempted record did not decrypt. This is what a keystore from another
 *     moment looks like, and it is a failure however healthy everything else reports itself.
 *   * `NO_ENCRYPTED_RECORDS` — the catalog holds no active encrypted record. Custody is NOT proven; there was
 *     nothing to prove it with, and that is said rather than rounded up.
 */
export type CustodyProofVerdict = 'PROVEN' | 'NOT_PROVEN' | 'NO_ENCRYPTED_RECORDS';

export interface CustodyProofReport {
  readonly report: typeof CUSTODY_PROOF_REPORT;
  readonly version: typeof CUSTODY_PROOF_VERSION;
  readonly verdict: CustodyProofVerdict;
  /**
   * Whether this installation DEMONSTRATED that it can decrypt its own catalog.
   *
   * True only for `PROVEN`. It exists as its own field because `verdict !== 'NOT_PROVEN'` is the mistake this
   * whole module is a correction for, and a boolean nobody has to negate correctly is one fewer way to make
   * it again.
   */
  readonly proven: boolean;
  /** Active, encrypted records in the catalog. The population the sample came from. */
  readonly encryptedRecords: number;
  /** How many of them this run attempted. Never more than the bound. */
  readonly attempted: number;
  /** The bound in force for this run, so "attempted < encryptedRecords" is always explicable. */
  readonly sampleBound: number;
  /** Counts by outcome. Every key present, including the zeroes — an omitted count reads as "none seen". */
  readonly outcomes: Readonly<Record<ProofOutcome, number>>;
  readonly wrote: 'nothing';
  readonly network: 'none';
  readonly notes: readonly string[];
}

export interface CustodyProofOptions {
  /** How many records to attempt. Defaults to `DEFAULT_PROOF_SAMPLE`. */
  readonly sample?: number;
}

/**
 * Prove — or fail to prove — that this installation can decrypt its own catalog.
 *
 * Takes a pool and a custodian rather than reading the environment, so the shipped CLI wires the production
 * ones and a suite wires a real embedded database with a real custodian. There is no in-process fake path:
 * the thing being proved is the interaction between the DB rows and the key material, and a stub for either
 * half would prove nothing.
 */
export async function proveCustody(
  pool: Pool,
  custodian: KeyCustodian,
  options: CustodyProofOptions = {},
): Promise<CustodyProofReport> {
  const sampleBound = normaliseSample(options.sample);
  const authority = new CatalogAuthority(pool, custodian);
  const outcomes: Record<ProofOutcome, number> = {
    'decrypted': 0, 'key-not-found': 0, 'key-destroyed': 0, 'undecryptable': 0, 'custodian-error': 0,
  };
  const notes: string[] = [];

  // THE POPULATION. Active lineage, present, not forgotten, and actually holding ciphertext — which is
  // exactly the set of records whose readability depends on the keystore being the right one.
  const { rows: countRows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM items i JOIN item_key_control k ON k.item_id = i.id
      WHERE i.present AND NOT i.forgotten AND i.identity_ct IS NOT NULL AND k.shred_state = 'active'`,
  );
  const encryptedRecords = Number(countRows[0]?.n ?? 0);

  if (encryptedRecords === 0) {
    // HONEST, AND DELIBERATELY NOT A PASS. A fresh installation is in this state correctly and permanently.
    notes.push('This catalog holds no active encrypted record, so there was nothing to decrypt and CUSTODY '
      + 'WAS NOT PROVEN. That is a correct state for a fresh installation and it is not a passing custody '
      + 'check — it means only that the question could not be asked.');
    return report('NO_ENCRYPTED_RECORDS', false, encryptedRecords, 0, sampleBound, outcomes, notes);
  }

  // DETERMINISTIC ORDER, so two runs against an unchanged catalog attempt the same records and a failure is
  // reproducible. The id is opaque (a UUID, enforced by a DB CHECK), so ordering by it leaks nothing.
  const { rows } = await pool.query(
    `SELECT i.id, k.key_id
       FROM items i JOIN item_key_control k ON k.item_id = i.id
      WHERE i.present AND NOT i.forgotten AND i.identity_ct IS NOT NULL AND k.shred_state = 'active'
      ORDER BY i.id
      LIMIT $1`,
    [sampleBound],
  );

  for (const row of rows) {
    const itemId = row.id as string;
    const keyId = row.key_id as string;
    // THE REAL PATH. `readIdentity` asks the custodian for the key, decrypts the identity envelope, decrypts
    // every provider ref, and re-checks the lineage before returning. It is fail-closed, so a null is the
    // absence of custody and not an exception to interpret.
    //
    // `withIdentity` is used rather than `readIdentity` so the decrypted strings are registered with the
    // authority's SecretStore for the lifetime of the closure and deleted afterwards — the plaintext never
    // leaves the closure, and anything logged inside it would be redacted.
    let decrypted: boolean;
    try {
      decrypted = await authority.withIdentity(itemId, (identity) => identity !== null);
    } catch {
      outcomes['custodian-error'] += 1;
      continue;
    }
    if (decrypted) { outcomes.decrypted += 1; continue; }

    // IT DID NOT DECRYPT. Which of the four reasons is asked of the custodian directly, because they mean
    // different things: a key this keystore never held is a WRONG keystore, and a destroyed one is a correct
    // erasure that the DB has not finished recording.
    let status: string;
    try {
      status = await custodian.status(keyId);
    } catch {
      outcomes['custodian-error'] += 1;
      continue;
    }
    if (status === 'not_found') outcomes['key-not-found'] += 1;
    else if (status === 'destroyed') outcomes['key-destroyed'] += 1;
    else outcomes.undecryptable += 1;
  }

  const attempted = rows.length;
  const proven = attempted > 0 && outcomes.decrypted === attempted;
  if (proven) {
    notes.push(`Every one of the ${attempted} record(s) attempted was decrypted through the shipped catalog `
      + 'authority and this installation\'s own custodian. That is not reachable without the key material.');
  } else {
    notes.push('At least one active encrypted record could NOT be decrypted. An installation in this state '
      + 'starts, passes its checks and reports itself healthy, because an unreadable item is indistinguishable '
      + 'from a correctly erased one — which is exactly why this check exists. The most likely cause after a '
      + 'restore is a keystore that did not come from the same moment as the database.');
  }
  if (attempted < encryptedRecords) {
    notes.push(`${attempted} of ${encryptedRecords} active encrypted record(s) were attempted, which is this `
      + 'run\'s stated bound. A proof over a sample is a proof about that sample.');
  }
  return report(proven ? 'PROVEN' : 'NOT_PROVEN', proven, encryptedRecords, attempted, sampleBound, outcomes, notes);
}

function normaliseSample(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_PROOF_SAMPLE;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_PROOF_SAMPLE) {
    throw new Error(`the sample must be a whole number between 1 and ${MAX_PROOF_SAMPLE}`);
  }
  return requested;
}

function report(
  verdict: CustodyProofVerdict,
  proven: boolean,
  encryptedRecords: number,
  attempted: number,
  sampleBound: number,
  outcomes: Record<ProofOutcome, number>,
  notes: readonly string[],
): CustodyProofReport {
  return {
    report: CUSTODY_PROOF_REPORT,
    version: CUSTODY_PROOF_VERSION,
    verdict,
    proven,
    encryptedRecords,
    attempted,
    sampleBound,
    outcomes: Object.freeze({ ...outcomes }),
    wrote: 'nothing',
    network: 'none',
    notes: [...notes],
  };
}

/**
 * Read a custody proof report out of a command's stdout, as the closed shape a caller may act on.
 *
 * IT IS THE PRODUCT'S OWN CONTRACT, CHECKED BY NAME AND SHAPE RATHER THAN TRUSTED. The report identifier, the
 * version, the verdict and `proven` are compared exactly, every count must be a non-negative whole number,
 * and `proven` must AGREE with the verdict — a body claiming `PROVEN` with `proven: false`, or the reverse,
 * is two answers and is refused. A body that is JSON and is not this report answers `null`, which is a
 * failure and not a default.
 */
export function readCustodyProof(stdout: string): CustodyProofReport | null {
  if (Buffer.byteLength(stdout, 'utf8') > 64 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Partial<CustodyProofReport>;
  if (doc.report !== CUSTODY_PROOF_REPORT || doc.version !== CUSTODY_PROOF_VERSION) return null;
  if (doc.verdict !== 'PROVEN' && doc.verdict !== 'NOT_PROVEN' && doc.verdict !== 'NO_ENCRYPTED_RECORDS') return null;
  if (typeof doc.proven !== 'boolean') return null;
  if (doc.proven !== (doc.verdict === 'PROVEN')) return null;
  for (const count of [doc.encryptedRecords, doc.attempted, doc.sampleBound]) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
  }
  if (doc.outcomes === null || typeof doc.outcomes !== 'object') return null;
  const outcomes = doc.outcomes as Record<string, unknown>;
  for (const key of PROOF_OUTCOMES) {
    const value = outcomes[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  }
  // THE COUNTS MUST ADD UP TO THE ATTEMPT. A body whose outcomes and attempt disagree has been edited or
  // truncated, and a caller must not act on the half of it that looks right.
  const total = PROOF_OUTCOMES.reduce((sum, key) => sum + (outcomes[key] as number), 0);
  if (total !== doc.attempted) return null;
  if (doc.verdict === 'PROVEN' && (doc.attempted === 0 || (outcomes.decrypted as number) !== doc.attempted)) return null;
  if (doc.verdict === 'NO_ENCRYPTED_RECORDS' && (doc.encryptedRecords !== 0 || doc.attempted !== 0)) return null;
  return doc as CustodyProofReport;
}

/** The human summary. A verdict, counts and a bound. Never an id, a title, a ref or a path. */
export function renderCustodyProof(report: CustodyProofReport): string {
  const lines: string[] = [];
  lines.push(`Custody proof — ${report.verdict}`);
  lines.push(`  can this installation decrypt its own catalog?  ${report.proven ? 'YES' : 'NOT PROVEN'}`);
  lines.push(`  active encrypted records   ${report.encryptedRecords}`);
  lines.push(`  attempted                  ${report.attempted} (bound ${report.sampleBound})`);
  for (const outcome of PROOF_OUTCOMES) {
    lines.push(`    ${outcome.padEnd(18)} ${report.outcomes[outcome]}`);
  }
  lines.push(`  wrote                      ${report.wrote}`);
  lines.push(`  network                    ${report.network}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}
