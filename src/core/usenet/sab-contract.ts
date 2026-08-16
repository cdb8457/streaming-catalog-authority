// Projection Phase 9 — the SABnzbd external contract, written down before anything is contacted.
//
// WHAT THIS IS. §2 of `docs/PROJECTION_PHASE_9_TORBOX_USENET.md` decides that Usenet is NOT forced through
// `source.Resolver`: a mature worker does NZB acquisition, article download, yEnc decoding, PAR repair and
// unpacking outside the FUSE read path, and the control plane integrates it through its bounded local API and
// its completed-download directory. The first supported worker is SABnzbd. This module is the whole of what
// this project believes about SABnzbd's API — the operations it will call, the states it will accept, the
// bounds it holds them to and the states it refuses to interpret.
//
// IT IS STATIC METADATA. No SDK import, no HTTP client, no environment read, no filesystem access. It is the
// same shape `src/core/adapters/torbox-boundary.ts` takes for the same reason: the contract a client is
// written against has to be reviewable on its own, without running anything, and a client that drifts from it
// has to fail a test rather than a production request.
//
// THE OFFICIAL SURFACE. SABnzbd's API is one endpoint, `/api`, selected by a `mode` query parameter, with
// `output=json` and an `apikey`. The five modes below are the whole of what Phase 9 needs, and the deliberate
// omissions are as much of the contract as the inclusions: nothing here deletes, purges, pauses, resumes,
// re-prioritises, edits configuration, or reads the worker's own settings. §4 forbids deleting completed
// media, SABnzbd history or operator input, and the safest way to keep a promise like that is to never
// implement the call that could break it.

/** The base path every SABnzbd request goes to. There is exactly one. */
export const SAB_API_PATH = '/api';

/** SABnzbd answers XML by default. Phase 9 asks for JSON and refuses anything else. */
export const SAB_OUTPUT_FORMAT = 'json';

/**
 * The five operations, and no sixth.
 *
 * `submit-url` is the only one that creates worker-side state. Everything else is a read. That asymmetry is
 * why the ledger exists and why `submit-url` is the one operation this tranche never retries automatically.
 */
export const SAB_OPERATIONS = Object.freeze([
  'version',
  'status',
  'queue',
  'history',
  'submit-url',
] as const);

export type SabOperation = (typeof SAB_OPERATIONS)[number];

/** The `mode` each operation sends. A reader can compare this table against the official documentation. */
export const SAB_OPERATION_MODES = Object.freeze({
  version: 'version',
  status: 'fullstatus',
  queue: 'queue',
  history: 'history',
  'submit-url': 'addurl',
} as const) satisfies Readonly<Record<SabOperation, string>>;

/** Which operations create provider-side state. Exactly one does, and it is never retried automatically. */
export const SAB_MUTATING_OPERATIONS: readonly SabOperation[] = Object.freeze(['submit-url']);

export function isSabOperation(value: unknown): value is SabOperation {
  return typeof value === 'string' && (SAB_OPERATIONS as readonly string[]).includes(value);
}

export function isMutatingSabOperation(operation: SabOperation): boolean {
  return SAB_MUTATING_OPERATIONS.includes(operation);
}

/**
 * The operations Phase 9 will not implement, with the reason each one is absent.
 *
 * This list is asserted by the boundary suite against the client's own exported surface, so "we simply have
 * not written it yet" and "we have decided not to" stay distinguishable — and so a future contributor who adds
 * one has to delete a line here that says why they should not.
 */
export const SAB_FORBIDDEN_OPERATIONS = Object.freeze([
  { mode: 'history', extra: 'del', reason: '§4 forbids deleting SABnzbd history' },
  { mode: 'queue', extra: 'delete', reason: '§4 forbids deleting operator input' },
  { mode: 'pause', extra: '', reason: 'Phase 9 observes the worker; it does not drive its scheduling' },
  { mode: 'resume', extra: '', reason: 'Phase 9 observes the worker; it does not drive its scheduling' },
  { mode: 'set_config', extra: '', reason: 'the worker is the operator\'s; its configuration is not ours to edit' },
  { mode: 'get_config', extra: '', reason: 'the worker\'s configuration carries NNTP server credentials' },
  { mode: 'shutdown', extra: '', reason: 'a control plane that can stop the worker can lose an in-flight job' },
  { mode: 'retry', extra: '', reason: 'a retry is a submission, and submissions go through the ledger' },
] as const);

// ---------------------------------------------------------------------------------------------------------
// The states, as closed sets
// ---------------------------------------------------------------------------------------------------------
//
// WHY CLOSED. §4's fourth hard refusal is "infer success from a job disappearing from the queue". The
// structural way to keep that promise is to never have a default branch: every state string the worker can
// send is either in one of these tables, in which case its meaning is written down here, or it is not, in
// which case the client refuses the reading rather than guessing what the worker meant. A worker upgrade that
// introduces a new state therefore produces a loud, named refusal instead of a silent admission.

/**
 * Queue slot statuses, from SABnzbd's own queue model. A job in ANY of these is in flight: it is not done,
 * and nothing it has written is safe to look at.
 */
export const SAB_QUEUE_STATUSES = Object.freeze([
  'Grabbing',
  'Queued',
  'Paused',
  'Checking',
  'Downloading',
  'QuickCheck',
  'Verifying',
  'Repairing',
  'Fetching',
  'Extracting',
  'Moving',
  'Running',
  'Propagating',
] as const);

export type SabQueueStatus = (typeof SAB_QUEUE_STATUSES)[number];

/**
 * History slot statuses. `Completed` is the only one that can lead to an admission, and it leads to an
 * ATTEMPT rather than to an admission: the output checks in `completed-output.ts` still have to pass.
 */
export const SAB_HISTORY_STATUSES = Object.freeze([
  'Completed',
  'Failed',
  'Queued',
  'Extracting',
  'Moving',
  'Repairing',
  'Verifying',
  'Running',
  'Fetching',
  'Propagating',
  'QuickCheck',
] as const);

export type SabHistoryStatus = (typeof SAB_HISTORY_STATUSES)[number];

export function isSabQueueStatus(value: unknown): value is SabQueueStatus {
  return typeof value === 'string' && (SAB_QUEUE_STATUSES as readonly string[]).includes(value);
}

export function isSabHistoryStatus(value: unknown): value is SabHistoryStatus {
  return typeof value === 'string' && (SAB_HISTORY_STATUSES as readonly string[]).includes(value);
}

/**
 * SABnzbd writes some of these with a space in some versions and without in others (`Quick Check` vs
 * `QuickCheck`). That is a rendering difference in the worker, not two states, so it is folded HERE — once,
 * visibly, in the contract — rather than by a `.replace(' ','')` scattered through a parser.
 */
export const SAB_STATUS_ALIASES = Object.freeze({
  'Quick Check': 'QuickCheck',
  'Post Processing': 'Running',
} as const);

export function canonicalSabStatus(raw: string): string {
  return Object.hasOwn(SAB_STATUS_ALIASES, raw)
    ? SAB_STATUS_ALIASES[raw as keyof typeof SAB_STATUS_ALIASES]
    : raw;
}

// ---------------------------------------------------------------------------------------------------------
// The operator-visible lifecycle
// ---------------------------------------------------------------------------------------------------------
//
// §3's last deliverable asks for a runbook that distinguishes downloading, repairing, unpacking,
// ready-to-admit, admitted and refused WITHOUT exposing provider or content identity. Those six are exactly
// the set below; there is no seventh, and in particular there is no "unknown" and no "missing". A job the
// control plane cannot place is a REFUSAL with a named reason, because "we do not know" printed next to
// somebody's download is the state an operator cannot act on.

export const USENET_JOB_STATES = Object.freeze([
  'downloading',
  'repairing',
  'unpacking',
  'ready-to-admit',
  'admitted',
  'refused',
] as const);

export type UsenetJobState = (typeof USENET_JOB_STATES)[number];

/** One line each, for the operator surface. Never a name, a path, a URL or an article id. */
export const USENET_JOB_STATE_TITLES: Readonly<Record<UsenetJobState, string>> = Object.freeze({
  downloading: 'the worker is acquiring articles; nothing has been written that anything may look at',
  repairing: 'the worker is verifying or PAR-repairing what it downloaded',
  unpacking: 'the worker is extracting or moving its output; the path is still the worker\'s to change',
  'ready-to-admit': 'the worker reports the job complete; the control plane has not yet proved the output',
  admitted: 'the output was proved and published as a local source, exactly once',
  refused: 'the control plane will not publish this job, for the named reason',
});

/**
 * The queue status to lifecycle map. Every queue status is present, because a partial map is a default branch
 * wearing a different hat.
 */
export const SAB_QUEUE_STATUS_LIFECYCLE: Readonly<Record<SabQueueStatus, UsenetJobState>> = Object.freeze({
  Grabbing: 'downloading',
  Queued: 'downloading',
  // A PAUSED JOB IS STILL DOWNLOADING, not a separate state. It has produced nothing complete, and the one
  // thing an operator needs to know — "may I look at the output yet" — has the same answer as Queued.
  Paused: 'downloading',
  Downloading: 'downloading',
  Fetching: 'downloading',
  Propagating: 'downloading',
  Checking: 'repairing',
  QuickCheck: 'repairing',
  Verifying: 'repairing',
  Repairing: 'repairing',
  Extracting: 'unpacking',
  Moving: 'unpacking',
  Running: 'unpacking',
});

/**
 * The history status map. `Completed` is `ready-to-admit` and NOT `admitted`: the worker saying it finished is
 * the beginning of the control plane's checks, never the end of them.
 */
export const SAB_HISTORY_STATUS_LIFECYCLE: Readonly<Record<SabHistoryStatus, UsenetJobState>> = Object.freeze({
  Completed: 'ready-to-admit',
  Failed: 'refused',
  Queued: 'downloading',
  Fetching: 'downloading',
  Propagating: 'downloading',
  Verifying: 'repairing',
  Repairing: 'repairing',
  QuickCheck: 'repairing',
  Extracting: 'unpacking',
  Moving: 'unpacking',
  Running: 'unpacking',
});

// ---------------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------------

/**
 * Every reason this tranche will decline to publish something, as a closed set.
 *
 * An operator reads these, so each one is a fact about the WORLD rather than about the code: what was wrong
 * with the output, not which function returned false. None of them can carry a path, a URL or a name — they
 * are constants, so there is nowhere for one to be interpolated.
 */
export const USENET_REFUSAL_REASONS = Object.freeze([
  // --- what the worker said -------------------------------------------------------------------------------
  'job-failed-at-worker',
  'job-not-complete',
  'job-still-queued',
  'job-absent-from-worker',
  'worker-state-unrecognised',
  'worker-unreachable',
  'worker-response-malformed',
  'worker-response-too-large',
  'worker-rejected-credential',
  // --- what the output was --------------------------------------------------------------------------------
  'output-root-unusable',
  'output-path-escapes-root',
  'output-path-not-normalized',
  'output-not-uniquely-identified',
  'output-unpack-residue',
  'output-component-is-symlink',
  'output-is-symlink',
  'output-not-regular-file',
  'output-missing',
  'output-empty',
  'output-too-large',
  'output-multiply-linked',
  'output-still-changing',
  'output-mutated-during-digest',
  'output-name-not-projectable',
  // --- what the ledger said -------------------------------------------------------------------------------
  'already-admitted',
  'admitted-digest-mismatch',
  'ledger-state-conflict',
  'submission-not-reserved',
  'catalog-record-missing',
  // --- what the operator supplied -------------------------------------------------------------------------
  'credential-file-unreadable',
  'credential-file-permissive',
  'credential-file-malformed',
  'nzb-source-not-approved',
  'category-not-dedicated',
] as const);

export type UsenetRefusalReason = (typeof USENET_REFUSAL_REASONS)[number];

export function isUsenetRefusalReason(value: unknown): value is UsenetRefusalReason {
  return typeof value === 'string' && (USENET_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * Whether a refusal is worth retrying later without an operator doing anything.
 *
 * TRANSIENT DOES NOT MEAN HARMLESS. It means the control plane may look again on its own schedule. A
 * PERMANENT refusal means looking again will produce the same answer, so an operator has to change something
 * — and a reconciliation loop that retried one of those forever would be a loop that never tells anybody.
 */
export const USENET_TRANSIENT_REFUSALS: readonly UsenetRefusalReason[] = Object.freeze([
  'job-not-complete',
  'job-still-queued',
  'worker-unreachable',
  'output-still-changing',
  'output-mutated-during-digest',
  'output-missing',
  // AN UNPACK RESIDUE IS TRANSIENT BY NATURE. A `.rar` or a `.par2` beside the media means the worker is
  // still finishing, and the next reconciliation is exactly the right thing to do about it.
  'output-unpack-residue',
]);

export function isTransientRefusal(reason: UsenetRefusalReason): boolean {
  return USENET_TRANSIENT_REFUSALS.includes(reason);
}

// ---------------------------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------------------------

/**
 * Every bound the client and the admission service hold themselves to.
 *
 * They are here rather than at their use sites because a bound that lives next to the code it bounds is a
 * bound the next edit moves. `test/usenet-sab-client.ts` drives the client against each one.
 */
export const SAB_CLIENT_BOUNDS = Object.freeze({
  /** Per-request, and the ceiling is deliberately short: this is a LOCAL worker on the operator's own host. */
  TIMEOUT_MS: Object.freeze({ min: 250, default: 5_000, max: 30_000 }),
  /** A queue or history document larger than this is not a document; it is a fault or a wrong endpoint. */
  MAX_RESPONSE_BYTES: 8 * 1024 * 1024,
  /** How many slots one queue or history page is parsed from. Above this the reading is refused, not cut. */
  MAX_SLOTS: 2_000,
  /** How many history entries one page asks for. SABnzbd defaults to a short page; this is explicit. */
  HISTORY_PAGE_LIMIT: 200,
  /** Read operations may be retried. `submit-url` may not, at any count, ever. */
  MAX_READ_ATTEMPTS: 3,
  RETRY_BASE_DELAY_MS: 200,
  RETRY_MAX_DELAY_MS: 2_000,
} as const);

export const USENET_ADMISSION_BOUNDS = Object.freeze({
  /**
   * How long an output must hold still before it is digested, and how many samples that takes.
   *
   * WHY A DWELL AND NOT A SINGLE STAT. §4's second hard refusal is "publish a path while the worker can still
   * mutate it". A single stat cannot distinguish a finished file from one being written at the moment it was
   * asked. Two samples separated by a dwell, agreeing on size, device, inode AND mtime, can distinguish it
   * from every case except a worker that pauses for exactly this long — and the post-digest re-stat below
   * catches that one.
   */
  STABLE_DWELL_MS: 2_000,
  STABLE_SAMPLES: 2,
  /** A completed media file larger than this is refused rather than digested; it is almost certainly not one. */
  MAX_OUTPUT_BYTES: 512 * 1024 * 1024 * 1024,
  /** A media file smaller than this is a sample, a notice or a repair artefact, not something to publish. */
  MIN_OUTPUT_BYTES: 1_048_576,
  /** How deep under the completed root the admission walk will look for the media file. */
  MAX_OUTPUT_DEPTH: 6,
  /** How many entries one directory may hold before the walk refuses rather than enumerating forever. */
  MAX_DIRECTORY_ENTRIES: 4_096,
  /** Read size for the digest pass. One pass computes the whole-file digest AND the fixed probe windows. */
  DIGEST_CHUNK_BYTES: 1024 * 1024,
} as const);

/**
 * The dedicated category, and the rule that it must BE dedicated.
 *
 * §2's last paragraph: a dedicated category and dedicated incomplete/complete directories, rather than
 * scanning an operator's general download tree. The category name is part of the contract because the
 * admission service refuses any job whose category is not this one — which is what stops a Phase 9 run from
 * reaching into a download the operator started for their own reasons.
 */
export const USENET_DEDICATED_CATEGORY = 'projection';

/** The path prefix admitted entries appear under inside the projection namespace. */
export const USENET_PROJECTED_PATH_PREFIX = 'usenet';

/**
 * The marker a submission carries so a restart can find its own job again without submitting a second one.
 *
 * WHY IT IS NOT THE NZB NAME. SABnzbd's `nzbname` parameter sets the display name of a job, and the display
 * name is content identity — it is the release name, which is exactly what §4 and closure rule 9 keep out of
 * evidence. So the submission sets `nzbname` to this prefix plus the submission key's own opaque digest: a
 * value that is stable across a restart, unique per submission, and says nothing about what was downloaded.
 */
export const USENET_SUBMISSION_MARKER_PREFIX = 'projection-';

/** `projection-<32 hex>`. The shape a reconciliation matches on, and nothing looser. */
export const USENET_SUBMISSION_MARKER_SHAPE = /^projection-[0-9a-f]{32}$/;

export function submissionMarkerFor(submissionDigest: string): string {
  if (!/^[0-9a-f]{32}$/.test(submissionDigest)) {
    throw new Error('SUBMISSION_DIGEST_INVALID: a submission marker is derived from 32 hex characters');
  }
  return `${USENET_SUBMISSION_MARKER_PREFIX}${submissionDigest}`;
}

/**
 * The whole contract, as one frozen document, for the boundary suite and for an operator reading it directly.
 */
export const SAB_BOUNDARY_CONTRACT = Object.freeze({
  phase: 9,
  name: 'sabnzbd-worker-boundary',
  worker: 'SABnzbd',
  officialSources: Object.freeze([
    'https://sabnzbd.org/wiki/advanced/api',
    'https://sabnzbd.org/wiki/configuration/4.5/general',
  ]),
  apiPath: SAB_API_PATH,
  outputFormat: SAB_OUTPUT_FORMAT,
  operations: SAB_OPERATIONS,
  modes: SAB_OPERATION_MODES,
  mutatingOperations: SAB_MUTATING_OPERATIONS,
  forbiddenOperations: SAB_FORBIDDEN_OPERATIONS,
  credentialRules: Object.freeze([
    'The API key is read from a file whose mode grants nothing to group or other.',
    'The key is never an argv element, an inline environment value, a manifest field or a metric label.',
    'The key is carried as a sealed value and revealed only where a request is composed.',
    'A request URL carrying the key is never logged, thrown, stored or reported.',
    'No NNTP credential is read by this project at all; the worker holds those and Phase 9 never asks.',
  ]),
  dataCrossingRules: Object.freeze([
    'Outbound: one operator-approved NZB or indexer URL, sealed, plus the dedicated category.',
    'Inbound: closed-set states, byte counts, and a sealed completed path.',
    'Never outbound: catalog identity, titles, item ids, projected paths.',
    'Never reported: NZB URLs, article ids, release names, completed paths, worker job ids.',
  ]),
  hardRefusals: Object.freeze([
    'stream incomplete Usenet articles through FUSE',
    'publish a path while the worker can still mutate it',
    'follow a symlink or admit a device, FIFO, socket or directory as media',
    'infer success from a job disappearing from the queue',
    'delete completed media, SABnzbd history or operator input',
    'let a Usenet outage alter the TorBox namespace',
    'place an NNTP or SABnzbd credential in the projection daemon',
    'claim Real-Debrid support',
  ]),
  bounds: SAB_CLIENT_BOUNDS,
  admissionBounds: USENET_ADMISSION_BOUNDS,
  dedicatedCategory: USENET_DEDICATED_CATEGORY,
  lifecycle: USENET_JOB_STATES,
  refusalReasons: USENET_REFUSAL_REASONS,
} as const);
