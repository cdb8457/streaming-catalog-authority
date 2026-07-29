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
  prepareSocketDirectory,
  reclaimStaleSocket,
  type SidecarErrorCode,
  type SidecarHealth,
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

export { assertLocalSocketPath, SidecarSocketError } from './sidecar-ipc.js';

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

  dispatch(request: LocalSidecarCustodianRequest): Promise<LocalSidecarCustodianResponse> {
    return dispatchOnce(this.socketPath, request, this.timeoutMs)
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
  request: unknown,
  timeoutMs: number,
): Promise<LocalSidecarCustodianResponse | SidecarHealth> {
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
    const fail = () => finish(() => reject(new SidecarSocketError('the sidecar did not answer this request')));
    const timer = setTimeout(fail, timeoutMs);
    timer.unref?.();

    socket.setEncoding('utf8');
    socket.once('error', fail);
    socket.once('connect', () => { socket.write(`${JSON.stringify(request)}\n`); });
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered, 'utf8') > SIDECAR_MAX_RESPONSE_BYTES) { fail(); return; }
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      let parsed: WireResponse;
      try {
        parsed = JSON.parse(buffered.slice(0, newline)) as WireResponse;
      } catch {
        fail();
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || parsed.ok !== true) { fail(); return; }
      finish(() => resolve(parsed.response));
    });
    socket.once('end', fail);
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
    const answer = await dispatchOnce(socketPath, { op: 'health' }, timeoutMs);
    if (answer === null || typeof answer !== 'object') return null;
    const health = answer as SidecarHealth;
    if (health.op !== 'health' || health.protocol !== SIDECAR_PROTOCOL_VERSION || health.ready !== true) return null;
    return health;
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
      };
      const health = options.health === undefined ? unproved : await options.health();
      writeResponse(socket, { ok: true, response: health });
    } catch {
      writeResponse(socket, { ok: false, op: 'health', code: 'SIDECAR_NOT_READY' });
    }
    return;
  }
  try {
    const response = await dispatchLocalSidecarCustodianRequest(options.custodian, parsed.request);
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
