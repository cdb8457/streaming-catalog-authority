import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LocalSidecarCustodianRequest } from './local-sidecar-custodian.js';

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
  const shape = REQUEST_SHAPES[String(doc.op)];
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

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SIDECAR_ID_PATTERN.test(value);
}

export function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SIDECAR_MAX_EPOCH;
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
