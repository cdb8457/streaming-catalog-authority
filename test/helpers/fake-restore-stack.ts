import {
  closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { COMPONENT_ARTIFACT_NAMES } from '../../src/ops/backup-components.js';
import { digestTreeAt } from '../../src/ops/complete-backup.js';
import {
  CommandLedger,
  digestFileNoFollow,
  type CommandOutcome,
  type CommandRunner,
  type FileInputRunner,
  type FileOutputRunner,
  type MaintenanceCommand,
} from '../../src/ops/maintenance-safety.js';
import { fakeDoctorJson, fakeDumpText } from './fake-toolchain.js';

// Phases 297-304 acceptance harness — a stack that MODELS a restore instead of nodding at one.
//
// WHY NOT `fakeToolchain`. That fake returns 0 to everything a restore does. Driving the restore against it
// would prove only that commands were issued in an order — it could not have noticed that the dump replayed
// into a database that had never been emptied, that the keystore placed in the container belonged to a
// DIFFERENT moment than the dump, or that the version proof was satisfied by a body nobody read. Those are
// exactly the defects this tranche exists to prevent, so the fake has to be able to express them.
//
// SO THIS ONE KEEPS STATE, and every question the restore's proofs ask is answered from that state:
//
//   * `down -v` DESTROYS. The modelled volumes go: no database, no schema, no container keystore, no app
//     container. A replay against a database that was never emptied is a modelled failure, the way a real
//     `psql` replay over an existing schema is a real one.
//   * A KEYSTORE HAS AN ORIGIN. `compose cp <host dir> app:/…/keystore` digests the directory it was actually
//     given, and the decryption proof succeeds only when the (dump, keystore) pair the installation is
//     holding is one of the MOMENTS this world was told about. That is the whole "the database and the
//     keystore must come from the same moment" invariant, checkable.
//   * THE PROOFS ANSWER FROM THE STATE. `ops:version` prints the schema the replay actually loaded, the
//     doctor reports on whether the stack is up, and `ops:collections status` needs a matching moment. None
//     of them is a constant.

/** A (dump, keystore) pair that belongs together. The decryption proof succeeds only on one of these. */
export interface CustodyMoment {
  readonly dumpDigest: string;
  readonly keystoreDigest: string;
}

export interface RestoreStackOptions {
  /** Exit status for a command whose argv joins to something matching this key. Default 0. */
  readonly failWhen?: readonly { readonly contains: string; readonly status: number }[];
  /** The (dump, keystore) pairs that decrypt. Anything else is an installation that reads nothing. */
  readonly moments: readonly CustodyMoment[];
  /** The schema version the running BUILD expects. `ops:version` prints it and exits on the comparison. */
  readonly buildSchema: number;
  /** The schema version the installation's database holds BEFORE any restore. */
  readonly initialSchema?: number;
  /** What `compose cp app:… <dest>` writes, i.e. the keystore the safety set copies out. */
  readonly liveKeystoreFiles?: Readonly<Record<string, string>>;
  /**
   * How many active ENCRYPTED records the restored catalog holds, for the custody proof to work over.
   *
   * Zero models the honest case the shipped proof reports as NO_ENCRYPTED_RECORDS: a restore that ran, an
   * installation that is up, and custody that was never demonstrated because there was nothing to decrypt.
   */
  readonly encryptedRecords?: number;
  /** Make the doctor report a failure even though the stack is up. */
  readonly doctorStates?: readonly ('pass' | 'warn' | 'fail')[];
  /**
   * What `docker compose ps -a --quiet` answers. `none` models a project that has never been up; `containers`
   * one that has; `unanswerable` a daemon that will not talk, which must fail closed to OCCUPIED.
   *
   * Default `none`, because the probe is only consulted when the host directories are already empty — the
   * one case where a wrong answer would let a restore destroy volumes it had no authorisation for.
   */
  readonly containers?: 'none' | 'containers' | 'unanswerable';
  /**
   * In SIDECAR custody the installation reads its keystore from a host directory, not from the app volume.
   * The world reads that directory at proof time, so a sidecar restore's custody proof is answered by what
   * the swap actually put on disk rather than by a container copy that never happens.
   */
  readonly sidecarStateDir?: string;
}

export interface RestoreStackState {
  readonly volumesDestroyed: boolean;
  readonly databaseUp: boolean;
  readonly stackUp: boolean;
  readonly appContainerExists: boolean;
  /** The schema the database currently holds, or `null` when there is no database. */
  readonly schema: number | null;
  /** The dump whose bytes are loaded, or `null`. */
  readonly loadedDump: string | null;
  /** The keystore the app container holds, or `null`. */
  readonly keystore: string | null;
}

export interface RestoreStack {
  readonly runner: CommandRunner;
  /** The stdin-bound runner. The database replay is its only user. */
  readonly inputRunner: FileInputRunner;
  /** The stdout-bound runner. The SAFETY SET's `pg_dump` is its only user. */
  readonly outputRunner: FileOutputRunner;
  readonly ledger: CommandLedger;
  state(): RestoreStackState;
  /** Every command, flattened, for a scan. */
  argv(): readonly string[];
  /** The commands in order, as `program arg arg …` strings. */
  lines(): readonly string[];
  /** How many times the modelled volumes were destroyed. A restore destroys them exactly once. */
  teardowns(): number;
  /** The digest of every dump actually replayed, in order. */
  replays(): readonly string[];
}

/** The keystore digest of a published set, computed the way the product computes it. */
export function setKeystoreDigest(setDir: string): string {
  return digestTreeAt(join(setDir, COMPONENT_ARTIFACT_NAMES.keystore), 'set keystore').digest;
}

/** The dump digest of a published set, computed the way the product computes it. */
export function setDumpDigest(setDir: string): string {
  return digestFileNoFollow(join(setDir, COMPONENT_ARTIFACT_NAMES.database), 'set dump').digest;
}

export function restoreStack(options: RestoreStackOptions): RestoreStack {
  const ledger = new CommandLedger();
  const liveKeystoreFiles = options.liveKeystoreFiles ?? { 'keys/.keep': 'k\n', 'tombstones/.keep': 't\n' };
  let volumesDestroyed = false;
  let databaseUp = true;
  let stackUp = true;
  let appContainerExists = true;
  let schema: number | null = options.initialSchema ?? options.buildSchema;
  let loadedDump: string | null = null;
  let keystore: string | null = null;
  let teardowns = 0;
  const replays: string[] = [];

  const ok = (stdout = ''): CommandOutcome => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr: string): CommandOutcome => ({ status: 1, stdout: '', stderr });

  const injected = (joined: string): CommandOutcome | null => {
    for (const rule of options.failWhen ?? []) {
      if (joined.includes(rule.contains)) return { status: rule.status, stdout: '', stderr: 'injected failure\n' };
    }
    return null;
  };

  /**
   * Does the installation currently hold a database and a keystore from ONE moment?
   *
   * In SIDECAR custody the keystore is a host directory the swap put in place, so it is read from disk at
   * proof time. In INLINE custody it is whatever `compose cp` put into the app volume. Either way the answer
   * is about the key material actually present, which is what makes the proof non-vacuous.
   */
  const heldKeystore = (): string | null => {
    if (options.sidecarStateDir === undefined) return keystore;
    if (!existsSync(options.sidecarStateDir)) return null;
    try {
      return digestTreeAt(options.sidecarStateDir, 'sidecar keystore in place').digest;
    } catch {
      return null;
    }
  };
  const decrypts = (): boolean => {
    const held = heldKeystore();
    return loadedDump !== null && held !== null
      && options.moments.some((moment) => moment.dumpDigest === loadedDump && moment.keystoreDigest === held);
  };

  const runner: CommandRunner = (command: MaintenanceCommand): CommandOutcome => {
    const joined = [command.program, ...command.args].join(' ');
    const forced = injected(joined);
    if (forced !== null) return forced;
    const args = command.args;

    // ---- the occupancy probe, which starts nothing --------------------------------------------------
    if (args.includes('ps')) {
      if (options.containers === 'unanswerable') return fail('cannot reach the daemon\n');
      return ok(options.containers === 'containers' ? 'abc123\ndef456\n' : '');
    }

    // ---- the teardown ------------------------------------------------------------------------------
    if (args.includes('down')) {
      if (!args.includes('-v')) {
        // A teardown without `-v` leaves the volumes, so the database the dump would replay into is NOT
        // empty. Modelled rather than accepted, because a restore that made this mistake would produce
        // conflicts on a real system and green output on a fake one.
        stackUp = false;
        databaseUp = false;
        return ok();
      }
      teardowns += 1;
      volumesDestroyed = true;
      stackUp = false;
      databaseUp = false;
      appContainerExists = false;
      schema = null;
      loadedDump = null;
      keystore = null;
      return ok();
    }

    // ---- starting things ---------------------------------------------------------------------------
    if (args.includes('up')) {
      if (args.includes('postgres')) {
        databaseUp = true;
        return ok();
      }
      if (!databaseUp) return fail('the database is not running\n');
      stackUp = true;
      // The real `up` runs `ops:bootstrap`, which migrates idempotently. A database holding no schema at all
      // by this point is one nothing replayed into, and the modelled bootstrap does not invent one.
      return ok();
    }
    if (args.includes('create')) {
      appContainerExists = true;
      return ok();
    }
    if (args.includes('stop')) { stackUp = false; return ok(); }
    if (args.includes('start')) { stackUp = true; return ok(); }

    // ---- copying ----------------------------------------------------------------------------------
    if (args.includes('cp')) {
      const source = args[args.length - 2]!;
      const destination = args[args.length - 1]!;
      if (destination.startsWith('app:')) {
        // INTO the container. `…/keystore-backup/.` means "the contents of", so the digest is of the
        // directory itself — the same value `digestTreeAt` gives for the component in the set.
        if (!appContainerExists) return fail('no container to copy into\n');
        const hostDir = source.endsWith('/.') ? source.slice(0, -2) : source;
        if (!existsSync(hostDir)) return fail('no such directory\n');
        keystore = digestTreeAt(hostDir, 'keystore being placed').digest;
        return ok();
      }
      // OUT of the container: what the SAFETY SET's keystore copy does.
      if (!appContainerExists) return fail('no container to copy from\n');
      for (const [relative, contents] of Object.entries(liveKeystoreFiles)) {
        const target = join(destination, relative);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, contents, 'utf8');
      }
      return ok();
    }

    // ---- psql, other than the replay ---------------------------------------------------------------
    if (args.includes('psql')) {
      if (!databaseUp) return fail('the database is not running\n');
      return ok();
    }

    // ---- the proofs --------------------------------------------------------------------------------
    if (joined.includes('ops:version')) {
      if (!stackUp) return fail('the stack is not running\n');
      const database = schema ?? 0;
      const text = `schema version: db=${database} expected=${options.buildSchema}\n`;
      // The shipped `ops:version` exits non-zero when the two disagree. A fake that always returned 0 would
      // let the restore's own cross-check pass on a contradiction.
      return database === options.buildSchema ? ok(text) : { status: 1, stdout: text, stderr: '' };
    }
    if (joined.includes('ops:doctor')) {
      if (!stackUp) return fail('the stack is not running\n');
      const states = options.doctorStates ?? ['pass', 'pass'];
      const body = fakeDoctorJson(states);
      return states.includes('fail') ? { status: 1, stdout: body, stderr: '' } : ok(body);
    }
    if (joined.includes('ops:custody-proof')) {
      // -------------------------------------------------------------------------------------------------
      // THE PROOF IS MODELLED BY ITS REPORT, NOT BY ITS NAME.
      // -------------------------------------------------------------------------------------------------
      //
      // THE DEFECT THIS CLOSES. The first cut special-cased `ops:collections status` and returned a bare
      // failure when the modelled moment did not match. Two things were wrong with that: the production
      // command it stood in for does not decrypt anything (it counts rows), so the suite was asserting a
      // property no shipped code had; and the fake answered by COMMAND NAME rather than by producing the
      // report the restore actually parses, so the restore's own consumption of that report — the schema
      // check, the verdict handling, the `NO_ENCRYPTED_RECORDS` branch — was never exercised at all.
      //
      // This emits a real `phase-302-custody-proof` body whose verdict follows from the modelled custody
      // state, and the restore reads it through the shipped `readCustodyProof`. A body that did not satisfy
      // that contract would fail the restore here, which is what makes this a test of the contract.
      if (!stackUp) return fail('the stack is not running\n');
      const encrypted = options.encryptedRecords ?? 3;
      if (encrypted === 0) {
        return ok(custodyProofBody('NO_ENCRYPTED_RECORDS', 0, 0, { decrypted: 0 }));
      }
      const attempted = Math.min(encrypted, 25);
      return decrypts()
        ? ok(custodyProofBody('PROVEN', encrypted, attempted, { decrypted: attempted }))
        : { status: 1, stdout: custodyProofBody('NOT_PROVEN', encrypted, attempted, { 'key-not-found': attempted }), stderr: '' };
    }
    if (joined.includes('ops:collections')) {
      if (!stackUp) return fail('the stack is not running\n');
      return ok('{"ok":true}\n');
    }

    return ok();
  };

  /** The safety set's `pg_dump`: real bytes into a real `O_EXCL` file, exactly like the shipped runner. */
  const outputRunner: FileOutputRunner = (command: MaintenanceCommand, destination: string): CommandOutcome => {
    const joined = [command.program, ...command.args].join(' ');
    const forced = injected(joined);
    if (forced !== null) return forced;
    if (!databaseUp) return fail('the database is not running\n');
    const payload = Buffer.from(fakeDumpText(schema ?? options.buildSchema), 'utf8');
    const fd = openSync(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeSync(fd, payload, 0, payload.byteLength, 0);
    } finally {
      closeSync(fd);
    }
    return ok();
  };

  /**
   * The replay: `psql` with its stdin bound to the set's dump.
   *
   * IT READS THE FILE IT WAS GIVEN, and records that file's digest. That is what makes "the bytes replayed
   * are the bytes that were verified" a checkable property rather than a claim — and it is what lets a suite
   * put a DIFFERENT set's dump in and watch the decryption proof fail.
   */
  const inputRunner: FileInputRunner = (command: MaintenanceCommand, source: string): CommandOutcome => {
    const joined = [command.program, ...command.args].join(' ');
    const forced = injected(joined);
    if (forced !== null) return forced;
    if (!databaseUp) return fail('the database is not running\n');
    if (!volumesDestroyed) {
      // THE REAL FAILURE, MODELLED. A plain dump replayed over a schema that is already there produces
      // conflicts, not a rollback — `backup-components.ts` says so in the database component's caveat.
      return fail('relation already exists\n');
    }
    const digested = digestFileNoFollow(source, 'replayed dump');
    replays.push(digested.digest);
    loadedDump = digested.digest;
    schema = readDumpSchema(source);
    return ok();
  };

  return {
    runner,
    inputRunner,
    outputRunner,
    ledger,
    state: () => ({
      volumesDestroyed, databaseUp, stackUp, appContainerExists, schema, loadedDump, keystore,
    }),
    argv: () => ledger.flat(),
    lines: () => ledger.all().map((entry) => [entry.program, ...entry.args].join(' ')),
    teardowns: () => teardowns,
    replays: () => [...replays],
  };
}

/**
 * A `phase-302-custody-proof` body, built to the shipped contract.
 *
 * Every count is filled in and the outcomes sum to the attempt, because `readCustodyProof` checks both — a
 * fake that produced a body the product would reject would make every proof step fail for the wrong reason.
 */
export function custodyProofBody(
  verdict: 'PROVEN' | 'NOT_PROVEN' | 'NO_ENCRYPTED_RECORDS',
  encryptedRecords: number,
  attempted: number,
  outcomes: Partial<Record<string, number>>,
): string {
  const full = {
    'decrypted': 0, 'key-not-found': 0, 'key-destroyed': 0, 'undecryptable': 0, 'custodian-error': 0,
    ...outcomes,
  };
  return `${JSON.stringify({
    report: 'phase-302-custody-proof',
    version: 1,
    verdict,
    proven: verdict === 'PROVEN',
    encryptedRecords,
    attempted,
    sampleBound: 25,
    outcomes: full,
    wrote: 'nothing',
    network: 'none',
    notes: [],
  }, null, 2)}\n`;
}

/** The schema version a fake dump carries, read the way the shipped inspector reads a real one. */
function readDumpSchema(path: string): number | null {
  const text = readSmall(path);
  const match = /COPY public\.schema_meta \(id, version\) FROM stdin;\s*\n1\t([0-9]+)/.exec(text);
  return match === null ? null : Number(match[1]);
}

function readSmall(path: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
