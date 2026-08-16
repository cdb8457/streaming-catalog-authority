import { seal, type SealedValue } from './sealed.js';
import {
  SAB_API_PATH,
  SAB_CLIENT_BOUNDS,
  SAB_OPERATION_MODES,
  SAB_OUTPUT_FORMAT,
  USENET_DEDICATED_CATEGORY,
  USENET_SUBMISSION_MARKER_SHAPE,
  canonicalSabStatus,
  isMutatingSabOperation,
  isSabHistoryStatus,
  isSabQueueStatus,
  type SabHistoryStatus,
  type SabOperation,
  type SabQueueStatus,
  type UsenetRefusalReason,
} from './sab-contract.js';

// Projection Phase 9 — the bounded, redaction-safe SABnzbd client.
//
// WHAT IT IS ALLOWED TO DO: the five operations in `sab-contract.ts`, one at a time, with a bounded timeout, a
// bounded response size and a bounded slot count. What it is NOT allowed to do is everything else, and the way
// that is enforced is that no other request can be composed here — `buildRequest` switches over the operation
// union, and the union has five members.
//
// THE THREE PROPERTIES THIS FILE EXISTS TO HOLD.
//
//   1. FAIL CLOSED, ALWAYS. Every failure — transport, timeout, non-2xx, oversized body, unparseable JSON,
//      an unknown state string — produces a named refusal. None of them produces a partial reading, and in
//      particular NONE of them produces "the job is not in the queue, so it must be done". §4's fourth hard
//      refusal is exactly that inference, and the only way to reach `ready-to-admit` here is to find the job
//      in HISTORY with a status this contract recognises as complete.
//
//   2. THE KEY IS SEALED AND THE URL IS NEVER MATERIALISED FOR ANYBODY BUT THE SOCKET. SABnzbd authenticates
//      with an `apikey` query parameter — that is its API, not a choice this project gets to make — so the
//      credential does end up in a URL. What this file guarantees is that the URL carrying it exists for the
//      duration of one `request()` call and is never returned, logged, thrown or stored. The request object
//      the transport receives carries the key as a `SealedValue` in its own field, so a transport
//      implementation has to call `.reveal()` deliberately; there is no accidental route.
//
//   3. NO AUTOMATIC RETRY OF A SUBMISSION, AT ANY COUNT. A read that times out may be repeated, because
//      repeating it changes nothing. A submission that times out may NOT, because the worker may have
//      accepted it, and a second submission of the same NZB is a second download of the same bytes on
//      somebody's metered account. Recovering from an ambiguous submission is the ledger's job and it is done
//      by LOOKING, not by asking again.

export interface SabEndpoint {
  /** `127.0.0.1` in every deployment this tranche describes. The worker is local. */
  readonly host: string;
  readonly port: number;
  /** `http` in every deployment this tranche describes; `https` accepted for an operator who fronts it. */
  readonly scheme: 'http' | 'https';
}

export interface SabTransportRequest {
  readonly operation: SabOperation;
  readonly method: 'GET' | 'POST';
  readonly endpoint: SabEndpoint;
  readonly path: string;
  /** Query parameters that are NOT secret. The key and the NZB source are not in here. */
  readonly query: Readonly<Record<string, string>>;
  /** The API key, sealed. A transport reveals it exactly once, when it composes the request line. */
  readonly apiKey: SealedValue;
  /** The NZB or indexer URL, sealed. Present only on `submit-url`. */
  readonly sealedSource?: SealedValue;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface SabTransportResponse {
  readonly status: number;
  /** Parsed JSON, or `undefined` when the body was not JSON. The transport does not interpret it. */
  readonly body?: unknown;
  /** Bytes actually read. Used to enforce the response bound even when a transport streams. */
  readonly byteLength?: number;
}

export interface SabTransport {
  request(request: SabTransportRequest): Promise<SabTransportResponse>;
}

export interface SabClientConfig {
  readonly endpoint: SabEndpoint;
  readonly apiKey: SealedValue;
  readonly transport: SabTransport;
  readonly timeoutMs?: number;
  /** Injected so a retry backoff is testable without a real clock. Defaults to a real sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The dedicated category. Defaults to the contract's; an operator may only narrow, never widen. */
  readonly category?: string;
}

// ---------------------------------------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------------------------------------

export interface SabQueueSlot {
  /** SABnzbd's `nzo_id`. Opaque worker state; sealed because it correlates to somebody's download. */
  readonly jobRef: SealedValue;
  readonly status: SabQueueStatus;
  /** The submission marker, when this job carries one of ours. Never the release name. */
  readonly marker: string | null;
  readonly category: string;
  /** Whole bytes remaining, floored. Advisory; nothing admits on it. */
  readonly bytesLeft: number;
}

export interface SabHistorySlot {
  readonly jobRef: SealedValue;
  readonly status: SabHistoryStatus;
  readonly marker: string | null;
  readonly category: string;
  /** The completed storage path, sealed. Revealed only by the admission service, to open it. */
  readonly storagePath: SealedValue | null;
  readonly bytes: number;
  /** True when the worker recorded a failure message. The MESSAGE itself is never carried. */
  readonly failed: boolean;
}

export interface SabVersion {
  readonly version: string;
}

export interface SabStatus {
  /** SABnzbd's own top-level state word, canonicalised. Advisory. */
  readonly state: string;
  readonly paused: boolean;
}

export interface SabSubmitAccepted {
  readonly jobRef: SealedValue;
}

export type SabResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: UsenetRefusalReason; readonly detail: string };

const fail = <T>(reason: UsenetRefusalReason, detail: string): SabResult<T> => ({ ok: false, reason, detail });
const ok = <T>(value: T): SabResult<T> => ({ ok: true, value });

// ---------------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------------

export class SabClient {
  private readonly endpoint: SabEndpoint;
  private readonly apiKey: SealedValue;
  private readonly transport: SabTransport;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly category: string;

  constructor(config: SabClientConfig) {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.transport = config.transport;
    this.timeoutMs = clampTimeout(config.timeoutMs);
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
    this.category = config.category ?? USENET_DEDICATED_CATEGORY;
  }

  /** What this client is, for a diagnostic line. No host, no port, no key. */
  describe(): { readonly worker: 'SABnzbd'; readonly keyFingerprint: string; readonly category: string } {
    return { worker: 'SABnzbd', keyFingerprint: this.apiKey.fingerprint(), category: this.category };
  }

  async version(): Promise<SabResult<SabVersion>> {
    const response = await this.send('version', 'GET', {});
    if (!response.ok) return response;
    const body = response.value;
    const version = isRecord(body) ? body['version'] : undefined;
    if (typeof version !== 'string' || version.length === 0 || version.length > 64) {
      return fail('worker-response-malformed', 'the worker did not report a version');
    }
    return ok({ version });
  }

  async status(): Promise<SabResult<SabStatus>> {
    const response = await this.send('status', 'GET', {});
    if (!response.ok) return response;
    const body = response.value;
    const status = isRecord(body) ? body['status'] : undefined;
    if (!isRecord(status)) return fail('worker-response-malformed', 'the worker did not report a status document');
    const state = status['status'];
    const paused = status['paused'];
    if (typeof state !== 'string' || state.length > 64) {
      return fail('worker-response-malformed', 'the worker status carries no state word');
    }
    return ok({ state: canonicalSabStatus(state), paused: paused === true });
  }

  async queue(): Promise<SabResult<readonly SabQueueSlot[]>> {
    const response = await this.send('queue', 'GET', { limit: String(SAB_CLIENT_BOUNDS.MAX_SLOTS) });
    if (!response.ok) return response;
    const queue = isRecord(response.value) ? response.value['queue'] : undefined;
    if (!isRecord(queue)) return fail('worker-response-malformed', 'the worker did not report a queue document');
    const slots = queue['slots'];
    if (!Array.isArray(slots)) return fail('worker-response-malformed', 'the queue document carries no slot list');
    if (slots.length > SAB_CLIENT_BOUNDS.MAX_SLOTS) {
      return fail('worker-response-too-large', 'the queue reports more slots than one reading is bounded to');
    }
    // A TRUNCATED QUEUE IS REFUSED, NOT SHORTENED. `admission.ts` treats absence from the queue as part of
    // the evidence that a job is not in flight, so a reading that silently dropped the tail would be a
    // reading whose absences are not absences. SABnzbd states the true count in `noofslots`; when it says
    // more than it sent, this reading is incomplete and says so.
    const queueTotal = wholeCount(queue['noofslots']);
    if (queueTotal !== null && queueTotal > slots.length) {
      return fail('worker-response-too-large',
        'the worker holds more queued jobs than one bounded reading returned, so absence from this reading '
        + 'would not be absence from the queue');
    }

    const parsed: SabQueueSlot[] = [];
    for (const raw of slots) {
      if (!isRecord(raw)) return fail('worker-response-malformed', 'a queue slot is not an object');
      const jobRef = readJobRef(raw['nzo_id']);
      if (jobRef === null) return fail('worker-response-malformed', 'a queue slot carries no job reference');
      const status = canonicalSabStatus(String(raw['status'] ?? ''));
      // AN UNRECOGNISED STATE IS A REFUSAL OF THE WHOLE READING. Skipping the slot would leave a job the
      // control plane cannot see in a queue it believes it has read completely — which is the shape of
      // "it is not in the queue, so it must be done".
      if (!isSabQueueStatus(status)) {
        return fail('worker-state-unrecognised', 'the worker reported a queue state this contract does not define');
      }
      parsed.push({
        jobRef,
        status,
        marker: readMarker(raw['filename'] ?? raw['nzbname']),
        category: readCategory(raw['cat']),
        bytesLeft: readMegabytesAsBytes(raw['mbleft']),
      });
    }
    return ok(parsed);
  }

  /**
   * The WHOLE history of the dedicated category, walked page by page, or a refusal.
   *
   * THIS METHOD'S COMPLETENESS IS A SAFETY PROPERTY, NOT A CONVENIENCE. `admission.ts` reads "absent from the
   * queue and absent from the history" as proof that a submission never reached the worker, and the action it
   * takes on that proof — recording the reservation as LOST — is the single state in which the same source may
   * be submitted a second time. A one-page reading makes that proof false for any operator whose dedicated
   * category holds more than one page of completed jobs, and the failure is silent and expensive: a second
   * download of the same bytes on somebody's metered account.
   *
   * SO EVERY ANSWER THIS METHOD RETURNS SUCCESSFULLY IS COMPLETE BY CONSTRUCTION. It pages until the worker
   * returns a short page, and every other outcome — too many pages, too many slots, a worker that hands back
   * the same page for a different offset — is a named REFUSAL. A refusal costs a reconciliation cycle; a
   * partial reading costs a duplicate download.
   */
  async history(): Promise<SabResult<readonly SabHistorySlot[]>> {
    const limit = SAB_CLIENT_BOUNDS.HISTORY_PAGE_LIMIT;
    const parsed: SabHistorySlot[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < SAB_CLIENT_BOUNDS.MAX_HISTORY_PAGES; page += 1) {
      const response = await this.send('history', 'GET', {
        start: String(page * limit),
        limit: String(limit),
        category: this.category,
      });
      if (!response.ok) return response;
      const history = isRecord(response.value) ? response.value['history'] : undefined;
      if (!isRecord(history)) return fail('worker-response-malformed', 'the worker did not report a history document');
      const slots = history['slots'];
      if (!Array.isArray(slots)) return fail('worker-response-malformed', 'the history document carries no slot list');
      if (slots.length > limit) {
        return fail('worker-response-too-large', 'the worker returned more history slots than the page it was asked for');
      }

      let added = 0;
      for (const raw of slots) {
        if (!isRecord(raw)) return fail('worker-response-malformed', 'a history slot is not an object');
        const jobRef = readJobRef(raw['nzo_id']);
        if (jobRef === null) return fail('worker-response-malformed', 'a history slot carries no job reference');
        const status = canonicalSabStatus(String(raw['status'] ?? ''));
        if (!isSabHistoryStatus(status)) {
          return fail('worker-state-unrecognised', 'the worker reported a history state this contract does not define');
        }
        // THE FINGERPRINT, NOT THE REFERENCE. Two pages that overlap are de-duplicated without the worker's
        // own job id ever being compared as a bare string.
        const identity = jobRef.fingerprint();
        if (seen.has(identity)) continue;
        seen.add(identity);
        added += 1;

        const storage = raw['storage'];
        const failMessage = raw['fail_message'];
        parsed.push({
          jobRef,
          status,
          marker: readMarker(raw['nzb_name'] ?? raw['name']),
          category: readCategory(raw['category']),
          // SEALED THE MOMENT IT ENTERS THE PROCESS. There is no window in which the completed path exists
          // here as a bare string that something could print.
          storagePath: typeof storage === 'string' && storage.length > 0 && storage.length <= 4096
            ? seal('completed-path', storage)
            : null,
          bytes: readWholeBytes(raw['bytes']),
          // THE MESSAGE IS READ AS A BOOLEAN AND DISCARDED. SABnzbd's failure messages quote the release name
          // and sometimes the server; carrying one would put both in every report that mentioned the job.
          failed: typeof failMessage === 'string' && failMessage.trim().length > 0,
        });
      }

      if (parsed.length > SAB_CLIENT_BOUNDS.MAX_SLOTS) {
        return fail('worker-response-too-large', 'the history holds more entries than one reading is bounded to');
      }
      // A SHORT PAGE IS THE ONLY THING THAT ENDS THIS LOOP SUCCESSFULLY, because it is the only answer that
      // means "there is no more". `noofslots`, when the worker states it, has to agree.
      if (slots.length < limit) {
        const total = wholeCount(history['noofslots']);
        if (total !== null && total > parsed.length) {
          return fail('worker-response-too-large',
            'the worker states more history entries than it returned, so absence from this reading would '
            + 'not be absence from the history');
        }
        return ok(parsed);
      }
      if (added === 0) {
        // A FULL PAGE THAT ADDED NOTHING MEANS THE WORKER IGNORED `start`. Reading on would loop over the
        // same page; returning what is in hand would call a first page the whole history.
        return fail('worker-response-malformed',
          'the worker returned the same history page for a different offset, so its history cannot be read '
          + 'completely and absence from it proves nothing');
      }
    }
    return fail('worker-response-too-large',
      'the dedicated category holds more history pages than one reading walks; nothing has been assumed about '
      + 'any job from a reading that could not be completed');
  }

  /**
   * Submit one operator-approved NZB or indexer URL.
   *
   * THE MARKER, NOT THE NAME. `nzbname` is set to the caller's opaque submission marker so that a restart can
   * find this job again by looking rather than by submitting a second one. It is checked here rather than
   * trusted: a caller that passed a release name would put content identity into the worker's own history,
   * where every later reading would carry it back.
   *
   * IT IS NEVER RETRIED. See the file header.
   */
  async submitUrl(sealedSource: SealedValue, marker: string): Promise<SabResult<SabSubmitAccepted>> {
    if (sealedSource.kind !== 'nzb-source') {
      return fail('nzb-source-not-approved', 'a submission takes a sealed NZB source and nothing else');
    }
    if (!USENET_SUBMISSION_MARKER_SHAPE.test(marker)) {
      return fail('nzb-source-not-approved', 'a submission marker is the opaque shape the contract fixes');
    }
    if (this.category !== USENET_DEDICATED_CATEGORY) {
      return fail('category-not-dedicated', 'a submission goes to the dedicated category and to no other');
    }

    const response = await this.send('submit-url', 'GET', {
      cat: this.category,
      nzbname: marker,
      priority: '-100', // SABnzbd's "default priority for the category"; never elevated by this project.
    }, sealedSource);
    if (!response.ok) return response;

    const body = response.value;
    if (!isRecord(body)) return fail('worker-response-malformed', 'the worker did not answer the submission');
    if (body['status'] !== true) {
      return fail('worker-response-malformed', 'the worker declined the submission');
    }
    const ids = body['nzo_ids'];
    if (!Array.isArray(ids) || ids.length !== 1) {
      // EXACTLY ONE, OR REFUSE. Zero means the worker accepted nothing and a second call would be a second
      // submission; more than one means the URL expanded into several jobs, and the ledger's exactly-once
      // guarantee is stated per submission, not per fan-out.
      return fail('worker-response-malformed', 'the worker did not return exactly one job reference');
    }
    const jobRef = readJobRef(ids[0]);
    if (jobRef === null) return fail('worker-response-malformed', 'the worker returned an unusable job reference');
    return ok({ jobRef });
  }

  // -------------------------------------------------------------------------------------------------------

  private async send(
    operation: SabOperation,
    method: 'GET' | 'POST',
    query: Readonly<Record<string, string>>,
    sealedSource?: SealedValue,
  ): Promise<SabResult<unknown>> {
    const request: SabTransportRequest = {
      operation,
      method,
      endpoint: this.endpoint,
      path: SAB_API_PATH,
      query: Object.freeze({ ...query, mode: SAB_OPERATION_MODES[operation], output: SAB_OUTPUT_FORMAT }),
      apiKey: this.apiKey,
      ...(sealedSource ? { sealedSource } : {}),
      timeoutMs: this.timeoutMs,
      maxResponseBytes: SAB_CLIENT_BOUNDS.MAX_RESPONSE_BYTES,
    };

    const attempts = isMutatingSabOperation(operation) ? 1 : SAB_CLIENT_BOUNDS.MAX_READ_ATTEMPTS;
    let last: SabResult<unknown> = fail('worker-unreachable', 'the worker was not contacted');

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await this.attempt(request);
      if (last.ok) return last;
      // Only a transport-shaped failure is worth repeating. A malformed document or a rejected credential
      // will be malformed and rejected again, and repeating it is noise on somebody's worker.
      if (last.reason !== 'worker-unreachable') return last;
      if (attempt < attempts) {
        const delay = Math.min(
          SAB_CLIENT_BOUNDS.RETRY_MAX_DELAY_MS,
          SAB_CLIENT_BOUNDS.RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        );
        await this.sleep(delay);
      }
    }
    return last;
  }

  private async attempt(request: SabTransportRequest): Promise<SabResult<unknown>> {
    let response: SabTransportResponse;
    try {
      response = await this.transport.request(request);
    } catch {
      // THE ERROR IS SWALLOWED RATHER THAN WRAPPED. A transport error message routinely contains the URL it
      // failed on, and that URL carries the API key. Nothing about the thrown value reaches a caller.
      return fail('worker-unreachable', 'the worker did not answer');
    }

    if (!isRecord(response) || typeof response.status !== 'number' || !Number.isInteger(response.status)) {
      return fail('worker-response-malformed', 'the transport returned no usable response');
    }
    if (typeof response.byteLength === 'number' && response.byteLength > SAB_CLIENT_BOUNDS.MAX_RESPONSE_BYTES) {
      return fail('worker-response-too-large', 'the worker answered with more bytes than one reading is bounded to');
    }
    if (response.status === 401 || response.status === 403) {
      return fail('worker-rejected-credential', 'the worker rejected the API key');
    }
    if (response.status < 200 || response.status > 299) {
      return fail('worker-unreachable', 'the worker answered with a non-success status');
    }
    if (response.body === undefined) {
      return fail('worker-response-malformed', 'the worker answered with something that is not JSON');
    }

    // SABnzbd reports an API-level error as a 200 with `{"status": false, "error": "..."}`. The error TEXT is
    // read only far enough to tell a credential rejection from everything else; it is never carried onward,
    // because SABnzbd puts the offending value into some of them.
    if (isRecord(response.body) && response.body['status'] === false) {
      const error = response.body['error'];
      const text = typeof error === 'string' ? error.toLowerCase() : '';
      if (text.includes('api key') || text.includes('apikey') || text.includes('not logged in')) {
        return fail('worker-rejected-credential', 'the worker rejected the API key');
      }
      return fail('worker-response-malformed', 'the worker answered with an error rather than a document');
    }

    return ok(response.body);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Parsing helpers. Every one of them is total: it returns a value or null, and never throws a value onward.
// ---------------------------------------------------------------------------------------------------------

export function clampTimeout(timeoutMs: number | undefined): number {
  const bounds = SAB_CLIENT_BOUNDS.TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) return bounds.default;
  return Math.min(bounds.max, Math.max(bounds.min, timeoutMs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJobRef(value: unknown): SealedValue | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  return seal('job-ref', trimmed);
}

/**
 * A submission marker, or null.
 *
 * ANYTHING THAT IS NOT OUR MARKER BECOMES NULL rather than being carried through. A job an operator started
 * for their own reasons has a release name here, and a release name is content identity; returning it would
 * put it in every status document this tranche produces.
 */
function readMarker(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // SABnzbd appends `.nzb` to the name it displays for some submissions.
  const trimmed = value.trim().replace(/\.nzb$/i, '');
  return USENET_SUBMISSION_MARKER_SHAPE.test(trimmed) ? trimmed : null;
}

/** A category, or the empty string. Bounded and stripped of anything that is not a plain label. */
function readCategory(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(trimmed) ? trimmed : '';
}

/**
 * A worker-stated total count, or null when it stated none.
 *
 * SABnzbd writes `noofslots` as a number in some versions and as a decimal string in others. Anything that is
 * not a whole non-negative count is read as "the worker did not say", which is the safe reading: the caller
 * then falls back on the page-length rule rather than trusting a number it could not parse.
 */
function wholeCount(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0) return null;
  return numeric;
}

function readWholeBytes(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(numeric));
}

function readMegabytesAsBytes(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(numeric * 1024 * 1024));
}
