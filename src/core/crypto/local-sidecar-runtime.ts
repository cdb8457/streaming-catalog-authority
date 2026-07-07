import { existsSync, unlinkSync } from 'node:fs';
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

export interface LocalSidecarRuntimeOptions {
  readonly socketPath: string;
  readonly custodian: KeyCustodian;
}

export interface LocalSidecarRuntimeHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

type WireResponse =
  | { readonly ok: true; readonly response: LocalSidecarCustodianResponse }
  | { readonly ok: false; readonly op: string; readonly code: 'SIDECAR_REQUEST_FAILED' | 'SIDECAR_PROTOCOL_MALFORMED' };

export async function startLocalSidecarRuntime(options: LocalSidecarRuntimeOptions): Promise<LocalSidecarRuntimeHandle> {
  assertLocalSocketPath(options.socketPath);
  if (process.platform !== 'win32' && existsSync(options.socketPath)) unlinkSync(options.socketPath);

  const server = createServer((socket) => {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      const line = buffered.slice(0, newline);
      socket.pause();
      void handleLine(options.custodian, line, socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.socketPath);
  });

  return {
    socketPath: options.socketPath,
    async close(): Promise<void> {
      await closeServer(server);
      if (process.platform !== 'win32' && existsSync(options.socketPath)) unlinkSync(options.socketPath);
    },
  };
}

export class UnixSocketSidecarTransport implements LocalSidecarCustodianTransport {
  constructor(private readonly socketPath: string) {
    assertLocalSocketPath(socketPath);
  }

  dispatch(request: LocalSidecarCustodianRequest): Promise<LocalSidecarCustodianResponse> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffered = '';
      let settled = false;

      const fail = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new CustodianTransportError(request.op));
      };

      socket.setEncoding('utf8');
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on('data', (chunk) => {
        buffered += chunk;
        const newline = buffered.indexOf('\n');
        if (newline === -1) return;
        try {
          const parsed = JSON.parse(buffered.slice(0, newline)) as WireResponse;
          if (!parsed || parsed.ok !== true) throw new Error('sidecar rejected request');
          settled = true;
          socket.end();
          resolve(parsed.response);
        } catch {
          fail();
        }
      });
      socket.once('end', () => {
        if (!settled) fail();
      });
    });
  }
}

export function assertLocalSocketPath(socketPath: string): void {
  if (typeof socketPath !== 'string' || socketPath.trim().length === 0) {
    throw new Error('sidecar socket path is required');
  }
  if (/^https?:\/\//i.test(socketPath) || /^[a-z]+:\/\/|^[^/\\]+:\d+$/i.test(socketPath)) {
    throw new Error('sidecar socket path must be local IPC, not a network endpoint');
  }
  if (process.platform === 'win32') {
    if (!socketPath.startsWith('\\\\.\\pipe\\')) throw new Error('Windows sidecar socket path must be a named pipe');
    return;
  }
  if (!socketPath.startsWith('/')) throw new Error('Unix sidecar socket path must be absolute');
}

async function handleLine(custodian: KeyCustodian, line: string, socket: Socket): Promise<void> {
  const request = parseRequest(line);
  if (!request) {
    writeResponse(socket, { ok: false, op: 'unknown', code: 'SIDECAR_PROTOCOL_MALFORMED' });
    return;
  }

  try {
    const response = await dispatchLocalSidecarCustodianRequest(custodian, request);
    writeResponse(socket, { ok: true, response });
  } catch {
    writeResponse(socket, { ok: false, op: request.op, code: 'SIDECAR_REQUEST_FAILED' });
  }
}

function parseRequest(line: string): LocalSidecarCustodianRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Partial<LocalSidecarCustodianRequest>;
  switch (candidate.op) {
    case 'provision':
      return isString(candidate.operationId) && isString(candidate.itemId) && isNumber(candidate.epoch) ? candidate as LocalSidecarCustodianRequest : null;
    case 'commitProvision':
      return isString(candidate.operationId) ? candidate as LocalSidecarCustodianRequest : null;
    case 'get':
      return isString(candidate.keyId) && isNumber(candidate.epoch) ? candidate as LocalSidecarCustodianRequest : null;
    case 'destroy':
      return isString(candidate.operationId) && isString(candidate.keyId) ? candidate as LocalSidecarCustodianRequest : null;
    case 'status':
      return isString(candidate.keyId) ? candidate as LocalSidecarCustodianRequest : null;
    case 'listStaleProvisioning':
      return candidate as LocalSidecarCustodianRequest;
    default:
      return null;
  }
}

function writeResponse(socket: Socket, response: WireResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
