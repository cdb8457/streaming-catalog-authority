import { constants, promises as fsPromises } from 'node:fs';

import { registerEntry, registerVersion, withRegistry, type Queryable } from '../core/projection/source-registry.js';
import { readNamespaceSnapshot } from '../core/projection/namespace-snapshot.js';
import { UsenetAdmissionService, stateOf, type AdmissionPublisher, type ReconcileOutcome, type SubmitOutcome } from '../core/usenet/admission.js';
import { SabClient, type SabEndpoint } from '../core/usenet/sab-client.js';
import { createSabHttpTransport } from '../core/usenet/sab-http-transport.js';
import { createRealOutputFileSystem } from '../core/usenet/output-fs.js';
import {
  createFileLedgerStorage,
  UsenetJobLedger,
  USENET_LEDGER_SUBDIR,
  usenetLedgerPath,
  withUsenetLedgerLock,
  type LedgerJob,
} from '../core/usenet/job-ledger.js';
import { readSabApiKeyFile, type ApiKeyFileKind, type ApiKeyFileStat, type ApiKeyFileSystem } from '../core/usenet/sab-api-key.js';
import { relativeSegmentsUnderRoot } from '../core/usenet/completed-output.js';
import { seal, type SealedValue } from '../core/usenet/sealed.js';
import { renderStatusLines, toStatusDocument, USENET_REFUSAL_MEANINGS, type UsenetStatusDocument } from '../core/usenet/status-report.js';
import {
  SAB_BOUNDARY_CONTRACT,
  SAB_CLIENT_BOUNDS,
  USENET_ADMISSION_BOUNDS,
  USENET_DEDICATED_CATEGORY,
  USENET_JOB_STATES,
  USENET_JOB_STATE_TITLES,
  USENET_PROJECTED_PATH_PREFIX,
  USENET_REFUSAL_REASONS,
  isTransientRefusal,
} from '../core/usenet/sab-contract.js';
import { PHASE9_OPERATOR_INPUTS } from '../core/projection/phase9.js';

// Projection Phase 9 §3, FIFTH DELIVERABLE — "an operator command surface for submit, status, admit,
// retry-safe reconciliation and refusal diagnostics".
//
// FIVE VERBS, AND THE SHAPE OF EACH ONE IS AN ARGUMENT ABOUT WHAT AN OPERATOR SHOULD HAVE TO KNOW.
//
//   preflight   — everything that can be wrong before anything is contacted, in one pass, as sentences. It is
//                 the same argument `real-provider.ts` makes: somebody assembling a credential, a category and
//                 three directories should learn everything that is wrong in one run.
//   submit      — one source, once, ever. The URL is read FROM A FILE, never from argv, for the same reason
//                 the API key is: `ps`, a shell history and a container inspect all show argv, and closure
//                 rule 9 says an NZB or indexer URL appears in no preserved evidence.
//   status      — the closed-set lifecycle for every recorded job, and nothing that names content.
//   reconcile   — the retry-safe verb. It is the ONLY thing that advances a job, it is idempotent, and running
//                 it twice in a row is not merely safe but the ordinary way to use it.
//   diagnose    — what every refusal means, what every bound is, and what an operator still has to supply.
//
// WHY `admit` IS NOT A SEPARATE VERB. It was in the first draft. An operator-triggered admit is a second code
// path into the one operation this tranche promises happens exactly once, and two paths into an exactly-once
// operation is how it becomes twice. `reconcile` admits everything that is ready; `reconcile --job <prefix>`
// narrows it to one. The admission logic has one caller.

export interface UsenetCommandConfig {
  readonly worker: SabEndpoint;
  /** The path to the API key file. The KEY is never in this document. */
  readonly apiKeyFile: string;
  readonly category: string;
  /** The worker's dedicated completed-download root, as the control plane sees it. */
  readonly completedRoot: string;
  /** The media root the appliance already serves as a local projection root. */
  readonly mediaRoot: string;
  /** The configured local root id for that media root. */
  readonly rootId: string;
  /** A durable directory. The ledger lives in a sub-directory of it, never at its top level. */
  readonly stateDir: string;
  readonly pathPrefix: string;
}

export class UsenetCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'UsenetCommandError';
  }
}

const ABSOLUTE_POSIX = /^\/[^\0]*$/;
const ID_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parse and fully validate the operator's configuration.
 *
 * STRICT, AND UNKNOWN KEYS ARE REFUSED. This document decides where a credential is read from and which
 * directory is treated as the worker's; a typo in it must be a loud rejection rather than a default that
 * quietly points somewhere else.
 */
export function parseUsenetConfig(raw: unknown): UsenetCommandConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UsenetCommandError('CONFIG_NOT_AN_OBJECT', 'the usenet configuration must be a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  const allowed = ['worker', 'apiKeyFile', 'category', 'completedRoot', 'mediaRoot', 'rootId', 'stateDir', 'pathPrefix'];
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) throw new UsenetCommandError('CONFIG_UNKNOWN_KEY', `the usenet configuration has an unknown key: ${key}`);
  }

  const worker = doc['worker'];
  if (worker === null || typeof worker !== 'object' || Array.isArray(worker)) {
    throw new UsenetCommandError('CONFIG_WORKER_MISSING', 'the usenet configuration needs a worker endpoint');
  }
  const workerDoc = worker as Record<string, unknown>;
  const host = workerDoc['host'];
  const port = workerDoc['port'];
  const scheme = workerDoc['scheme'] ?? 'http';
  if (typeof host !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/.test(host)) {
    throw new UsenetCommandError('CONFIG_WORKER_HOST_INVALID', 'the worker host is a plain hostname or address');
  }
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new UsenetCommandError('CONFIG_WORKER_PORT_INVALID', 'the worker port is a TCP port');
  }
  if (scheme !== 'http' && scheme !== 'https') {
    throw new UsenetCommandError('CONFIG_WORKER_SCHEME_INVALID', 'the worker scheme is http or https');
  }

  const requireAbsolute = (key: string): string => {
    const value = doc[key];
    if (typeof value !== 'string' || !ABSOLUTE_POSIX.test(value) || value.includes('\\')) {
      throw new UsenetCommandError(`CONFIG_${key.toUpperCase()}_INVALID`,
        `${key} must be an absolute POSIX path; a relative one would resolve against whatever directory the `
        + 'command happened to be run from');
    }
    return value.replace(/\/+$/, '');
  };

  const apiKeyFile = requireAbsolute('apiKeyFile');
  const completedRoot = requireAbsolute('completedRoot');
  const mediaRoot = requireAbsolute('mediaRoot');
  const stateDir = requireAbsolute('stateDir');

  const rootId = doc['rootId'];
  if (typeof rootId !== 'string' || !ID_LABEL.test(rootId)) {
    throw new UsenetCommandError('CONFIG_ROOT_ID_INVALID', 'rootId names a configured local root by label');
  }
  const category = doc['category'] ?? USENET_DEDICATED_CATEGORY;
  if (category !== USENET_DEDICATED_CATEGORY) {
    // NARROWING IS NOT OFFERED. A category other than the dedicated one means this phase would be reaching
    // into downloads an operator started for their own reasons, which §2's last paragraph forbids.
    throw new UsenetCommandError('CONFIG_CATEGORY_INVALID',
      `the category must be the dedicated ${USENET_DEDICATED_CATEGORY}; this phase does not read an operator's `
      + 'general download tree');
  }
  const pathPrefix = doc['pathPrefix'] ?? USENET_PROJECTED_PATH_PREFIX;
  if (typeof pathPrefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pathPrefix)) {
    throw new UsenetCommandError('CONFIG_PATH_PREFIX_INVALID', 'pathPrefix is a single plain path segment');
  }

  return {
    worker: { host, port: port as number, scheme: scheme as 'http' | 'https' },
    apiKeyFile,
    category,
    completedRoot,
    mediaRoot,
    rootId,
    stateDir,
    pathPrefix,
  };
}

/** The completed root's position under the media root, as segments. Refuses anything that is not below it. */
export function completedRootSegments(config: UsenetCommandConfig): readonly string[] {
  const relative = relativeSegmentsUnderRoot(config.mediaRoot, config.completedRoot);
  if (!relative.ok) {
    throw new UsenetCommandError('CONFIG_COMPLETED_ROOT_NOT_UNDER_MEDIA_ROOT',
      'the completed-download root must be a dedicated directory strictly under the media root the appliance '
      + 'already serves; a file outside that root cannot be reached by a local locator');
  }
  return relative.value;
}

// ---------------------------------------------------------------------------------------------------------
// Real-filesystem adapters
// ---------------------------------------------------------------------------------------------------------

export function createRealApiKeyFileSystem(): ApiKeyFileSystem {
  return {
    async lstatFile(path: string): Promise<ApiKeyFileStat> {
      const stat = await fsPromises.lstat(path);
      let kind: ApiKeyFileKind = 'other';
      if (stat.isSymbolicLink()) kind = 'symlink';
      else if (stat.isFile()) kind = 'file';
      else if (stat.isDirectory()) kind = 'directory';
      else if (stat.isBlockDevice() || stat.isCharacterDevice()) kind = 'device';
      else if (stat.isFIFO()) kind = 'fifo';
      else if (stat.isSocket()) kind = 'socket';
      // Windows reports a mode with group and other bits set for every file, which would refuse every
      // credential on a developer host. The appliance is Unraid, so the check is applied where it means
      // something and reported as inapplicable where it does not.
      return process.platform === 'win32'
        ? { kind, sizeBytes: stat.size }
        : { kind, mode: stat.mode & 0o7777, sizeBytes: stat.size };
    },
    async readFileNoFollow(path: string): Promise<Buffer> {
      const noFollow = (constants as Record<string, number | undefined>)['O_NOFOLLOW'] ?? 0;
      const handle = await fsPromises.open(path, constants.O_RDONLY | noFollow);
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * The publisher, wired to the EXISTING registration boundary and to nothing else.
 *
 * It calls `registerVersion` and `registerEntry`, which are the same two functions every other producer in
 * this project uses. There is no Usenet-specific table, no Usenet-specific column and no Usenet-specific
 * manifest field — an admitted Usenet file is a `local` source, which is a thing the daemon has served since
 * Phase 1. That is what §2's "publish it as a local source through the existing manifest contract" means, and
 * it is why the TorBox half needs no change at all.
 */
export function createRegistryPublisher(db: Queryable, connectionString?: string): AdmissionPublisher {
  return {
    // PROJECTION PHASE 10 D10.1 — THE DRIFT GUARD NOW RUNS ON A REAL APPLIANCE.
    //
    // Until Phase 10 this publisher returned `{ publish }` and nothing else, so `admit()` had no `before` to
    // compare against, skipped `torBoxDrift` on every real admission, and recorded every one of them
    // `admittedWithoutDriftCheck: true`. Phase 9 §4's sixth hard refusal — a Usenet outage may not alter the
    // TorBox namespace — was therefore a property of the rehearsal rather than of the product. Phase 10 §2.1
    // is the finding and this method is the repair.
    //
    // IT DOES NOT USE `db`. That client is the one `registerVersion` and `registerEntry` are about to write
    // on; the snapshot takes its own short-lived read-only connection so it can never issue BEGIN/COMMIT on
    // somebody else's transaction. `src/core/projection/namespace-snapshot.ts` is where that is argued, and
    // the connection string is threaded from the caller so a gate pointed at a throwaway database does not
    // silently read the appliance's real one.
    async namespaceSnapshot() {
      return readNamespaceSnapshot(connectionString);
    },
    async publish(plan, itemId) {
      if (!UUID.test(itemId)) {
        throw new UsenetCommandError('PUBLISH_ITEM_ID_INVALID', 'an admitted entry belongs to a catalog record');
      }
      await registerVersion(db, {
        versionKey: plan.versionKey,
        sizeBytes: plan.sizeBytes,
        mtime: plan.mtime,
        probes: plan.probes.map((probe) => ({
          position: probe.position, offset: probe.offset, length: probe.length, sha256: probe.sha256,
        })),
      });
      const projectedEntryId = await registerEntry(db, {
        itemId,
        versionKey: plan.versionKey,
        path: plan.projectedPath,
        sources: [{ kind: 'local', rootId: plan.rootId, objectRef: plan.relativePath }],
      });
      return { projectedEntryId };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------------------------------------

export interface PreflightProblem {
  readonly code: string;
  readonly message: string;
}

/**
 * What preflight needs from the host.
 *
 * INJECTED, like every other filesystem contact in this tranche, and for the same reason: the conditions
 * preflight exists to report — a missing directory, a symlinked one, an unwritable state directory — are
 * conditions a test host cannot always produce, and a preflight test that had to create `/var/lib/...` to run
 * would be a test that changed the machine it ran on.
 */
export interface PreflightDeps {
  readonly apiKeyFs: ApiKeyFileSystem;
  /** `lstat`, reduced to what preflight asks about a directory. */
  lstatDirectory(path: string): Promise<{ readonly kind: 'directory' | 'symlink' | 'other' | 'missing' }>;
  ensureDirectory(path: string): Promise<void>;
  /** Whether the platform reports meaningful POSIX modes. */
  readonly hasPosixModes: boolean;
}

export function createRealPreflightDeps(): PreflightDeps {
  return {
    apiKeyFs: createRealApiKeyFileSystem(),
    async lstatDirectory(path: string) {
      try {
        const stat = await fsPromises.lstat(path);
        if (stat.isSymbolicLink()) return { kind: 'symlink' as const };
        if (stat.isDirectory()) return { kind: 'directory' as const };
        return { kind: 'other' as const };
      } catch {
        return { kind: 'missing' as const };
      }
    },
    async ensureDirectory(path: string) {
      await fsPromises.mkdir(path, { recursive: true });
    },
    hasPosixModes: process.platform !== 'win32',
  };
}

/**
 * Everything that is wrong before anything is contacted, in one pass.
 *
 * IT DOES NOT TOUCH THE WORKER. Contacting it is a separate, explicit step, because a preflight that fails on
 * an unreachable worker cannot tell an operator that their key file is also world-readable — and they would
 * then fix one thing, run it again, and be told about the next.
 */
export async function preflight(
  config: UsenetCommandConfig,
  deps: PreflightDeps = createRealPreflightDeps(),
): Promise<readonly PreflightProblem[]> {
  const problems: PreflightProblem[] = [];

  try {
    completedRootSegments(config);
  } catch (error) {
    problems.push({
      code: (error as UsenetCommandError).code ?? 'CONFIG_INVALID',
      message: (error as Error).message,
    });
  }

  const key = await readSabApiKeyFile(deps.apiKeyFs, config.apiKeyFile, { requireMode: deps.hasPosixModes });
  if (!key.ok) {
    problems.push({ code: key.reason.toUpperCase().replace(/-/g, '_'), message: key.detail });
  }

  for (const [label, path] of [['completedRoot', config.completedRoot], ['mediaRoot', config.mediaRoot]] as const) {
    const stat = await deps.lstatDirectory(path);
    if (stat.kind === 'missing') {
      problems.push({ code: `${label.toUpperCase()}_MISSING`, message: `${label} does not exist` });
    } else if (stat.kind === 'symlink') {
      problems.push({
        code: `${label.toUpperCase()}_IS_SYMLINK`,
        message: `${label} is a symbolic link, which this phase refuses rather than follows`,
      });
    } else if (stat.kind !== 'directory') {
      problems.push({ code: `${label.toUpperCase()}_NOT_A_DIRECTORY`, message: `${label} is not a directory` });
    }
  }

  try {
    // THE SUBDIRECTORY NAME COMES FROM THE LEDGER MODULE, NEVER FROM A LITERAL HERE. Two spellings of the
    // same directory is how a preflight ends up creating one place and the ledger writing to another.
    await deps.ensureDirectory(`${config.stateDir}/${USENET_LEDGER_SUBDIR}`);
  } catch {
    problems.push({
      code: 'STATE_DIR_NOT_WRITABLE',
      message: 'the durable state directory could not be created; without it the exactly-once guarantee has '
        + 'nowhere to live',
    });
  }

  return problems;
}

export function openLedger(config: UsenetCommandConfig): UsenetJobLedger {
  return UsenetJobLedger.open(createFileLedgerStorage(usenetLedgerPath(config.stateDir)));
}

export async function loadSealedApiKey(config: UsenetCommandConfig): Promise<SealedValue> {
  const key = await readSabApiKeyFile(createRealApiKeyFileSystem(), config.apiKeyFile, {
    requireMode: process.platform !== 'win32',
  });
  if (!key.ok) throw new UsenetCommandError(key.reason.toUpperCase().replace(/-/g, '_'), key.detail);
  return key.key;
}

/**
 * Read one operator-approved NZB or indexer URL from a file, and seal it before it is anything else.
 *
 * THE FILE IS HELD TO THE SAME PERMISSION RULE AS THE CREDENTIAL. An indexer URL usually carries the
 * operator's own indexer API key as a query parameter, so it IS a credential whatever it is called, and
 * treating it as merely a URL is how one ends up in a world-readable file beside a carefully-protected one.
 */
export async function readSealedSource(path: string): Promise<SealedValue> {
  let stat: Awaited<ReturnType<typeof fsPromises.lstat>>;
  try {
    stat = await fsPromises.lstat(path);
  } catch {
    throw new UsenetCommandError('SOURCE_FILE_UNREADABLE', 'the NZB source file could not be examined');
  }
  if (stat.isSymbolicLink()) {
    throw new UsenetCommandError('SOURCE_FILE_PERMISSIVE', 'the NZB source path is a symbolic link, which is refused rather than followed');
  }
  if (!stat.isFile()) throw new UsenetCommandError('SOURCE_FILE_UNREADABLE', 'the NZB source path is not a regular file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new UsenetCommandError('SOURCE_FILE_PERMISSIVE',
      'the NZB source file grants access to group or other; an indexer URL carries an indexer key and is a '
      + 'credential whatever it is called');
  }
  if (stat.size === 0 || stat.size > 8192) {
    throw new UsenetCommandError('SOURCE_FILE_MALFORMED', 'the NZB source file does not hold a single URL');
  }

  // THE CHECKS ABOVE DESCRIBE THE PATH A MOMENT AGO; THE OPEN IS NOW, AND THE TWO ARE BOUND TOGETHER HERE.
  //
  // An `lstat` that refused a symlink followed by a plain `readFile` is the classic time-of-check race: the
  // path can be replaced with a link in between, and `readFile` follows it silently. `readSabApiKeyFile`
  // already opens its credential with `O_NOFOLLOW` for exactly this reason, and an indexer URL carries the
  // operator's indexer key — it is the same class of secret and gets the same treatment. The descriptor's own
  // `fstat` then re-answers every question the `lstat` answered, about the thing that was actually opened.
  const noFollow = (constants as Record<string, number | undefined>)['O_NOFOLLOW'] ?? 0;
  let text: string;
  try {
    const handle = await fsPromises.open(path, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) {
        throw new UsenetCommandError('SOURCE_FILE_UNREADABLE', 'the NZB source path is not a regular file');
      }
      if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
        throw new UsenetCommandError('SOURCE_FILE_PERMISSIVE',
          'the NZB source file grants access to group or other; an indexer URL carries an indexer key and is a '
          + 'credential whatever it is called');
      }
      if (opened.size === 0 || opened.size > 8192) {
        throw new UsenetCommandError('SOURCE_FILE_MALFORMED', 'the NZB source file does not hold a single URL');
      }
      text = (await handle.readFile('utf8')).trim();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // A `UsenetCommandError` raised above is the specific answer and is kept. Anything else is an open that
    // failed — including the `ELOOP` that `O_NOFOLLOW` raises on a link swapped in since the `lstat` — and it
    // is reported without the underlying message, which carries the path.
    if (error instanceof UsenetCommandError) throw error;
    throw new UsenetCommandError('SOURCE_FILE_UNREADABLE', 'the NZB source file could not be read');
  }
  if (!/^https?:\/\/[^\s"'<>]{8,4096}$/.test(text)) {
    throw new UsenetCommandError('SOURCE_FILE_MALFORMED',
      'the NZB source file must hold exactly one http or https URL on one line and nothing else');
  }
  return seal('nzb-source', text);
}

export interface ServiceHandles {
  readonly service: UsenetAdmissionService;
  readonly ledger: UsenetJobLedger;
}

/**
 * Build the admission service against the real worker, the real filesystem and the real registry.
 *
 * `connectionString` is threaded through for PHASE 10 D10.1 ALONE: the drift guard's namespace snapshot opens
 * its own connection, and a gate pointed at a throwaway database whose snapshot silently read the appliance's
 * real one would be a guard comparing the wrong namespace. It is optional and defaults exactly as
 * `withRegistry` does, so a caller that already relied on the default is unchanged.
 */
export async function openService(
  config: UsenetCommandConfig, db: Queryable, connectionString?: string,
): Promise<ServiceHandles> {
  const apiKey = await loadSealedApiKey(config);
  const ledger = openLedger(config);
  const client = new SabClient({
    endpoint: config.worker,
    apiKey,
    transport: createSabHttpTransport(),
    category: config.category,
  });
  const service = new UsenetAdmissionService({
    client,
    ledger,
    fs: createRealOutputFileSystem(),
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    },
    publisher: createRegistryPublisher(db, connectionString),
    completedRoot: config.completedRoot,
    rootId: config.rootId,
    completedRootUnderMediaRoot: completedRootSegments(config),
    category: config.category,
    pathPrefix: config.pathPrefix,
  });
  return { service, ledger };
}

export async function runSubmit(
  config: UsenetCommandConfig,
  input: { readonly sourceFile: string; readonly itemId: string },
  connectionString?: string,
): Promise<SubmitOutcome> {
  if (!UUID.test(input.itemId)) {
    throw new UsenetCommandError('ITEM_ID_INVALID', 'a submission names the catalog record its output will belong to');
  }
  const sealedSource = await readSealedSource(input.sourceFile);
  // THE LOCK WRAPS THE WHOLE COMMAND, INCLUDING THE LEDGER REPLAY INSIDE `openService`. `reserve()` decides
  // whether to send by reading the state it replayed on open, so two commands that both replayed an empty
  // ledger would both send. See `withUsenetLedgerLock`.
  return withUsenetLedgerLock(config.stateDir, () => withRegistry(async (db) => {
    const { service } = await openService(config, db, connectionString);
    return service.submit(sealedSource, input.itemId);
  }, connectionString));
}

export async function runReconcile(
  config: UsenetCommandConfig,
  filter?: string,
  connectionString?: string,
): Promise<readonly ReconcileOutcome[]> {
  // RECONCILIATION TAKES THE SAME LOCK AS SUBMISSION, and it has to: it is the only verb that may declare a
  // reservation LOST, and a submission racing that declaration is a submission that could be sent twice.
  return withUsenetLedgerLock(config.stateDir, () => withRegistry(async (db) => {
    const { service } = await openService(config, db, connectionString);
    const outcomes = await service.reconcileAll();
    return filter === undefined ? outcomes : outcomes.filter((outcome) => outcome.key.startsWith(filter));
  }, connectionString));
}

/** The status document, built from the ledger alone. It contacts nothing, so it works during an outage. */
export function runStatus(config: UsenetCommandConfig): UsenetStatusDocument {
  const ledger = openLedger(config);
  return toStatusDocument(ledger.all());
}

export interface DiagnoseDocument {
  readonly phase: 9;
  readonly worker: string;
  readonly lifecycle: readonly { readonly state: string; readonly meaning: string }[];
  readonly refusals: readonly { readonly reason: string; readonly meaning: string; readonly transient: boolean }[];
  readonly bounds: Readonly<Record<string, number>>;
  readonly hardRefusals: readonly string[];
  readonly operatorInputsStillRequired: readonly string[];
}

/**
 * Everything a refusal could be, what it means, and what is still missing.
 *
 * This is what an operator reads when they meet a state they do not recognise, and it is generated from the
 * closed sets rather than written out — a reason that exists in the code and not in this output would be a
 * refusal with no explanation, and a line here for a reason that no longer exists would be worse.
 */
export function runDiagnose(): DiagnoseDocument {
  return {
    phase: 9,
    worker: SAB_BOUNDARY_CONTRACT.worker,
    lifecycle: USENET_JOB_STATES.map((state) => ({ state, meaning: USENET_JOB_STATE_TITLES[state] })),
    refusals: USENET_REFUSAL_REASONS.map((reason) => ({
      reason,
      meaning: USENET_REFUSAL_MEANINGS[reason],
      transient: isTransientRefusal(reason),
    })),
    bounds: {
      requestTimeoutMs: SAB_CLIENT_BOUNDS.TIMEOUT_MS.default,
      maxResponseBytes: SAB_CLIENT_BOUNDS.MAX_RESPONSE_BYTES,
      maxSlots: SAB_CLIENT_BOUNDS.MAX_SLOTS,
      stableDwellMs: USENET_ADMISSION_BOUNDS.STABLE_DWELL_MS,
      stableSamples: USENET_ADMISSION_BOUNDS.STABLE_SAMPLES,
      minOutputBytes: USENET_ADMISSION_BOUNDS.MIN_OUTPUT_BYTES,
      maxOutputBytes: USENET_ADMISSION_BOUNDS.MAX_OUTPUT_BYTES,
    },
    hardRefusals: SAB_BOUNDARY_CONTRACT.hardRefusals,
    operatorInputsStillRequired: PHASE9_OPERATOR_INPUTS,
  };
}

/** Rendered lines for each verb, so the CLI never formats a document itself. */
export function renderPreflight(problems: readonly PreflightProblem[]): readonly string[] {
  if (problems.length === 0) return ['projection phase 9 preflight: nothing is wrong that can be seen without contacting the worker'];
  return ['projection phase 9 preflight: the following must be fixed before a submission', ...problems.map((problem) => `  ${problem.code}: ${problem.message}`)];
}

export function renderReconcile(outcomes: readonly ReconcileOutcome[]): readonly string[] {
  if (outcomes.length === 0) return ['nothing to reconcile'];
  return outcomes.map((outcome) => {
    const head = `  ${outcome.key.slice(0, 11)}  ${outcome.state.padEnd(14)}${outcome.changed ? ' (changed)' : ''}`;
    if (outcome.admitted !== undefined) return `${head} admitted ${outcome.admitted.projectedPath}`;
    if (outcome.reason !== undefined) return `${head} ${outcome.reason}: ${outcome.detail ?? ''}`;
    return head;
  });
}

export { renderStatusLines, stateOf, type LedgerJob };
