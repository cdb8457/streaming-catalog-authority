import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { SAB_CLIENT_BOUNDS } from './sab-contract.js';
import type { SabTransport, SabTransportRequest, SabTransportResponse } from './sab-client.js';

// Projection Phase 9 — the one place a SABnzbd request becomes bytes on a socket.
//
// THIS IS THE ONLY FILE IN THE TRANCHE THAT CALLS `.reveal()` ON AN API KEY OR AN NZB SOURCE, and it is short
// on purpose so that the claim is checkable by reading it. `test/usenet-sab-client.ts` asserts the count of
// `.reveal(` occurrences across `src/core/usenet/`, so a sixth call site cannot appear without a test failing.
//
// WHAT IT REFUSES TO DO WITH THE URL IT BUILDS. It does not return it, log it, attach it to an error, put it
// in a rejection or keep a reference to it after the request settles. Node's own errors are caught and
// replaced: `ECONNREFUSED connect to http://127.0.0.1:8080/api?apikey=…` is a real thing Node will hand you,
// and forwarding it is how a credential reaches a log file that nobody thought was sensitive.
//
// WHY NOT `fetch`. `fetch` rejects with a `TypeError` whose `cause` chain carries the request URL, and its
// abort path leaves the response stream to be collected rather than closed. This uses `node:http` directly so
// the byte bound is enforced DURING the read — a worker that answers with a gigabyte gets its socket destroyed
// at the bound rather than after the process has buffered it.

export interface SabHttpTransportOptions {
  /** Overrides the per-request bound. Only ever narrowed in practice; the client clamps its own timeout. */
  readonly maxResponseBytes?: number;
}

export function createSabHttpTransport(options: SabHttpTransportOptions = {}): SabTransport {
  const maxBytes = Math.min(
    options.maxResponseBytes ?? SAB_CLIENT_BOUNDS.MAX_RESPONSE_BYTES,
    SAB_CLIENT_BOUNDS.MAX_RESPONSE_BYTES,
  );

  return {
    request(request: SabTransportRequest): Promise<SabTransportResponse> {
      return new Promise<SabTransportResponse>((resolve, reject) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(request.query)) params.set(key, value);
        // THE TWO SEALED VALUES, REVEALED HERE AND NOWHERE ELSE.
        params.set('apikey', request.apiKey.reveal());
        if (request.sealedSource !== undefined) params.set('name', request.sealedSource.reveal());

        const path = `${request.path}?${params.toString()}`;
        const send = request.endpoint.scheme === 'https' ? httpsRequest : httpRequest;

        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };

        const clientRequest = send({
          host: request.endpoint.host,
          port: request.endpoint.port,
          method: request.method,
          path,
          // NO KEEP-ALIVE. A pooled socket would outlive the request that carried the credential, and a
          // pool is state this tranche does not need for a handful of calls against a local worker.
          agent: false,
          headers: {
            accept: 'application/json',
            // The key is a query parameter because that is SABnzbd's API. It is deliberately NOT also a
            // header: two copies of a credential is two chances for one of them to be logged.
            'user-agent': 'catalog-authority-projection/9',
          },
        }, (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let overflowed = false;

          response.on('data', (chunk: Buffer) => {
            if (overflowed) return;
            total += chunk.byteLength;
            if (total > maxBytes) {
              overflowed = true;
              // DESTROYED AT THE BOUND, not after. The bound is a refusal to read, not a refusal to parse.
              response.destroy();
              clientRequest.destroy();
              finish(() => { resolve({ status: response.statusCode ?? 0, byteLength: total }); });
              return;
            }
            chunks.push(chunk);
          });

          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined; // The client turns this into `worker-response-malformed`.
            }
            finish(() => {
              resolve(body === undefined
                ? { status: response.statusCode ?? 0, byteLength: total }
                : { status: response.statusCode ?? 0, body, byteLength: total });
            });
          });

          response.on('error', () => {
            finish(() => { reject(new SabTransportError('the worker connection failed while reading')); });
          });
        });

        clientRequest.setTimeout(request.timeoutMs, () => {
          clientRequest.destroy();
          finish(() => { reject(new SabTransportError('the worker did not answer inside the request timeout')); });
        });

        clientRequest.on('error', () => {
          // THE ORIGINAL ERROR IS DISCARDED. Its message carries the URL, and the URL carries the key.
          finish(() => { reject(new SabTransportError('the worker connection failed')); });
        });

        clientRequest.end();
      });
    },
  };
}

/**
 * The only error this transport ever produces, with the only three messages it can carry.
 *
 * A fixed message set is what makes "the transport cannot leak through an exception" checkable rather than
 * argued: there is no interpolation anywhere in this file, so there is nothing for a value to be interpolated
 * into.
 */
export class SabTransportError extends Error {
  readonly code = 'SAB_TRANSPORT_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'SabTransportError';
  }
}
