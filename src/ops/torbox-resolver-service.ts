import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import {
  TORBOX_API_ORIGIN, TorBoxRefError, TorBoxResolveError, buildRequestUrl, classifyStatus,
  parseResolveBody, parseStableRef, redactError,
} from '../core/adapters/torbox-resolver.js';

// The TorBox resolver service: the small loopback process that stands between the projection daemon and
// TorBox's `requestdl` endpoints.
//
// WHY THIS IS A SEPARATE PROCESS RATHER THAN CODE IN THE DAEMON. Two secrets exist here and they must not
// meet. The daemon holds a GATE secret that authorises it to ask this service for access material; this
// service holds the TORBOX API KEY. Putting the API key in the daemon's configuration would mean the
// production data-plane binary — the one that talks to arbitrary provider-supplied CDN hosts — also held the
// credential that can enumerate and manage the operator's whole TorBox account. It has no need of it. With
// the split, the worst a compromised daemon yields is the ability to ask for links it was already going to
// be given.
//
//   POST /resolve   {"objectRef": "torbox:<kind>:<id>:<fileId>"}   Authorization: Bearer <gate secret>
//   200             {"url": "...", "headers": {}, "expiresAtUnixMs": N}
//
// That is the projection daemon's own resolver contract, matched exactly — `projectiond/internal/source/
// resolver.go` POSTs that body and decodes those three fields, and it re-checks the returned origin against
// its egress allowlist and re-checks every address at dial time. This service is therefore NOT the last line
// of defence for a hostile URL, and does not pretend to be; it fails closed early because two checks are
// better than one, not because the second is absent.
//
// NOTHING THIS PROCESS LOGS EVER CONTAINS A REFERENCE, A TOKEN, A URL OR A PROVIDER MESSAGE. It logs a verb,
// a source kind and an outcome. That is enough to operate it and not enough to leak anything.

const RESOLVE_PATH = '/resolve';
const MAX_BODY_BYTES = 4 * 1024;

export interface ResolverServiceConfig {
  /** Loopback only. A resolver reachable off-host is a credential oracle. */
  readonly host: string;
  readonly port: number;
  /** Mode-0600 file holding the TorBox API key. */
  readonly credentialFile: string;
  /** Mode-0600 file holding the shared secret the DAEMON presents. A different secret from the above. */
  readonly gateSecretFile: string;
  readonly apiOrigin?: string;
  readonly requestTimeoutMs?: number;
  readonly maxAttempts?: number;
  /**
   * OFFLINE FIXTURE ONLY. Accepts a plaintext CDN link, which the fixture serves on loopback.
   *
   * It defaults to false everywhere it is threaded, so a real deployment that forgets to think about it
   * refuses plaintext — the safe direction. Nothing but the fixture-mode gate ever sets it.
   */
  readonly allowPlaintextLink?: boolean;
}

export class CredentialError extends Error {}

/**
 * Reads a secret from a file, holding it to the same rule the daemon holds its own to.
 *
 * `source.SecretFile` refuses any mode with `0o077` set. This refuses the same, for the same reason and
 * before anything is contacted: a credential the rest of the host can read is not a credential.
 */
export function readSecretFile(path: string, what: string): string {
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new CredentialError(`the ${what} file does not exist; this service fails closed rather than `
      + 'falling back to an environment variable or an argument');
  }
  if (!info.isFile()) throw new CredentialError(`the ${what} path is not a regular file`);
  if (info.size === 0) throw new CredentialError(`the ${what} file is empty`);
  if (info.size > 8 * 1024) throw new CredentialError(`the ${what} file is larger than any credential`);
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new CredentialError(`the ${what} file is readable by group or other; it must be mode 0600`);
  }
  const value = readFileSync(path, 'utf8').trim();
  if (value === '') throw new CredentialError(`the ${what} file contains only whitespace`);
  return value;
}

/** Constant-time comparison, so the gate secret cannot be recovered a byte at a time. */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

interface ProviderAnswer { readonly status: number; readonly body: unknown }

/**
 * One GET against TorBox.
 *
 * REDIRECTS ARE NEVER FOLLOWED. `node:http(s)` does not follow them on its own, and a 3xx here is classified
 * by `classifyStatus` as terminal rather than chased: a redirect on this endpoint would carry the request —
 * including `token=` — to whatever host the response names.
 */
function callProvider(url: URL, timeoutMs: number): Promise<ProviderAnswer> {
  return new Promise<ProviderAnswer>((resolve, reject) => {
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = send({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === '' ? (url.protocol === 'http:' ? 80 : 443) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      // The system trust store, unmodified: no pinning, no skipped verification, no operator-supplied CA.
      headers: { Accept: 'application/json' },
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        // BOUNDED. A provider that streams without end cannot make this service consume memory.
        total += chunk.length;
        if (total <= 64 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = undefined; }
        resolve({ status: response.statusCode ?? 0, body });
      });
      response.on('error', (error) => reject(new Error(redactError(error))));
    });
    req.on('timeout', () => { req.destroy(new Error('the provider request exceeded its finite deadline')); });
    // EVERY ERROR IS REDACTED AT THE BOUNDARY, because a network error's message carries the URL it could not
    // reach, and on this endpoint family that URL contains the operator's API key.
    req.on('error', (error) => reject(new Error(redactError(error))));
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export interface ResolveOutcome {
  readonly url: string;
  readonly expiresAtUnixMs: number;
  readonly attempts: number;
}

/**
 * Resolve one reference, with bounded retry.
 *
 * THE BACKOFF IS BOUNDED AND SO IS THE ATTEMPT COUNT. TorBox meters this endpoint; an unbounded retry against
 * a 429 is how a correctness gate becomes a denial of service against the operator's own account. Only
 * `retryable` statuses are retried, and auth failures never are — a rotated key produces the same answer
 * however many times it is asked.
 */
export async function resolveOnce(input: {
  readonly objectRef: string;
  readonly token: string;
  readonly apiOrigin: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly now?: () => number;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly allowPlaintextLink?: boolean;
}): Promise<ResolveOutcome> {
  const ref = parseStableRef(input.objectRef);
  const now = input.now ?? Date.now;
  const wait = input.sleepImpl ?? sleep;

  let attempt = 0;
  let lastRetryable: TorBoxResolveError | undefined;
  while (attempt < input.maxAttempts) {
    attempt += 1;
    // THE URL IS BUILT HERE AND DROPPED HERE. It is never returned, stored, logged or attached to an error.
    const url = buildRequestUrl(ref, input.token, input.apiOrigin);
    const answer = await callProvider(url, input.timeoutMs);
    const verdict = classifyStatus(answer.status);

    if (verdict === 'ok') {
      const resolution = parseResolveBody(answer.body, now(), input.allowPlaintextLink ?? false);
      return { url: resolution.url, expiresAtUnixMs: resolution.expiresAtUnixMs, attempts: attempt };
    }
    if (verdict === 'auth') {
      throw new TorBoxResolveError('the provider refused the credential', false);
    }
    if (verdict === 'unknown-ref') {
      throw new TorBoxResolveError('the provider does not know this item', false);
    }
    if (verdict === 'terminal') {
      throw new TorBoxResolveError(`the provider answered ${answer.status}`, false);
    }
    lastRetryable = new TorBoxResolveError(`the provider answered ${answer.status}`, true);
    if (attempt < input.maxAttempts) {
      // Exponential, capped. 250ms, 500ms, 1000ms — small enough to stay inside a read deadline.
      await wait(Math.min(250 * 2 ** (attempt - 1), 2_000));
    }
  }
  throw lastRetryable ?? new TorBoxResolveError('the provider could not be reached', true);
}

/** A log line: a verb, a kind, an outcome. Never a reference, a URL, a token or a provider message. */
const log = (message: string): void => { console.log(`torbox-resolver: ${message}`); };

export function createResolverService(config: ResolverServiceConfig): ReturnType<typeof createServer> {
  const apiOrigin = config.apiOrigin ?? TORBOX_API_ORIGIN;
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const maxAttempts = config.maxAttempts ?? 3;
  const allowPlaintextLink = config.allowPlaintextLink === true;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const deny = (status: number, reason: string): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: reason }));
    };

    if (req.method !== 'POST' || (req.url ?? '') !== RESOLVE_PATH) {
      deny(404, 'not found');
      return;
    }
    // LOOPBACK ONLY, CHECKED PER REQUEST. Binding to loopback is the first line; a proxy in front of this
    // service would defeat that silently, and the check costs nothing.
    const remote = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      deny(403, 'this service answers only the local host');
      return;
    }

    let gateSecret: string;
    let token: string;
    try {
      // RE-READ PER REQUEST, so rotating either secret does not need a restart and a revoked one stops
      // working immediately. Both files are re-checked for mode every time.
      gateSecret = readSecretFile(config.gateSecretFile, 'gate secret');
      token = readSecretFile(config.credentialFile, 'TorBox credential');
    } catch (error) {
      log(`refusing every request: ${error instanceof CredentialError ? error.message : 'credential error'}`);
      deny(503, 'the service has no usable credential');
      return;
    }

    const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!secretsMatch(presented, gateSecret)) {
      log('rejected a request that did not present the gate secret');
      deny(401, 'unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      void (async () => {
        let objectRef: string;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { objectRef?: unknown };
          if (typeof parsed.objectRef !== 'string') throw new Error('no objectRef');
          objectRef = parsed.objectRef;
        } catch {
          deny(400, 'the request body is not {"objectRef": "..."}');
          return;
        }

        try {
          const ref = parseStableRef(objectRef);
          const outcome = await resolveOnce({
            objectRef, token, apiOrigin, timeoutMs, maxAttempts, allowPlaintextLink,
          });
          // THE KIND, NOT THE REFERENCE. Enough to operate the service; not enough to identify an item.
          log(`resolved a ${ref.kind} reference in ${outcome.attempts} attempt(s)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            url: outcome.url,
            // NO HEADERS. TorBox CDN links are pre-signed; attaching the API key to the data-plane request
            // would hand the operator's account credential to whatever host the link names.
            headers: {},
            expiresAtUnixMs: outcome.expiresAtUnixMs,
          }));
        } catch (error) {
          if (error instanceof TorBoxRefError) { log('refused a malformed reference'); deny(400, 'bad reference'); return; }
          if (error instanceof TorBoxResolveError) {
            log(`the provider did not yield a link (${error.retryable ? 'retryable' : 'terminal'})`);
            deny(error.retryable ? 502 : 403, 'the provider did not yield a link');
            return;
          }
          log(`resolution failed: ${redactError(error)}`);
          deny(502, 'the provider could not be reached');
        }
      })();
    });
  });
}
