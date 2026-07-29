import { chmodSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import {
  CustodianTransportError,
  type KeyCustodian,
} from './custodian.js';
import {
  dispatchLocalSidecarCustodianRequest,
  type LocalSidecarCustodianRequest,
  type LocalSidecarCustodianResponse,
  type LocalSidecarCustodianTransport,
} from './local-sidecar-custodian.js';
import {
  SIDECAR_CONNECTION_TIMEOUT_MS,
  SIDECAR_HEALTH_TIMEOUT_MS,
  SIDECAR_IDLE_TIMEOUT_MS,
  SIDECAR_MAX_CONCURRENT_CONNECTIONS,
  SIDECAR_MAX_REQUEST_BYTES,
  SIDECAR_MAX_RESPONSE_BYTES,
  SIDECAR_PROTOCOL_VERSION,
  SidecarSocketError,
  assertLocalSocketPath,
  assertSocketIsOwnerOnly,
  parseSidecarRequest,
  parseSidecarResponse,
  parseSidecarWireResponse,
  prepareSocketDirectory,
  reclaimStaleSocket,
  validateSidecarHealth,
  type SidecarErrorCode,
  type SidecarHealth,
  type SidecarResponse,
} from './sidecar-ipc.js';

// Phase 281 — the custodian sidecar's runtime, hardened.
//
// Everything about WHY these limits exist is in `sidecar-ipc.ts`; this file is the server and the client that
// obey them. Two properties are worth stating where they are implemented rather than where they are declared:
//
//   ONE REQUEST PER CONNECTION, ENFORCED BY CLOSING. The first newline ends the request. Anything after it on
//   the same connection is not a second request to be queued — it is a peer that has misunderstood the
//   contract, and the connection is answered once and destroyed. The previous version left the socket open,
//   read every subsequent chunk into the same buffer, and could dispatch again from data that arrived while
//   the first call was still running.
//
//   THE HEALTH HANDSHAKE ACTUALLY EXERCISES THE CUSTODIAN. It is answered by a probe the daemon supplies,
//   not by the fact that a server object exists. "The socket is there" was never evidence that the process
//   behind it could reach its keystore — which is exactly the state an app must not start into, because a
//   custodian that answers nothing and a custodian that answers "destroyed" are indistinguishable to a
//   fail-closed reader.

export { assertLocalSocketPath, SidecarSocketError, validateSidecarHealth } from './sidecar-ipc.js';

export interface LocalSidecarRuntimeOptions {
  readonly socketPath: string;
  readonly custodian: KeyCustodian;
  /**
   * What "ready" means for this deployment, exercised on every health request.
   *
   * Injected rather than inferred: only the daemon knows whether its ring is loaded and its state directory
   * is readable, and a health answer this module invented would be a health answer nobody checked.
   */
  readonly health?: () => Promise<SidecarHealth> | SidecarHealth;
  /** Injected so a suite can set up "a live daemon already holds this socket" without racing one. */
  readonly probeExistingSocket?: (path: string) => boolean;
}

export interface LocalSidecarRuntimeHandle {
  readonly socketPath: string;
  /** How many connections were refused because the concurrency bound was reached. Evidence, not a counter. */
  readonly refused: () => number;
  close(): Promise<void>;
}

type WireResponse =
  | { readonly ok: true; readonly response: LocalSidecarCustodianResponse | SidecarHealth }
  | { readonly ok: false; readonly op: string; readonly code: SidecarErrorCode };

export async function startLocalSidecarRuntime(options: LocalSidecarRuntimeOptions): Promise<LocalSidecarRuntimeHandle> {
  assertLocalSocketPath(options.socketPath);
  prepareSocketDirectory(options.socketPath);
  reclaimStaleSocket(
    options.socketPath,
    options.probeExistingSocket ?? probeSocketIsAlive,
    (path) => unlinkSync(path),
  );

  let open = 0;
  let refused = 0;
  const live = new Set<Socket>();

  const server = createServer((socket) => {
    live.add(socket);
    socket.once('close', () => { live.delete(socket); open -= 1; });
    open += 1;
    // BOUNDED IN NUMBER, BEFORE ANYTHING IS READ. A refused connection is answered with a code so a client
    // fails closed and distinguishably, rather than seeing a bare disconnect it might retry forever.
    if (open > SIDECAR_MAX_CONCURRENT_CONNECTIONS) {
      refused += 1;
      writeResponse(socket, { ok: false, op: 'unknown', code: 'SIDECAR_BUSY' });
      return;
    }
    serveOneRequest(socket, options);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    // THE PATH, NEVER A PORT. `listen` is called with a string, so there is no overload here that could bind a
    // TCP address even by mistake — and a suite scans this file for the spelling of one.
    server.listen(options.socketPath);
  });

  if (process.platform !== 'win32') {
    chmodSync(options.socketPath, 0o600);
    assertSocketIsOwnerOnly(options.socketPath);
  }

  return {
    socketPath: options.socketPath,
    refused: () => refused,
    async close(): Promise<void> {
      for (const socket of [...live]) socket.destroy();
      await closeServer(server);
      // ONLY OURS, AND ONLY IF IT IS STILL A SOCKET. The same rule as the reclaim: this never unlinks an
      // object it has not just proved is the one it created.
      if (process.platform !== 'win32') {
        try {
          assertSocketIsOwnerOnly(options.socketPath);
          unlinkSync(options.socketPath);
        } catch { /* somebody else's now, or already gone: either way this does not remove it */ }
      }
    },
  };
}

/**
 * Read exactly one line, answer it, and close.
 *
 * The timers are set before the first byte is read, so a peer that connects and says nothing is closed by the
 * idle timeout rather than held. The total timeout covers a peer that dribbles bytes forever under the idle
 * bound; neither alone is sufficient.
 */
function serveOneRequest(socket: Socket, options: LocalSidecarRuntimeOptions): void {
  let buffered = '';
  let answered = false;
  socket.setEncoding('utf8');

  const total = setTimeout(() => {
    if (!answered) { answered = true; writeResponse(socket, { ok: false, op: 'unknown', code: 'SIDECAR_TIMEOUT' }); }
  }, SIDECAR_CONNECTION_TIMEOUT_MS);
  total.unref?.();
  socket.setTimeout(SIDECAR_IDLE_TIMEOUT_MS, () => {
    if (!answered) { answered = true; writeResponse(socket, { ok: false, op: 'unknown', code: 'SIDECAR_TIMEOUT' }); }
  });
  socket.once('close', () => clearTimeout(total));
  socket.on('error', () => { answered = true; clearTimeout(total); socket.destroy(); });

  socket.on('data', (chunk: string) => {
    if (answered) return;
    buffered += chunk;
    if (Buffer.byteLength(buffered, 'utf8') > SIDECAR_MAX_REQUEST_BYTES) {
      answered = true;
      writeResponse(socket, { ok: false, op: 'unknown', code: 'SIDECAR_REQUEST_TOO_LARGE' });
      return;
    }
    const newline = buffered.indexOf('\n');
    if (newline === -1) return;
    answered = true;
    // ONE REQUEST. Whatever follows the newline is discarded with the connection.
    const line = buffered.slice(0, newline);
    socket.pause();
    void handleLine(options, line, socket).finally(() => clearTimeout(total));
  });
}

export class UnixSocketSidecarTransport implements LocalSidecarCustodianTransport {
  constructor(private readonly socketPath: string, private readonly timeoutMs = SIDECAR_CONNECTION_TIMEOUT_MS) {
    assertLocalSocketPath(socketPath);
  }

  /**
   * ANSWERED, AND THE ANSWER IS ABOUT THE QUESTION.
   *
   * This used to be a cast: `dispatchOnce(...).then((r) => r as LocalSidecarCustodianResponse)`. Whatever the
   * peer put inside a frame that said `ok: true` became the return value of a custodian call, and the only
   * things standing between that and the app were the field checks the client happened to make afterwards.
   * The answer is now validated against the SCHEMA FOR THE OPERATION THAT WAS SENT before it leaves here, and
   * a frame that fails becomes the same closed transport error as a socket that never answered.
   */
  dispatch(request: LocalSidecarCustodianRequest): Promise<LocalSidecarCustodianResponse> {
    return dispatchOnce(this.socketPath, request.op, request, this.timeoutMs)
      .then((response) => response as LocalSidecarCustodianResponse)
      .catch(() => { throw new CustodianTransportError(request.op); });
  }
}

/**
 * One connection, one request, one answer, bounded on both ends.
 *
 * The client bounds the RESPONSE for the same reason the server bounds the request: a compromised or
 * malfunctioning peer on either side of this socket must not be able to decide how much memory the other
 * allocates. A response that never terminates is a timeout, not a wait.
 */
function dispatchOnce(
  socketPath: string,
  op: string,
  request: unknown,
  timeoutMs: number,
): Promise<SidecarResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffered = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    // THE REASON IS A CLOSED WORD OR NOTHING. A code this build defines names the RULE the peer invoked; a
    // peer's own text is never repeated, because a process that is not this product's sidecar would answer
    // with whatever it liked — a path, a stack trace, a fragment of somebody's key.
    const fail = (code?: SidecarErrorCode) => finish(() => reject(new SidecarSocketError(
      code === undefined
        ? 'the sidecar did not answer this request'
        : `the sidecar refused this request (${code})`)));
    const timer = setTimeout(() => fail('SIDECAR_TIMEOUT'), timeoutMs);
    timer.unref?.();

    socket.setEncoding('utf8');
    socket.once('error', () => fail());
    socket.once('connect', () => { socket.write(`${JSON.stringify(request)}\n`); });

    /**
     * NOTHING IS ACTED ON UNTIL THE WHOLE ANSWER IS IN.
     *
     * THE DEFECT THIS CLOSES, AND IT SURVIVED THE FIRST ATTEMPT AT IT. The previous version resolved as soon
     * as it saw a newline, and refused a second frame only when that frame happened to arrive IN THE SAME
     * CHUNK. TCP and pipes do not work that way: a peer that writes frame one, waits, and then writes frame
     * two gets its first frame accepted and acted on — the check was against an accident of buffering rather
     * than against what the peer sent. The shipped daemon writes exactly one line and then ENDS the
     * connection, so waiting for the end costs nothing real and is the only point at which "the peer sent
     * one frame and nothing else" is a fact rather than a guess.
     */
    const complete = (): void => {
      if (settled) return;
      const newline = buffered.indexOf('\n');
      // NO TERMINATED FRAME AT ALL, or bytes beyond the one this contract carries. Both are peers that have
      // misunderstood a channel whose whole shape is one line and a close.
      if (newline === -1 || newline !== buffered.length - 1) { fail('SIDECAR_PROTOCOL_MALFORMED'); return; }
      const wire = parseSidecarWireResponse(buffered.slice(0, newline));
      if (!wire.ok) { fail(wire.code); return; }
      const response = parseSidecarResponse(op, wire.response);
      if (response === null) { fail('SIDECAR_PROTOCOL_MALFORMED'); return; }
      finish(() => resolve(response));
    };

    socket.on('data', (chunk: string) => {
      buffered += chunk;
      // BOUNDED WHILE IT ARRIVES, not after. A peer that never ends is held off by the timeout; a peer that
      // sends more than the contract carries is cut off here rather than accumulated to the end.
      if (Buffer.byteLength(buffered, 'utf8') > SIDECAR_MAX_RESPONSE_BYTES) { fail('SIDECAR_RESPONSE_TOO_LARGE'); return; }
      // A SECOND FRAME IS ALREADY DECIDABLE THE MOMENT ITS TERMINATOR ARRIVES — this is the fast refusal, not
      // the guarantee. The guarantee is `complete()` below, which runs when the peer has finished.
      const newline = buffered.indexOf('\n');
      if (newline !== -1 && newline !== buffered.length - 1) { fail('SIDECAR_PROTOCOL_MALFORMED'); }
    });
    socket.once('end', complete);
  });
}

/**
 * Ask the sidecar whether it is READY — which is not the same question as whether its socket exists.
 *
 * THE DEFECT THIS CLOSES. The app's startup gate was "is there a file at the socket path". A socket file is
 * left behind by a crashed daemon, is created by the OS the instant a process calls `listen` and long before
 * that process can reach its keystore, and says nothing at all about whether the custodian behind it can
 * unwrap a key. An app that started on that evidence started in front of a custodian that fails every
 * request — and a fail-closed unreadable item is indistinguishable from a correctly erased one, so it reports
 * itself healthy while answering nothing.
 */
export async function probeSidecarHealth(
  socketPath: string,
  timeoutMs = SIDECAR_HEALTH_TIMEOUT_MS,
): Promise<SidecarHealth | null> {
  try {
    assertLocalSocketPath(socketPath);
    // STRICTLY, FIELD BY FIELD, WITH NO EXTRAS — inside `dispatchOnce`, against the `health` schema. This
    // value decides whether the app starts, so a peer that is not this product's sidecar — or a version of it
    // this build does not understand — must fail closed rather than have its answer read as far as the fields
    // that happen to match.
    return validateSidecarHealth(await dispatchOnce(socketPath, 'health', { op: 'health' }, timeoutMs));
  } catch {
    return null;
  }
}

/** Is something SERVING on this socket right now? Used only to refuse taking a live daemon's name. */
export function probeSocketIsAlive(socketPath: string): boolean {
  // A connect that succeeds proves a listener; anything else proves nothing is accepting. This is deliberately
  // synchronous-in-effect for the caller: `reclaimStaleSocket` must decide before `listen` is attempted, and a
  // decision made after would be a race with the very daemon it is trying not to displace.
  const result = spawnSync(process.execPath, ['-e', PROBE_SCRIPT, socketPath], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
    env: { PATH: process.env.PATH ?? '' },
  });
  return result.status === 0;
}

/** Connect, and exit zero only if something accepted. No request is sent and nothing is read. */
const PROBE_SCRIPT = [
  'const net=require("node:net");',
  'const s=net.createConnection(process.argv[1]);',
  's.on("connect",()=>{s.destroy();process.exit(0)});',
  's.on("error",()=>process.exit(1));',
  'setTimeout(()=>{s.destroy();process.exit(1)},1500);',
].join('');

async function handleLine(options: LocalSidecarRuntimeOptions, line: string, socket: Socket): Promise<void> {
  const parsed = parseSidecarRequest(line);
  if (!parsed.ok) {
    writeResponse(socket, { ok: false, op: 'unknown', code: parsed.code });
    return;
  }
  if (parsed.request.op === 'health') {
    try {
      // NOT READY UNLESS SOMEBODY SAID SO. A runtime started without a health probe cannot claim readiness on
      // its own behalf — the whole point of the handshake is that something exercised the custodian.
      const unproved: SidecarHealth = {
        op: 'health',
        protocol: SIDECAR_PROTOCOL_VERSION,
        ready: false,
        custodian: 'file-reference-harness',
        ringGeneration: null,
        ringActiveCreatedAt: null,
      };
      const health = options.health === undefined ? unproved : await options.health();
      // ---- A SUCCESS ENVELOPE CARRIES SOMETHING THE CLIENT CONTRACT ACCEPTS, OR IT IS NOT A SUCCESS -------
      //
      // THE DEFECT THIS CLOSES, AND MY OWN FIRST ATTEMPT AT IT WAS HALF OF IT. This wrote `ok: true` around
      // ANY health object whose `ready` was false, and around a malformed one as long as it did not claim
      // readiness. But `validateSidecarHealth` — the schema the CLIENT applies — rejects `ready: false` and
      // every malformed field alike, so those were success envelopes whose payload the other end of this
      // socket refuses by contract. A frame that says "ok" and carries something the reader must throw away
      // is the protocol lying about itself: the reader cannot tell "the custodian is not ready" from "the
      // peer is not this product", and those need different responses from an operator.
      //
      // Not-ready is a real, ordinary state — a daemon that has not exercised its custodian yet is not ready
      // — and it now travels as what it is: the closed `SIDECAR_NOT_READY` refusal, which is exactly what a
      // client that fails closed on readiness needs to hear.
      if (validateSidecarHealth(health) === null) {
        writeResponse(socket, { ok: false, op: 'health', code: 'SIDECAR_NOT_READY' });
        return;
      }
      writeResponse(socket, { ok: true, response: health });
    } catch {
      writeResponse(socket, { ok: false, op: 'health', code: 'SIDECAR_NOT_READY' });
    }
    return;
  }
  try {
    const response = await dispatchLocalSidecarCustodianRequest(options.custodian, parsed.request);
    // ANSWERED IN THE SHAPE THIS BOUNDARY DECLARES, OR NOT ANSWERED. The custodian behind this socket is an
    // interface, not necessarily this repository's class, and what it returns reaches the app. A receipt
    // whose attestation is not an attestation, an id carrying a newline, a stale list longer than the
    // contract carries: each becomes a closed refusal here rather than something the client has to survive.
    if (parseSidecarResponse(parsed.request.op, response) === null) {
      writeResponse(socket, { ok: false, op: parsed.request.op, code: 'SIDECAR_REQUEST_FAILED' });
      return;
    }
    writeResponse(socket, { ok: true, response });
  } catch {
    // THE CODE, NEVER THE REASON. A custodian's error routinely names a path or a state; a peer on this socket
    // learns that the request failed and nothing else.
    writeResponse(socket, { ok: false, op: parsed.request.op, code: 'SIDECAR_REQUEST_FAILED' });
  }
}

function writeResponse(socket: Socket, response: WireResponse): void {
  let body: string;
  try {
    body = JSON.stringify(response);
  } catch {
    body = JSON.stringify({ ok: false, op: 'unknown', code: 'SIDECAR_REQUEST_FAILED' });
  }
  // BOUNDED ON THE WAY OUT TOO. A custodian answer larger than the contract allows is replaced by a code
  // rather than written: the client would refuse it anyway, and writing it would be this process choosing to
  // allocate on behalf of a peer.
  if (Buffer.byteLength(body, 'utf8') > SIDECAR_MAX_RESPONSE_BYTES) {
    body = JSON.stringify({ ok: false, op: 'unknown', code: 'SIDECAR_RESPONSE_TOO_LARGE' });
  }
  try {
    socket.end(`${body}\n`);
  } catch { /* a peer that has gone is not a failure of this process */ }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}
