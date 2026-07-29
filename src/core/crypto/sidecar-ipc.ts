import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isCanonicalIsoTimestamp } from './custodian-records.js';
import type {
  LocalSidecarCustodianRequest,
  LocalSidecarCustodianResponse,
} from './local-sidecar-custodian.js';

// Phase 281 — the custodian sidecar's IPC boundary, made a boundary.
//
// -----------------------------------------------------------------------------------------------------
// WHAT THIS CROSSES, AND WHY IT IS THE ONE PLACE THAT HAS TO BE RIGHT.
// -----------------------------------------------------------------------------------------------------
//
// The sidecar holds the material every decrypt in this product depends on, and the app holds none of it. That
// separation is the entire point of running a custodian as its own process — and it is worth exactly as much
// as the channel between them. A socket anything on the host can connect to is a custodian anything on the
// host can ask for a key.
//
// So the channel is constrained in every direction a channel can be:
//
//   * LOCAL ONLY, AND PROVED LOCAL. A Unix domain socket or a Windows named pipe. There is no TCP path in this
//     module at all — not a disabled one, not a configurable one — and a suite scans for the spelling of one.
//   * OWNER-ONLY, PARENT INCLUDED. The socket is 0600 inside a 0700 directory the daemon owns. A 0600 socket
//     in a world-writable directory is a socket somebody else can replace.
//   * A STALE SOCKET IS PROVED STALE BEFORE IT IS REMOVED. See `reclaimStaleSocket`, which is the part of this
//     file most likely to be got wrong: the obvious `if (exists) unlink()` deletes whatever is at that name,
//     including a file an operator put there and including a LIVE socket another daemon is serving.
//   * BOUNDED IN BYTES, IN TIME AND IN NUMBER. A request is capped, a connection is capped, an idle connection
//     is closed, and only so many may be open at once. None of those is a performance choice: each is a way a
//     local process could otherwise hold the custodian open or make it allocate.
//   * ONE REQUEST PER CONNECTION. A connection carries one line, gets one answer and is closed. There is no
//     session to confuse, no second request to smuggle behind the first, and no state on the wire.
//   * CLOSED ERRORS. Every failure is one of a short list of codes. A message from a custodian, a filesystem
//     or a runtime is never repeated onto the wire — those routinely carry a path, and a path is a fact about
//     the host that the app has no business learning from the process that holds the keys.

/** The wire contract's version. A client that does not recognise it must fail closed, not guess. */
export const SIDECAR_PROTOCOL_VERSION = 1;

/**
 * How large one request line may be.
 *
 * Generous for the largest legitimate request (a provision carrying two ids) and far below anything that
 * could matter to this process. The bound is applied to the BYTES ACCUMULATED, not to a parsed value, so a
 * peer that never sends a newline is cut off rather than buffered forever.
 */
export const SIDECAR_MAX_REQUEST_BYTES = 64 * 1024;

/**
 * How large one response may be.
 *
 * `listStaleProvisioning` is the only unbounded-in-principle answer, and it is bounded here rather than
 * trusted to stay small: a keystore with a great many interrupted provisions must not turn a status call into
 * an allocation the client cannot refuse.
 */
export const SIDECAR_MAX_RESPONSE_BYTES = 1024 * 1024;

/** How long one connection may live, and how long it may sit idle inside that. */
export const SIDECAR_CONNECTION_TIMEOUT_MS = 15_000;
export const SIDECAR_IDLE_TIMEOUT_MS = 5_000;

/**
 * How many connections may be in flight at once.
 *
 * The custodian is single-writer by construction, so this is not a throughput knob: it is the number of
 * sockets a local process can hold open before the daemon starts refusing, which is what stops one from
 * pinning the descriptor table of the process that holds the keys.
 */
export const SIDECAR_MAX_CONCURRENT_CONNECTIONS = 32;

/** How long a client waits for the health handshake before it concludes the sidecar is not ready. */
export const SIDECAR_HEALTH_TIMEOUT_MS = 2_000;

/**
 * An identifier this protocol will carry.
 *
 * NARROW ON PURPOSE. Every id crossing this boundary becomes part of a filename (hashed), an AAD, or an
 * attestation line — and an attestation is an HMAC over newline-separated fields. A charset with no newline,
 * no NUL and no separator is what makes "the attestation cannot be forged by choosing an id" a property of
 * the shape rather than of a downstream check.
 */
export const SIDECAR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** An epoch is a whole number a schema can hold. Not a float, not negative, not enormous. */
export const SIDECAR_MAX_EPOCH = 2 ** 31 - 1;

/**
 * Every way this boundary can say no. A CLOSED SET.
 *
 * A code names a RULE. It never names a path, a key, an id, a filesystem error or a custodian message — all
 * of which the previous version could leak through the one branch that echoed whatever went wrong.
 */
export type SidecarErrorCode =
  | 'SIDECAR_PROTOCOL_MALFORMED'
  | 'SIDECAR_REQUEST_TOO_LARGE'
  | 'SIDECAR_RESPONSE_TOO_LARGE'
  | 'SIDECAR_REQUEST_FAILED'
  | 'SIDECAR_BUSY'
  | 'SIDECAR_TIMEOUT'
  | 'SIDECAR_NOT_READY';

/** The health handshake's answer. Facts about readiness, and nothing about what is inside. */
export interface SidecarHealth {
  readonly op: 'health';
  readonly protocol: typeof SIDECAR_PROTOCOL_VERSION;
  /** True only when the custodian behind this socket was actually exercised, not merely constructed. */
  readonly ready: boolean;
  /** A closed word for what is serving. Never a path, never a version string read off disk. */
  readonly custodian: 'file-reference-harness' | 'sidecar-managed-ring';
  /** Which KEK generation is active, or `null` where the deployment has no ring. A number, never a key. */
  readonly ringGeneration: number | null;
  /**
   * When that generation was created, so a scheduled doctor can say whether a rotation is due.
   *
   * A TIMESTAMP IS THE ONLY THING THAT CROSSES. The doctor runs inside the APP, which by design cannot read
   * the root wrapping key or open the ring — so the one process that CAN reads it and answers with a number.
   * `null` on a deployment with no ring, which is an honest answer and not a zero.
   */
  readonly ringActiveCreatedAt: number | null;
}

export type SidecarRequest = LocalSidecarCustodianRequest | { readonly op: 'health' };

export type SidecarParse =
  | { readonly ok: true; readonly request: SidecarRequest }
  | { readonly ok: false; readonly code: SidecarErrorCode };

/**
 * Parse one request line, strictly.
 *
 * EVERY FIELD IS CHECKED AND EVERY EXTRA FIELD IS REFUSED. The previous version checked that the fields it
 * used were present and of the right primitive type, and ignored anything else on the object — so a request
 * could carry arbitrary additional keys, an id could be any string of any length containing anything, and an
 * epoch could be a float or a negative. None of those was exploitable today; all of them are the kind of
 * latitude a boundary should not have, because the next reader of a field is not this function.
 */
export function parseSidecarRequest(line: string): SidecarParse {
  if (Buffer.byteLength(line, 'utf8') > SIDECAR_MAX_REQUEST_BYTES) {
    return { ok: false, code: 'SIDECAR_REQUEST_TOO_LARGE' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  }
  const doc = parsed as Record<string, unknown>;
  // THE OPERATION IS A STRING, CHECKED BEFORE IT IS LOOKED UP.
  //
  // THE DEFECT THIS CLOSES. The lookup was `REQUEST_SHAPES[String(doc.op)]`, and `String(['get'])` is `'get'`.
  // So `{"op":["get"],"keyId":"k","epoch":0}` found the `get` shape, passed every field check, and was
  // returned as a request whose `op` was an ARRAY. The dispatcher's `switch` then matched no case and fell
  // out returning `undefined`, which was written to the wire as a SUCCESS with no response — and the client,
  // seeing `ok: true`, resolved `undefined` and threw a raw TypeError inside the app. One coercion, and a
  // hostile line turned into an unhandled error on the other side of the boundary.
  if (typeof doc.op !== 'string') return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  const shape = REQUEST_SHAPES[doc.op];
  if (shape === undefined) return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  // NO KEY THIS SHAPE DOES NOT DECLARE. An unexpected field is a request built by something that does not
  // know this contract, and this refuses one rather than serving the part it recognises.
  const declared = new Set(['op', ...shape]);
  for (const key of Object.keys(doc)) {
    if (!declared.has(key)) return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  }
  for (const field of shape) {
    const value = doc[field];
    const acceptable = field === 'epoch' ? isEpoch(value) : isIdentifier(value);
    if (!acceptable) return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  }
  return { ok: true, request: doc as unknown as SidecarRequest };
}

/** Which fields each operation carries, and nothing else. The whole schema, as data. */
const REQUEST_SHAPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  provision: ['operationId', 'itemId', 'epoch'],
  commitProvision: ['operationId'],
  get: ['keyId', 'epoch'],
  destroy: ['operationId', 'keyId'],
  status: ['keyId'],
  listStaleProvisioning: [],
  health: [],
});

/** Every operation this boundary carries, and NOTHING ELSE. Read and write key custody; no administration. */
export const SIDECAR_OPERATIONS: readonly string[] = Object.freeze(Object.keys(REQUEST_SHAPES).sort());

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SIDECAR_ID_PATTERN.test(value);
}

export function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SIDECAR_MAX_EPOCH;
}

// -----------------------------------------------------------------------------------------------------------
// The RESPONSE contract — the half of this boundary that was never parsed
// -----------------------------------------------------------------------------------------------------------
//
// WHAT WAS MISSING, AND WHY IT IS THE SAME PROBLEM IN THE OTHER DIRECTION. Requests were checked field by
// field; answers were `JSON.parse(...) as WireResponse` followed by `if (parsed.ok !== true) fail` and then
// `resolve(parsed.response)` — an unvalidated object handed to the app. The per-operation client methods
// checked the fields they used and no more, so:
//
//   * A SUCCESS AND AN ERROR COULD BE THE SAME MESSAGE. `{"ok":true,"code":"SIDECAR_BUSY","response":{...}}`
//     read as a success by the client and as a refusal by anything reading the code. A frame that is both is
//     a frame whose meaning depends on which field the reader looks at first.
//   * AN ANSWER DID NOT HAVE TO BE ABOUT THE QUESTION beyond its `op` field, and could carry any number of
//     fields nothing declared.
//   * A SECOND MESSAGE COULD FOLLOW THE FIRST on a connection whose whole contract is one answer.
//
// A peer on this socket is not trusted in either direction — the app must survive a hostile or malfunctioning
// custodian exactly as the custodian survives a hostile app — so the answer is parsed with the same closed,
// operation-specific schemas the requests get, and a frame that fails any of them is a refusal carrying a
// CODE and never a fragment of what the peer sent.

/** Every way this boundary can say no, as a closed set a reader can check a peer's word against. */
export const SIDECAR_ERROR_CODES: readonly SidecarErrorCode[] = Object.freeze([
  'SIDECAR_PROTOCOL_MALFORMED',
  'SIDECAR_REQUEST_TOO_LARGE',
  'SIDECAR_RESPONSE_TOO_LARGE',
  'SIDECAR_REQUEST_FAILED',
  'SIDECAR_BUSY',
  'SIDECAR_TIMEOUT',
  'SIDECAR_NOT_READY',
]);

export function isSidecarErrorCode(value: unknown): value is SidecarErrorCode {
  return typeof value === 'string' && (SIDECAR_ERROR_CODES as readonly string[]).includes(value);
}

/** How many stale-provisioning entries one answer may carry. A bound, not a page size. */
export const SIDECAR_MAX_STALE_ENTRIES = 10_000;

/** How long any free-text field in an answer may be. Ids, receipt ids and timestamps are all far shorter. */
export const SIDECAR_MAX_TEXT_LENGTH = 512;

export type SidecarWireParse =
  | { readonly ok: true; readonly response: Record<string, unknown> }
  | { readonly ok: false; readonly code: SidecarErrorCode };

/**
 * The ENVELOPE of one answer: a success carrying a response, or a refusal carrying a code. Never both.
 *
 * The keys are exact in each case, so a frame cannot be a success by one field and a refusal by another, and
 * a peer cannot smuggle anything past this by adding fields to a shape that is otherwise valid.
 */
export function parseSidecarWireResponse(line: string): SidecarWireParse {
  if (Buffer.byteLength(line, 'utf8') > SIDECAR_MAX_RESPONSE_BYTES) {
    return { ok: false, code: 'SIDECAR_RESPONSE_TOO_LARGE' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  }
  const doc = parsed as Record<string, unknown>;
  const keys = Object.keys(doc).sort();
  if (doc.ok === true) {
    if (keys.length !== 2 || keys[0] !== 'ok' || keys[1] !== 'response') {
      return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
    }
    const response = doc.response;
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
    }
    return { ok: true, response: response as Record<string, unknown> };
  }
  if (doc.ok !== false) return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  if (keys.length !== 3 || keys[0] !== 'code' || keys[1] !== 'ok' || keys[2] !== 'op') {
    return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  }
  // THE OPERATION IT REFUSED IS A CLOSED WORD TOO. `unknown` is the one the daemon uses before it has parsed
  // a request; anything outside that set is a peer describing an operation this boundary does not carry.
  if (typeof doc.op !== 'string' || (doc.op !== 'unknown' && !SIDECAR_OPERATIONS.includes(doc.op))) {
    return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  }
  // AND A CODE THIS BUILD DEFINES. A peer's own invented code is not a code — it is text, and text from a
  // peer never becomes this process's diagnostic.
  if (!isSidecarErrorCode(doc.code)) return { ok: false, code: 'SIDECAR_PROTOCOL_MALFORMED' };
  return { ok: false, code: doc.code };
}

/**
 * The PAYLOAD of one answer, checked against the operation that was asked.
 *
 * Returns the response or `null`. `null` is the only failure: nothing from the peer is carried out of here,
 * because everything in this object came from the other side of the boundary — including, in the worst case,
 * a path or a stack trace from a process that is not this product's sidecar at all.
 */
export function parseSidecarResponse(op: string, value: unknown): SidecarResponse | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (doc.op !== op) return null;
  switch (op) {
    case 'provision':
      if (!exactly(doc, ['op', 'keyId', 'dekBase64'])) return null;
      if (!isIdentifier(doc.keyId) || !isWrappedDekBase64(doc.dekBase64)) return null;
      return doc as unknown as SidecarResponse;
    case 'commitProvision':
      if (!exactly(doc, ['op', 'ok'])) return null;
      if (doc.ok !== true) return null;
      return doc as unknown as SidecarResponse;
    case 'get':
      if (!exactly(doc, ['op', 'dekBase64'])) return null;
      if (!isWrappedDekBase64(doc.dekBase64)) return null;
      return doc as unknown as SidecarResponse;
    case 'destroy': {
      if (!exactly(doc, ['op', 'receipt'])) return null;
      const receipt = doc.receipt;
      if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
      const fields = receipt as Record<string, unknown>;
      if (!exactly(fields, ['keyId', 'receiptId', 'destroyedAt', 'attestation'])) return null;
      if (!isIdentifier(fields.keyId) || !isIdentifier(fields.receiptId)) return null;
      // THE TIMESTAMP IS ATTESTATION INPUT, NOT PROSE. The receipt is an HMAC over the key id, the receipt id
      // and this field, joined by newlines — so "any text with no control character in it" let a peer answer
      // with `destroyedAt: "recently"` and sign it. One instant format, round-tripped through `Date`.
      if (!isCanonicalIsoTimestamp(fields.destroyedAt) || !isAttestation(fields.attestation)) return null;
      return doc as unknown as SidecarResponse;
    }
    case 'status':
      if (!exactly(doc, ['op', 'status'])) return null;
      if (doc.status !== 'provisional' && doc.status !== 'active'
        && doc.status !== 'destroyed' && doc.status !== 'not_found') return null;
      return doc as unknown as SidecarResponse;
    case 'listStaleProvisioning': {
      if (!exactly(doc, ['op', 'stale'])) return null;
      const stale = doc.stale;
      if (!Array.isArray(stale) || stale.length > SIDECAR_MAX_STALE_ENTRIES) return null;
      for (const entry of stale) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const fields = entry as Record<string, unknown>;
        if (!exactly(fields, ['operationId', 'itemId', 'keyId', 'ageMs'])) return null;
        // THE KEY ID IS THIS CUSTODIAN'S OWN MINTED SHAPE; the operation and item ids came from the app and
        // are held to the wider rule the keystore itself enforces — text with no control character in it.
        // Narrowing those here would make an answer about a legitimately-named item into a refusal, which is
        // a different bug from the one this check exists to prevent.
        if (!isIdentifier(fields.keyId) || !isWireText(fields.operationId) || !isWireText(fields.itemId)) return null;
        // A DURATION IN WHOLE MILLISECONDS, INSIDE EXACT ARITHMETIC. `isFinite` admitted `1.5` and
        // `1e21` — a float age is a peer inventing precision this custodian does not measure, and a number
        // past `MAX_SAFE_INTEGER` is one whose comparisons stop meaning anything.
        if (typeof fields.ageMs !== 'number' || !Number.isSafeInteger(fields.ageMs) || fields.ageMs < 0) return null;
      }
      return doc as unknown as SidecarResponse;
    }
    case 'health':
      return validateSidecarHealth(doc);
    default:
      return null;
  }
}

/** What a validated answer is: a custodian response, or the health handshake. */
export type SidecarResponse = LocalSidecarCustodianResponse | SidecarHealth;

/**
 * A health answer this build will act on, or `null`.
 *
 * EVERY FIELD, AND NO FIELD THIS BUILD DOES NOT DECLARE. `ringGeneration` and `ringActiveCreatedAt` are
 * either both absent (a deployment with no ring) or both present and positive; a zero timestamp is refused
 * rather than read as "the epoch", which the age check would call overdue by five decades.
 */
export function validateSidecarHealth(answer: unknown): SidecarHealth | null {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const doc = answer as Record<string, unknown>;
  if (!exactly(doc, ['op', 'protocol', 'ready', 'custodian', 'ringGeneration', 'ringActiveCreatedAt'])) return null;
  if (doc.op !== 'health' || doc.protocol !== SIDECAR_PROTOCOL_VERSION || doc.ready !== true) return null;
  if (doc.custodian !== 'file-reference-harness' && doc.custodian !== 'sidecar-managed-ring') return null;
  const generation = doc.ringGeneration;
  const createdAt = doc.ringActiveCreatedAt;
  const hasRing = generation !== null;
  if (hasRing) {
    if (!Number.isInteger(generation) || (generation as number) < 1) return null;
    if (!Number.isInteger(createdAt) || (createdAt as number) < 1) return null;
  } else if (createdAt !== null) {
    // A deployment with no ring has no active generation to date. A timestamp beside a null generation is a
    // contradiction, and a contradiction is not something to pick the agreeable half of.
    return null;
  }
  return doc as unknown as SidecarHealth;
}

/** These keys, all of them, and nothing else. */
function exactly(doc: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(doc);
  if (keys.length !== fields.length) return false;
  for (const field of fields) if (!Object.prototype.hasOwnProperty.call(doc, field)) return false;
  return true;
}

/** A 32-byte DEK, base64, in the one encoding of it that round-trips. Never logged, never reflected. */
function isWrappedDekBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 44) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

/** Text this boundary will carry: bounded, and with no control character to smuggle into a line-based record. */
function isWireText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SIDECAR_MAX_TEXT_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** An attestation is an HMAC-SHA256, hex. Exactly that shape, so a peer cannot answer with prose. */
function isAttestation(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

// -----------------------------------------------------------------------------------------------------------
// The socket path, and the thing at it
// -----------------------------------------------------------------------------------------------------------

/** A NUL, as a VALUE. The repository refuses a literal control byte in source, and rightly: one survives
 * being copied between files and is invisible in a diff. */
const NUL = String.fromCharCode(0);

export class SidecarSocketError extends Error {
  readonly code = 'SIDECAR_SOCKET_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'SidecarSocketError';
  }
}

/**
 * A socket path this product will serve on or connect to.
 *
 * LOCAL IPC, AND NOTHING THAT COULD BE READ AS AN ADDRESS. A scheme, an address with a port, or a bare relative name is
 * refused. The Windows branch requires a named pipe; the POSIX branch requires an absolute path.
 */
export function assertLocalSocketPath(socketPath: string): void {
  if (typeof socketPath !== 'string' || socketPath.trim().length === 0) {
    throw new SidecarSocketError('sidecar socket path is required');
  }
  if (socketPath.includes(NUL)) throw new SidecarSocketError('sidecar socket path is not a usable path');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(socketPath) || /^[^/\\]+:\d+$/.test(socketPath)) {
    throw new SidecarSocketError('sidecar socket path must be local IPC, not a network endpoint');
  }
  if (process.platform === 'win32') {
    if (!socketPath.startsWith('\\\\.\\pipe\\')) {
      throw new SidecarSocketError('Windows sidecar socket path must be a named pipe');
    }
    return;
  }
  if (!socketPath.startsWith('/')) throw new SidecarSocketError('Unix sidecar socket path must be absolute');
}

/** The user this process is. `null` where the platform does not have the concept. */
function currentUid(): number | null {
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  return typeof getuid === 'function' ? getuid.call(process) : null;
}

/**
 * Make the socket's parent directory one only this user can reach, and prove it is.
 *
 * THE MODE ON THE SOCKET IS NOT ENOUGH. A 0600 socket inside a directory anybody may write to is a socket
 * anybody may unlink and replace with their own — after which the app connects to THEIR custodian and hands
 * it every key request. The directory is therefore created 0700, chmod'ed 0700 in case it already existed,
 * and then re-inspected: owned by this user, not a symbolic link, and no group or other bits.
 */
export function prepareSocketDirectory(socketPath: string): string {
  if (process.platform === 'win32') return ''; // a named pipe has no parent directory to own
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(parent, fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0));
  } catch {
    throw new SidecarSocketError('the sidecar socket directory could not be opened without following a link');
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isDirectory()) throw new SidecarSocketError('the sidecar socket directory is not a directory');
    const uid = currentUid();
    if (uid !== null && stats.uid !== uid) {
      throw new SidecarSocketError('the sidecar socket directory belongs to another user');
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new SidecarSocketError('the sidecar socket directory is readable or writable by somebody else');
    }
  } finally {
    try { closeSync(fd); } catch { /* the checks above are the outcome */ }
  }
  return parent;
}

export type StaleSocketOutcome = 'nothing-there' | 'reclaimed';

/**
 * Remove a socket left by a previous run of THIS daemon, or refuse — and never remove anything else.
 *
 * THE DEFECT THIS CLOSES. The first version was `if (existsSync(path)) unlinkSync(path)`. Three separate
 * problems, all of them silent:
 *
 *   1. IT DELETED WHATEVER WAS AT THAT NAME. A regular file, a directory entry an operator created, a
 *      misconfiguration pointing at something real — all unlinked without being looked at. A daemon that
 *      removes an arbitrary object because it wants the name is a daemon that can be aimed.
 *   2. IT FOLLOWED A LINK. `existsSync` follows; `unlink` does not — so a symbolic link at that name was
 *      reported as "there" by a check that resolved it and then removed by an operation that did not. The
 *      combination is confused rather than dangerous, and a confused check is not a check.
 *   3. IT DID NOT ASK WHETHER SOMETHING WAS SERVING. A socket a LIVE daemon is listening on looks exactly
 *      like one a dead daemon left behind. Removing it takes over the name and leaves the other process
 *      serving a socket nobody can reach — which, for a custodian, is an outage with a running process
 *      behind it that no health check would explain.
 *
 * So: `lstat` (never following), refuse anything that is not a socket, refuse one owned by another user, ask
 * whether anything answers on it, and only then unlink. `probe` is injected so a suite can set up "a live
 * daemon is already there" without racing a real one.
 */
export function reclaimStaleSocket(
  socketPath: string,
  probe: (path: string) => boolean,
  unlink: (path: string) => void,
): StaleSocketOutcome {
  if (process.platform === 'win32') return 'nothing-there'; // a named pipe leaves no filesystem object
  let stats;
  try {
    stats = lstatSync(socketPath);
  } catch {
    return 'nothing-there';
  }
  if (stats.isSymbolicLink()) {
    throw new SidecarSocketError(
      'the sidecar socket path is a symbolic link. This daemon will not remove one, and will not serve '
      + 'through one: where the socket actually is cannot be established from the name.');
  }
  if (!stats.isSocket()) {
    throw new SidecarSocketError(
      'something that is not a socket is already at the sidecar socket path. This daemon removes only a socket '
      + 'its own kind of process left behind; it will not delete an object it cannot account for.');
  }
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) {
    throw new SidecarSocketError('the socket at the sidecar socket path belongs to another user');
  }
  if (probe(socketPath)) {
    throw new SidecarSocketError(
      'another custodian sidecar is already serving on this socket. Two daemons over one keystore is two '
      + 'writers, and taking the name from the live one would leave it running and unreachable.');
  }
  unlink(socketPath);
  return 'reclaimed';
}

/** The socket file itself, once it exists: owned by this user, and reachable by nobody else. */
export function assertSocketIsOwnerOnly(socketPath: string): void {
  if (process.platform === 'win32') return;
  const stats = statSync(socketPath);
  if (!stats.isSocket()) throw new SidecarSocketError('the sidecar socket is not a socket');
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) throw new SidecarSocketError('the sidecar socket belongs to another user');
  if ((stats.mode & 0o077) !== 0) {
    throw new SidecarSocketError('the sidecar socket is reachable by somebody other than its owner');
  }
}
