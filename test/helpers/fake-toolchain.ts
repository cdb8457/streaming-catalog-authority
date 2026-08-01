import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsConstants, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync,
  readdirSync, writeFileSync, writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseYaml, type YamlMap, type YamlValue } from '../../src/ops/minimal-yaml.js';
import {
  CommandLedger,
  type CommandOutcome,
  type CommandRunner,
  type FileOutputRunner,
  type MaintenanceCommand,
} from '../../src/ops/maintenance-safety.js';
import { MIGRATION_VERSION } from '../../src/db/schema-version.js';

// Phases 277-280 acceptance harness — a docker/compose/pg toolchain that is a VALUE, not a daemon.
//
// WHY THIS RATHER THAN A STUB ON PATH. The maintenance commands take an injected `CommandRunner`, so a suite
// can drive the REAL planner and the REAL filesystem work while standing in for every process. Three things
// follow, and they are the reason the whole tranche is shaped this way:
//
//   * IT NEEDS NO DAEMON, no images and no network, so it runs identically on a laptop and on a CI runner
//     that has neither.
//   * IT CAN ASSERT THE ARGUMENT ARRAYS. What the product would actually run is inspected directly, so
//     "no pull, no registry, no media, no Jellyfin, no acquisition" is checked against the commands
//     themselves rather than against a description of them.
//   * IT CAN INJECT ANY FAILURE, at any step, deterministically — a stopped service that will not stop, a
//     dump that produces nothing, a restore that fails halfway. No timing, no flakes.
//
// The fake also WRITES what a real toolchain would write: `compose cp` creates the keystore directory it was
// asked to copy out, so the staged set on disk is a real set that the real verifier then reads.

export interface FakeToolchainOptions {
  /** Exit status for a command whose argv joins to something matching this key. Default 0. */
  readonly failWhen?: readonly { readonly contains: string; readonly status: number }[];
  /** What `pg_dump` writes. Default: a small plain dump carrying a schema_meta row. */
  readonly dumpText?: string;
  /**
   * The EXACT BYTES `pg_dump` writes, when a suite needs bytes that are not valid UTF-8.
   *
   * Takes precedence over `dumpText`. This is the seam that makes "the dump is byte-faithful" provable: the
   * old string-capturing runner could not carry these bytes at all.
   */
  readonly dumpBytes?: Buffer;
  /**
   * Make the dump this many bytes long WITHOUT allocating them.
   *
   * The file is written short and then truncated up, which every filesystem this runs on makes a sparse file
   * — so a suite can prove a dump far past the old 512 MiB in-memory cap succeeds, in milliseconds, without a
   * gigabyte of disk or memory. The header bytes are still real, so the file is still recognisable.
   */
  readonly dumpSize?: number;
  /** What `ops:doctor --json` answers. Default: a healthy report. */
  readonly doctorJson?: string;
  /**
   * The doctor's EXIT STATUS, when a suite needs it to disagree with its own body.
   *
   * Default: whatever the shipped doctor would exit for that body. Overriding it is how the case "a healthy
   * report behind a failed command" is written, and there is no other way to express it.
   */
  readonly doctorStatus?: number;
  /** What the doctor writes to its error stream. Default: nothing. */
  readonly doctorStderr?: string;
  /** What `ops:version` answers. */
  readonly versionText?: string;
  /** Files the fake `compose cp` should create at its destination, as `relative path -> contents`. */
  readonly keystoreFiles?: Readonly<Record<string, string>>;
}

export interface FakeToolchain {
  readonly runner: CommandRunner;
  /**
   * The runner that writes REAL BYTES into a REAL FILE, the way the shipped one binds a child's stdout to a
   * descriptor. It is not a stand-in that returns a string: a suite that wants to prove a dump is
   * byte-faithful has to be able to put bytes that are not text through it.
   */
  readonly fileRunner: FileOutputRunner;
  readonly ledger: CommandLedger;
  /** Every command, flattened, for a scan. */
  argv(): readonly string[];
  /** The commands in order, as `program arg arg …` strings. */
  lines(): readonly string[];
}

/** A plain dump the Phase 257 inspector recognises, carrying a schema version it can read. */
export function fakeDumpText(schemaVersion: number): string {
  return [
    '--',
    '-- PostgreSQL database dump',
    '--',
    'SET statement_timeout = 0;',
    'COPY public.schema_meta (id, version) FROM stdin;',
    `1\t${schemaVersion}`,
    '\\.',
    '',
  ].join('\n');
}

/** What the shipped doctor CLI would exit for this body: 0 when it reports itself ok, 1 otherwise. */
function doctorReportsOk(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as { ok?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.ok === true;
  } catch {
    // A body that is not JSON at all did not come from a doctor that succeeded.
    return false;
  }
}

/** A doctor report in the shipped stable contract. */
export function fakeDoctorJson(states: readonly ('pass' | 'warn' | 'fail')[]): string {
  const checks = states.map((state, index) => ({ name: `check-${index}`, state, detail: 'a detail' }));
  return JSON.stringify({ reportVersion: 1, ok: !states.includes('fail'), checks });
}

export function fakeToolchain(options: FakeToolchainOptions = {}): FakeToolchain {
  const ledger = new CommandLedger();
  // THE DEFAULT DUMP CARRIES THE SCHEMA VERSION THIS BUILD REQUIRES, not a literal.
  //
  // It was `fakeDumpText(9)`, which was true on the day it was written and became false the next time a
  // migration landed: a verified backup compares the dump's recorded schema version against MIGRATION_VERSION,
  // so a hardcoded 9 made four suites fail with "the set that was taken does not verify" — a failure about
  // the fixture, wearing the costume of a failure about the code under test. A suite that genuinely needs an
  // older or newer dump still says so by passing `dumpText` explicitly, which several do.
  const dumpText = options.dumpText ?? fakeDumpText(MIGRATION_VERSION);
  const doctorJson = options.doctorJson ?? fakeDoctorJson(['pass', 'pass']);
  const versionText = options.versionText ?? 'catalog-authority v1.1.4\n';
  const keystoreFiles = options.keystoreFiles ?? { 'keys/.keep': 'k\n', 'tombstones/.keep': 't\n' };

  const runner: CommandRunner = (command: MaintenanceCommand): CommandOutcome => {
    const joined = [command.program, ...command.args].join(' ');
    for (const rule of options.failWhen ?? []) {
      if (joined.includes(rule.contains)) return { status: rule.status, stdout: '', stderr: 'injected failure\n' };
    }
    if (joined.includes('pg_dump')) return { status: 0, stdout: dumpText, stderr: '' };
    if (joined.includes('ops:doctor')) {
      // THE SHIPPED DOCTOR EXITS NON-ZERO WHEN A CHECK FAILED (`doctor-cli.ts`: `report.ok ? 0 : 1`), so the
      // fake does too. A fake that always returned 0 would let the monitor's status/body cross-check pass
      // vacuously — which is exactly the false proof that check exists to prevent.
      const status = options.doctorStatus ?? (doctorReportsOk(doctorJson) ? 0 : 1);
      return { status, stdout: doctorJson, stderr: options.doctorStderr ?? '' };
    }
    if (joined.includes('ops:version')) return { status: 0, stdout: versionText, stderr: '' };
    if (command.args.includes('cp')) {
      // A real `compose cp` of a directory creates it at the destination. The destination is the LAST
      // argument, and this writes a keystore-shaped tree there so the verifier downstream reads a real one.
      const destination = command.args[command.args.length - 1]!;
      for (const [relative, contents] of Object.entries(keystoreFiles)) {
        const target = join(destination, relative);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, contents, 'utf8');
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  // THE FILE RUNNER WRITES REAL BYTES TO A REAL DESCRIPTOR, the way the shipped one hands a child's stdout to
  // an `O_EXCL` file. It refuses to create a destination that already exists, for the same reason the shipped
  // one does — a dump that silently lands on top of something is how a set ends up half old.
  const fileRunner: FileOutputRunner = (command: MaintenanceCommand, destination: string): CommandOutcome => {
    const joined = [command.program, ...command.args].join(' ');
    for (const rule of options.failWhen ?? []) {
      if (joined.includes(rule.contains)) {
        // A FAILED PRODUCER LEAVES NO FILE. The real runner unlinks its destination on a nonzero status, and a
        // fake that left a truncated dump behind would let a suite pass on a file the product would have
        // deleted.
        return { status: rule.status, stdout: '', stderr: 'injected failure\n' };
      }
    }
    const payload = options.dumpBytes ?? Buffer.from(dumpText, 'utf8');
    const fd = openSync(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeSync(fd, payload, 0, payload.byteLength, 0);
      if (options.dumpSize !== undefined && options.dumpSize > payload.byteLength) {
        // SPARSE, DELIBERATELY. `ftruncate` up makes the file report the size without the bytes being stored,
        // so "a dump far past any in-memory cap still succeeds" is provable in milliseconds.
        ftruncateSync(fd, options.dumpSize);
      }
    } finally {
      closeSync(fd);
    }
    // STDOUT IS ALWAYS EMPTY. The bytes went to the file; a runner that ALSO returned them would let a caller
    // keep reading the dump through memory and never notice.
    return { status: 0, stdout: '', stderr: '' };
  };

  return {
    runner,
    fileRunner,
    ledger,
    argv: () => ledger.flat(),
    lines: () => ledger.all().map((entry) => [entry.program, ...entry.args].join(' ')),
  };
}

// -----------------------------------------------------------------------------------------------------------
// The rehearsal world: a fake that MODELS the stack instead of nodding at it
// -----------------------------------------------------------------------------------------------------------
//
// WHY THIS EXISTS. The first version of the rehearsal suite drove a runner that returned 0 to everything, so
// it proved only that commands were issued in an order. It could not have noticed that both `up` commands
// carried the same image, that only one of four components was ever restored, or that no version was ever
// actually compared — and it did not.
//
// SO THIS ONE KEEPS STATE. It reads the override file the product wrote to learn which image an `up` selects,
// reads the restore workspace to learn which components exist and what the dump's bytes are, and models the
// database's schema version across restores, boots and teardowns. `rehearsalProblems` then asks the questions
// a rehearsal is supposed to be able to answer, and a run that skipped any of them FAILS.

export interface RehearsalImageContents {
  /** The product version inside this image, as `npm pkg get version` would answer. */
  readonly version: string;
  /** The schema version this build expects, as `ops:version` would report. */
  readonly schema: number;
}

export interface RehearsalWorldOptions extends FakeToolchainOptions {
  /** The disposable root, so the fake can read the files the product wrote there. */
  readonly disposableRoot: string;
  /** What is inside each image reference. An `up` that selects a ref not named here is a failure. */
  readonly images: Readonly<Record<string, RehearsalImageContents>>;
  /** The schema version the restored set carries. */
  readonly setSchema: number;
  /** How many records the representative import snapshot holds. Default 3. */
  readonly importRecords?: number;
  /**
   * Make the REPLAY report a duplicate durable write while still exiting zero.
   *
   * The whole point of reading the shipped report rather than the exit code: an import that re-created every
   * record would succeed as a process and would have doubled the catalog. There is no other way to express
   * that case, and a suite that could not express it could not prove the check works.
   */
  readonly importReplayDuplicates?: boolean;
}

export interface RehearsalUp {
  /** What image each service in the resolved stack would run, keyed by service name. */
  readonly images: Readonly<Record<string, string>>;
  /** The image `app` runs. The rehearsal's version and schema answers come from it. */
  readonly image: string;
  /** Every bind the resolved stack wires, as `<host side>:<container side>`, service by service. */
  readonly mounts: readonly string[];
  readonly overrideFile: string;
}

export interface RehearsalRestore {
  /** sha256 of the dump bytes actually present in the workspace at the moment of the restore. */
  readonly digest: string;
  /** Every component directory or file present in the workspace then. */
  readonly components: readonly string[];
}

export interface RehearsalWorld extends FakeToolchain {
  readonly ups: readonly RehearsalUp[];
  readonly restores: readonly RehearsalRestore[];
  readonly teardowns: number;
  /** Every `npm ...` invocation inside the app, joined, in order. */
  readonly appCommands: readonly string[];
  /** Every resolved configuration this world produced, in order, as it answered `compose config`. */
  readonly configurations: readonly ResolvedFakeStack[];
}

// -----------------------------------------------------------------------------------------------------------
// The part that makes this a proof: the fake MERGES, the way Compose does
// -----------------------------------------------------------------------------------------------------------
//
// WHY IT HAS TO. Every claim about where the disposable stack points is a claim about the RESOLVED
// configuration — base definition plus override, merged. A fake that read only the override could not notice
// that a base bind survived the merge, that a base Docker secret is still there (an override cannot remove
// one), or that `migrate` was left on the base image. Those are exactly the defects being closed, so the fake
// answers `docker compose config` from a real merge and the product validates THAT.
//
// The merge implemented here is Compose's own for the shapes this product writes: mappings merge key by key,
// `environment` merges, and mount lists merge BY TARGET with the later file winning. Everything else in the
// later file replaces.

export interface ResolvedFakeStack {
  readonly name: string;
  readonly services: Readonly<Record<string, YamlMap>>;
}

type MutableMap = Record<string, YamlValue>;

/** Split `A:B[:ro]` the way Compose does, tolerating a Windows drive letter on the host side. */
function splitMountString(entry: string): { source: string; target: string; readOnly: boolean } {
  const parts: string[] = [];
  let rest = entry;
  // A leading `C:` is a drive, not a separator.
  const drive = /^([A-Za-z]:[\\/])/.exec(rest);
  let prefix = '';
  if (drive !== null) { prefix = drive[1]!; rest = rest.slice(prefix.length); }
  for (const piece of rest.split(':')) parts.push(piece);
  const source = `${prefix}${parts[0] ?? ''}`;
  const target = parts[1] ?? '';
  const readOnly = (parts[2] ?? '') === 'ro';
  return { source, target, readOnly };
}

function isHostSide(source: string): boolean {
  return source.startsWith('.') || source.startsWith('/') || source.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(source);
}

/** Long-syntax mounts, keyed by target, so a later file's entry replaces an earlier one at the same target. */
function mountsByTarget(value: YamlValue | undefined, cwd: string): Map<string, YamlMap> {
  const out = new Map<string, YamlMap>();
  if (value === undefined || value === null) return out;
  for (const entry of value as YamlValue[]) {
    if (typeof entry === 'string') {
      const { source, target, readOnly } = splitMountString(entry);
      out.set(target, isHostSide(source)
        ? { type: 'bind', source: resolve(cwd, source), target, read_only: readOnly }
        : { type: 'volume', source, target, read_only: readOnly });
      continue;
    }
    const map = entry as YamlMap;
    const target = String(map.target ?? '');
    out.set(target, { ...map, target });
  }
  return out;
}

function mergeService(base: YamlMap | undefined, over: YamlMap | undefined, cwd: string): YamlMap {
  const merged: MutableMap = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(over ?? {})) {
    if (key === 'environment') {
      merged.environment = { ...(base?.environment as YamlMap ?? {}), ...(value as YamlMap) };
      continue;
    }
    if (key === 'volumes') continue; // handled below, by target
    merged[key] = value;
  }
  const byTarget = mountsByTarget(base?.volumes, cwd);
  for (const [target, mount] of mountsByTarget(over?.volumes, cwd)) byTarget.set(target, mount);
  if (byTarget.size > 0) merged.volumes = [...byTarget.values()];
  return merged;
}

/**
 * Resolve `-f base -f override` into the configuration Compose would produce, and nothing more.
 *
 * NO INTERPOLATION AT ALL, which is what `--no-interpolate` asks for and what this product requires: a `${…}`
 * in a definition survives into the resolved source as a literal, where the validator sees a path it cannot
 * prove and refuses.
 */
export function resolveFakeCompose(cwd: string, files: readonly string[], projectName: string): ResolvedFakeStack {
  const documents = files.map((file) => parseYaml(readFileSync(join(cwd, file), 'utf8')));
  const services: Record<string, YamlMap> = {};
  const top: MutableMap = {};
  for (const doc of documents) {
    for (const [key, value] of Object.entries(doc)) {
      if (key === 'services') continue;
      if (key === 'volumes' || key === 'networks' || key === 'secrets' || key === 'configs') {
        top[key] = { ...(top[key] as YamlMap ?? {}), ...(value as YamlMap) };
        continue;
      }
      top[key] = value;
    }
    for (const [name, raw] of Object.entries((doc.services ?? {}) as YamlMap)) {
      services[name] = mergeService(services[name], raw as YamlMap, cwd);
    }
  }
  return { name: projectName, services, ...top } as ResolvedFakeStack;
}

/** The JSON `docker compose config --format json` prints for that resolved stack. */
export function fakeComposeConfigJson(stack: ResolvedFakeStack): string {
  const services: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(stack.services)) {
    const service: Record<string, unknown> = { ...raw };
    if (raw.volumes !== undefined) service.volumes = raw.volumes;
    if (raw.secrets !== undefined) {
      service.secrets = (raw.secrets as YamlValue[]).map((entry) => (typeof entry === 'string' ? { source: entry } : entry));
    }
    // Compose always resolves `environment` to a mapping.
    service.environment = raw.environment ?? {};
    services[name] = service;
  }
  const asRecord = stack as unknown as Record<string, unknown>;
  return JSON.stringify({
    name: stack.name,
    services,
    volumes: resolvedResources(asRecord.volumes, stack.name),
    networks: resolvedResources(asRecord.networks ?? { default: {} }, stack.name),
    secrets: asRecord.secrets ?? {},
    configs: asRecord.configs ?? {},
  });
}

/**
 * Top-level volumes and networks, as `config` actually resolves them: with an EFFECTIVE NAME.
 *
 * COMPOSE DERIVES `<project>_<key>` — and a definition's own `name:` OVERRIDES that, which is why the spread
 * is in this order. That single line is the whole of the "explicit name escapes the project namespace"
 * defect: a fake that always emitted the derived name could not have produced the case, and the check would
 * have been asserted against a world in which it could never fail.
 */
function resolvedResources(value: unknown, projectName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, body] of Object.entries((value ?? {}) as YamlMap)) {
    const entry = body === null || body === undefined ? {} : (body as YamlMap);
    out[key] = { name: `${projectName}_${key}`, ...entry };
  }
  return out;
}

/**
 * A toolchain that models a disposable stack: a real Compose merge, per-service images, mounts, restores, a
 * schema version and a durable catalog the representative import writes into.
 *
 * It answers `npm pkg get version` and `ops:version` FROM THE IMAGE THE OVERRIDE SELECTED FOR `app`, and it
 * refuses an `up` whose MIGRATE or SIDECAR service is on an image this host does not hold — so a rehearsal
 * that pinned only the app fails here rather than passing quietly. That is the property the previous harness
 * could not express, and the defect it therefore could not catch.
 */
export function rehearsalWorld(options: RehearsalWorldOptions): RehearsalWorld {
  const base = fakeToolchain(options);
  const ups: RehearsalUp[] = [];
  const restores: RehearsalRestore[] = [];
  const appCommands: string[] = [];
  const configurations: ResolvedFakeStack[] = [];
  const importRecords = options.importRecords ?? 3;
  let teardowns = 0;
  let selected: RehearsalImageContents | null = null;
  let databaseSchema: number | null = null;
  /** How many of the snapshot's records the disposable catalog durably holds. Destroyed with the volumes. */
  let importedRecords = 0;

  const composeFiles = (args: readonly string[]): string[] => {
    const files: string[] = [];
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === '-f' || args[index] === '--file') files.push(args[index + 1]!);
    }
    return files;
  };
  const projectOf = (args: readonly string[]): string => {
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === '-p' || args[index] === '--project-name') return args[index + 1]!;
    }
    return '';
  };

  const resolveStack = (command: MaintenanceCommand): ResolvedFakeStack | null => {
    const files = composeFiles(command.args);
    if (files.length === 0 || files.some((file) => !existsSync(join(command.cwd, file)))) return null;
    return resolveFakeCompose(command.cwd, files, projectOf(command.args));
  };

  const runner: CommandRunner = (command: MaintenanceCommand): CommandOutcome => {
    const joined = [command.program, ...command.args].join(' ');
    for (const rule of options.failWhen ?? []) {
      if (joined.includes(rule.contains)) return { status: rule.status, stdout: '', stderr: 'injected failure\n' };
    }
    if (command.args.includes('config')) {
      const stack = resolveStack(command);
      if (stack === null) return { status: 1, stdout: '', stderr: 'no such compose file\n' };
      configurations.push(stack);
      return { status: 0, stdout: fakeComposeConfigJson(stack), stderr: '' };
    }
    if (command.args.includes('down')) {
      teardowns += 1;
      // `-v` REMOVES THE VOLUMES, which is what makes the next restore a restore into nothing.
      if (command.args.includes('-v')) { databaseSchema = null; importedRecords = 0; }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command.args.includes('up')) {
      const stack = resolveStack(command);
      if (stack === null) return { status: 1, stdout: '', stderr: 'no such compose file\n' };
      const images: Record<string, string> = {};
      const mounts: string[] = [];
      for (const [name, service] of Object.entries(stack.services)) {
        images[name] = String(service.image ?? '');
        for (const mount of (service.volumes ?? []) as YamlValue[]) {
          const map = mount as YamlMap;
          mounts.push(`${String(map.source ?? '')}:${String(map.target ?? '')}`);
        }
      }
      // EVERY PRODUCT SERVICE HAS TO BE AN IMAGE THIS HOST HOLDS. `postgres` is not one of this product's, so
      // it is not looked up; the other three are, and an `up` that left one on the base definition's reference
      // fails here exactly as a real host without that image would.
      for (const service of ['migrate', 'app', 'sidecar']) {
        if (options.images[images[service] ?? ''] === undefined) {
          return { status: 1, stdout: '', stderr: `the image for ${service} is not on this host\n` };
        }
      }
      const contents = options.images[images.app!]!;
      ups.push({ images, image: images.app!, mounts, overrideFile: composeFiles(command.args).slice(-1)[0] ?? '' });
      selected = contents;
      // THE MIGRATION RUNS ON BOOT, and it is the MIGRATE service's image that runs it — which is why that
      // service is pinned. A build that expects a newer schema than the database is at moves it.
      const migrate = options.images[images.migrate!]!;
      if (databaseSchema !== null && migrate.schema > databaseSchema) databaseSchema = migrate.schema;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command.args.includes('psql')) {
      // The rehearsal prepares the one product-managed ACL target before replaying a pg_dump. It is
      // credential-free and changes no database contents, so model it separately from the following -f.
      if (command.args.includes('-c')) return { status: 0, stdout: 'DO\n', stderr: '' };
      const workspace = join(command.cwd, 'catalog-rehearsal-restore');
      if (!existsSync(workspace)) return { status: 1, stdout: '', stderr: 'nothing to restore from\n' };
      const dump = join(workspace, 'catalog-backup.sql');
      if (!existsSync(dump)) return { status: 1, stdout: '', stderr: 'no dump in the workspace\n' };
      restores.push({
        digest: createHash('sha256').update(readFileSync(dump)).digest('hex'),
        components: readdirSync(workspace).slice().sort(),
      });
      databaseSchema = options.setSchema;
      importedRecords = 0;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command.args.includes('npm')) {
      appCommands.push(command.args.slice(command.args.indexOf('npm')).join(' '));
      if (selected === null) return { status: 1, stdout: '', stderr: 'nothing is running\n' };
      if (joined.includes('pkg get version')) {
        return { status: 0, stdout: `${JSON.stringify(selected.version)}\n`, stderr: '' };
      }
      if (joined.includes('ops:version')) {
        const db = databaseSchema === null ? 'unknown' : String(databaseSchema);
        const match = databaseSchema === selected.schema;
        return {
          status: match ? 0 : 1,
          stdout: `schema version: db=${db} expected=${selected.schema} — ${match ? 'OK' : 'MISMATCH'}\n`,
          stderr: '',
        };
      }
      if (joined.includes('ops:catalog-import')) {
        const apply = command.args.includes('--apply');
        const already = importedRecords;
        const created = already >= importRecords ? 0 : importRecords - already;
        if (apply) importedRecords = importRecords;
        // A DUPLICATE WRITE THAT STILL EXITS ZERO. Modelled deliberately: it is the only shape in which the
        // exit-code check passes and the catalog has been doubled.
        const duplicated = apply && already >= importRecords && options.importReplayDuplicates === true;
        return {
          status: 0,
          stdout: `${JSON.stringify({
            ok: true,
            report: 'phase-259-catalog-import',
            mode: apply ? 'apply' : 'preview',
            source: 'a-representative-source',
            snapshotDigest: 'a'.repeat(64),
            total: importRecords,
            created: duplicated ? importRecords : created,
            updated: 0,
            unchanged: duplicated ? 0 : importRecords - created,
            blocked: 0,
            failed: 0,
            notAttempted: 0,
            items: [],
            notes: [],
          })}\n`,
          stderr: '',
        };
      }
      return base.runner(command);
    }
    return base.runner(command);
  };

  return {
    ...base,
    runner,
    get ups() { return ups; },
    get restores() { return restores; },
    get teardowns() { return teardowns; },
    get appCommands() { return appCommands; },
    get configurations() { return configurations; },
  };
}

/**
 * Everything a REAL rehearsal must have done, asked of what the world observed.
 *
 * Each of these fails on the first implementation of this tranche, and each names the false proof it closes.
 */
export function rehearsalProblems(world: RehearsalWorld, expected: {
  readonly currentImage: string;
  readonly candidateImage: string;
  readonly components: readonly string[];
}): string[] {
  const problems: string[] = [];
  const selected = world.ups.map((up) => up.image);
  if (!selected.includes(expected.currentImage)) problems.push('no boot ever selected the current image');
  if (!selected.includes(expected.candidateImage)) {
    problems.push('no boot ever selected the CANDIDATE image, so no upgrade was rehearsed');
  }
  if (new Set(selected).size < 2) problems.push('every boot selected the same image');
  // The LAST boot must be the current image again: that is what makes the rollback a rollback.
  if (selected.length > 0 && selected[selected.length - 1] !== expected.currentImage) {
    problems.push('the last boot was not the current image, so the rollback did not put the previous one back');
  }
  // EVERY PRODUCT SERVICE, NOT ONLY THE APP. `migrate` runs the migration and `sidecar` holds the custody
  // path; a boot that left either on another image rehearsed a mixture of two builds.
  for (const up of world.ups) {
    for (const service of ['migrate', 'sidecar']) {
      if (up.images[service] !== up.image) {
        problems.push(`a boot ran ${service} on a different image from the app, so that leg was a mixture of builds`);
      }
    }
  }
  for (const up of world.ups) {
    for (const component of expected.components) {
      if (!up.mounts.some((mount) => mount.includes(component))) {
        problems.push(`a boot wired no ${component} mount, so that component was never restored into it`);
      }
    }
  }
  if (world.restores.length < 2) problems.push('the same set was not restored a second time for the rollback');
  const digests = new Set(world.restores.map((restore) => restore.digest));
  if (digests.size > 1) problems.push('the second restore was not byte-identical to the first');
  for (const restore of world.restores) {
    for (const component of expected.components) {
      if (!restore.components.some((entry) => entry.includes(component))) {
        problems.push(`the restore workspace held no ${component}, so a restore from it was not a restore`);
      }
    }
  }
  const app = world.appCommands.join(' | ');
  for (const [needle, what] of [
    ['pkg get version', 'no product version was ever read out of a running image'],
    ['ops:version', 'no schema version was ever read'],
    ['ops:doctor', 'the doctor never ran'],
    ['ops:collections -- status', 'nothing ever read and decrypted the catalog'],
    ['ops:collections -- history', 'the durable history was never read'],
    ['ops:catalog-import', 'no representative import ever ran'],
  ] as Array<[string, string]>) {
    if (!app.includes(needle)) problems.push(what);
  }
  const applies = world.appCommands.filter((entry) => entry.includes('ops:catalog-import') && entry.includes('--apply'));
  if (applies.length < 2) problems.push('the representative import was never replayed, so idempotence was not shown');
  if (!world.appCommands.some((entry) => entry.includes('ops:catalog-import') && !entry.includes('--apply'))) {
    problems.push('the representative import was never previewed');
  }
  if (world.teardowns < 2) problems.push('the upgraded state was never destroyed for the rollback');
  return problems;
}

/**
 * Words that must never appear in a maintenance run's command ledger.
 *
 * The absolute invariant, expressed as a scan over what was actually run: this product never downloads,
 * scrapes, plays or acquires media, never talks to a media server, and never reaches a registry.
 */
export const LEDGER_FORBIDDEN: readonly string[] = Object.freeze([
  'pull', 'login', 'push', 'build',
  'http://', 'https://', 'ghcr.io', 'docker.io', 'quay.io',
  'jellyfin', 'plex', 'emby',
  '/mnt/user/media', 'Movies', '.mkv', '.mp4',
  'nzb', 'torrent', 'magnet', 'usenet', 'sabnzbd',
  'curl', 'wget',
]);

/**
 * Assert a ledger contains none of the forbidden words, allowing the ones a legitimate flag spells.
 *
 * `--pull never` is the one place the word `pull` may appear, and it appears there BECAUSE it is the flag
 * that forbids pulling. The exemption is exact — the token must be the flag followed by `never` — so a bare
 * `pull` subcommand is still caught.
 */
export function assertLedgerIsClean(lines: readonly string[]): string[] {
  const problems: string[] = [];
  for (const line of lines) {
    const withoutPullNever = line.split('--pull never').join('--<the flag that forbids fetching>');
    const lower = withoutPullNever.toLowerCase();
    for (const forbidden of LEDGER_FORBIDDEN) {
      if (lower.includes(forbidden.toLowerCase())) {
        problems.push(`a maintenance command carried "${forbidden}"`);
      }
    }
  }
  return problems;
}
