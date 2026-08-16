import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

import {
  SAB_API_PATH,
  canonicalSabStatus,
  type SabHistoryStatus,
  type SabQueueStatus,
} from './sab-contract.js';
import type { SabEndpoint } from './sab-client.js';

// Projection Phase 9 §3, FIRST DELIVERABLE — "a fake SABnzbd-compatible service and boundary suite BEFORE any
// real server is contacted".
//
// WHY A REAL HTTP SERVER AND NOT A STUBBED TRANSPORT. A stubbed transport proves the client's parsing. It
// proves nothing about the transport — the timeout, the byte bound, the destroyed socket, the non-JSON body,
// the 401, the query composition — and the transport is where a credential would actually leak. So this is a
// real `node:http` server on loopback, and the boundary suite drives the SHIPPED transport against it. The
// only thing left untested by that arrangement is SABnzbd itself, which is what §3's ordering is about.
//
// IT IS ALSO THE ADVERSARY. Every field is scriptable, including the ones a well-behaved worker never sends:
// an unknown state word, a slot with no job id, two job ids from one submission, a body larger than the
// client's bound, a body that is not JSON, a 200 carrying `{"status": false}`, a request that never answers.
// A client that only ever meets a polite server is a client whose failure paths have never run.
//
// IT CONTACTS NOTHING. It binds 127.0.0.1 on an ephemeral port, holds its whole model in memory, and touches
// no file, no database and no Usenet provider. Starting it does not make this project a Usenet client.

export interface FakeSabJob {
  readonly nzoId: string;
  readonly marker: string;
  readonly category: string;
  /** Where the job currently is. A job is in exactly one of the two lists, which is what SABnzbd does. */
  place: 'queue' | 'history';
  queueStatus: SabQueueStatus;
  historyStatus: SabHistoryStatus;
  storagePath: string | null;
  bytes: number;
  bytesLeft: number;
  failMessage: string | null;
}

/** The deliberate misbehaviours, all off by default. Each one is a real failure mode of a real worker. */
export interface FakeSabFaults {
  /** Answer every request with 401 and SABnzbd's own error document. */
  rejectCredential?: boolean;
  /** Answer with this HTTP status instead of 200. */
  httpStatus?: number;
  /** Answer with a body that is not JSON at all. */
  nonJsonBody?: boolean;
  /** Answer with `{"status": false, "error": …}` at HTTP 200, as SABnzbd does for API-level errors. */
  apiError?: string;
  /** Pad the response past any client bound. */
  oversizedBytes?: number;
  /** Put a state word in the queue that no contract defines. */
  unknownQueueStatus?: string;
  /** Put a state word in the history that no contract defines. */
  unknownHistoryStatus?: string;
  /** Return this many job ids from one submission instead of one. */
  submitReturnsIds?: number;
  /** Accept the submission but answer `{"status": false}`. */
  submitDeclines?: boolean;
  /** Never answer. The client's timeout is the only thing that ends the request. */
  hang?: boolean;
  /** Delay every answer by this many milliseconds. */
  latencyMs?: number;
  /** Drop `nzo_id` from every queue and history slot. */
  slotsMissingJobRef?: boolean;
  /** Answer queue and history with a document that is not shaped like one. */
  malformedDocument?: boolean;
}

export interface FakeSabOptions {
  /** The key the service will accept. Anything else is answered exactly as SABnzbd answers a bad key. */
  readonly apiKey: string;
  readonly faults?: FakeSabFaults;
  readonly version?: string;
}

export interface FakeSabRequestRecord {
  readonly mode: string;
  /** True when the request carried the configured key. The KEY ITSELF is never recorded. */
  readonly authenticated: boolean;
  /** For a submission: the marker it carried. Never the URL. */
  readonly marker: string | null;
  /** For a submission: a digest of the URL, so a test can prove two submissions differed without holding one. */
  readonly sourceDigest: string | null;
  readonly category: string | null;
}

export interface FakeSabService {
  readonly endpoint: SabEndpoint;
  readonly baseUrl: string;
  /** Everything the service has been asked, in order. The API key never appears in it. */
  readonly requests: readonly FakeSabRequestRecord[];
  /** How many times `mode=addurl` was called. The exactly-once assertions read this. */
  submitCount(): number;
  jobs(): readonly FakeSabJob[];
  jobByMarker(marker: string): FakeSabJob | undefined;
  /** Move a queued job forward. Refuses a status the contract does not define, so a test cannot fake one. */
  setQueueStatus(marker: string, status: SabQueueStatus): void;
  /** Move a job out of the queue and into history as complete. */
  complete(marker: string, output: { readonly storagePath: string; readonly bytes: number }): void;
  /** Move a job out of the queue and into history as failed. */
  failJob(marker: string, message: string): void;
  /** Remove a job from both lists entirely, as a worker whose history was purged would. */
  forget(marker: string): void;
  setFaults(faults: FakeSabFaults): void;
  close(): Promise<void>;
}

/** Start the fake worker on loopback. The caller always closes it in a `finally`. */
export async function startFakeSabnzbd(options: FakeSabOptions): Promise<FakeSabService> {
  const jobs = new Map<string, FakeSabJob>();
  const requests: FakeSabRequestRecord[] = [];
  let faults: FakeSabFaults = { ...(options.faults ?? {}) };
  let sequence = 0;

  const server: Server = createServer((req, res) => { handle(req, res); });

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== SAB_API_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"status":false,"error":"not found"}');
      return;
    }

    const mode = url.searchParams.get('mode') ?? '';
    const key = url.searchParams.get('apikey') ?? '';
    const authenticated = key === options.apiKey;
    const marker = url.searchParams.get('nzbname');
    const source = url.searchParams.get('name');
    requests.push({
      mode,
      authenticated,
      marker,
      sourceDigest: source === null ? null : createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16),
      category: url.searchParams.get('cat') ?? url.searchParams.get('category'),
    });

    const answer = (): void => {
      if (faults.hang === true) return; // the socket is simply left open

      if (!authenticated || faults.rejectCredential === true) {
        // SABnzbd's own answer, including its own HTTP status for it.
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"status":false,"error":"API Key Required"}');
        return;
      }
      if (faults.nonJsonBody === true) {
        res.writeHead(faults.httpStatus ?? 200, { 'content-type': 'text/html' });
        res.end('<html><body>SABnzbd</body></html>');
        return;
      }
      if (typeof faults.apiError === 'string') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: false, error: faults.apiError }));
        return;
      }

      const body = documentFor(mode, url);
      if (body === null) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":false,"error":"unknown mode"}');
        return;
      }
      if (typeof faults.oversizedBytes === 'number' && faults.oversizedBytes > 0) {
        (body as Record<string, unknown>)['padding'] = 'x'.repeat(faults.oversizedBytes);
      }
      res.writeHead(faults.httpStatus ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (typeof faults.latencyMs === 'number' && faults.latencyMs > 0) {
      setTimeout(answer, faults.latencyMs);
    } else {
      answer();
    }
  };

  const documentFor = (mode: string, url: URL): Record<string, unknown> | null => {
    if (faults.malformedDocument === true && (mode === 'queue' || mode === 'history')) {
      return { queue: 'not-a-document', history: 42 };
    }
    switch (mode) {
      case 'version':
        return { version: options.version ?? '4.3.2' };
      case 'fullstatus':
        return { status: { status: 'Idle', paused: false, uptime: '1d' } };
      case 'queue': {
        const slots = [...jobs.values()].filter((job) => job.place === 'queue').map((job) => ({
          ...(faults.slotsMissingJobRef === true ? {} : { nzo_id: job.nzoId }),
          status: faults.unknownQueueStatus ?? job.queueStatus,
          filename: `${job.marker}.nzb`,
          cat: job.category,
          mbleft: job.bytesLeft / (1024 * 1024),
          mb: job.bytes / (1024 * 1024),
          percentage: '0',
        }));
        return { queue: { status: 'Downloading', speed: '0 ', slots } };
      }
      case 'history': {
        const slots = [...jobs.values()].filter((job) => job.place === 'history').map((job) => ({
          ...(faults.slotsMissingJobRef === true ? {} : { nzo_id: job.nzoId }),
          status: faults.unknownHistoryStatus ?? job.historyStatus,
          name: job.marker,
          nzb_name: `${job.marker}.nzb`,
          category: job.category,
          storage: job.storagePath ?? '',
          bytes: job.bytes,
          fail_message: job.failMessage ?? '',
        }));
        return { history: { total_size: '0 B', slots } };
      }
      case 'addurl': {
        if (faults.submitDeclines === true) return { status: false, error: 'unusable NZB' };
        const markerParam = (url.searchParams.get('nzbname') ?? '').replace(/\.nzb$/i, '');
        const category = url.searchParams.get('cat') ?? '';
        sequence += 1;
        const nzoId = `SABnzbd_nzo_${sequence.toString(16).padStart(8, '0')}`;
        // A REAL WORKER WOULD ACCEPT THE SAME URL TWICE AND START TWO DOWNLOADS. So does this one — that is
        // what makes the ledger's exactly-once claim testable rather than assumed.
        jobs.set(nzoId, {
          nzoId,
          marker: markerParam,
          category,
          place: 'queue',
          queueStatus: 'Queued',
          historyStatus: 'Completed',
          storagePath: null,
          bytes: 0,
          bytesLeft: 0,
          failMessage: null,
        });
        const count = faults.submitReturnsIds ?? 1;
        return { status: true, nzo_ids: Array.from({ length: count }, (_value, index) => (index === 0 ? nzoId : `${nzoId}-${index}`)) };
      }
      default:
        return null;
    }
  };

  const find = (marker: string): FakeSabJob => {
    for (const job of jobs.values()) if (job.marker === marker) return job;
    throw new Error(`the fake worker holds no job with that marker`);
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    throw new Error('the fake worker did not bind a port');
  }

  const endpoint: SabEndpoint = { host: '127.0.0.1', port: address.port, scheme: 'http' };

  return {
    endpoint,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    submitCount: () => requests.filter((record) => record.mode === 'addurl').length,
    jobs: () => [...jobs.values()],
    jobByMarker: (marker) => [...jobs.values()].find((job) => job.marker === marker),
    setQueueStatus: (marker, status) => {
      if (canonicalSabStatus(status) !== status) throw new Error('a fake status must already be canonical');
      const job = find(marker);
      job.place = 'queue';
      job.queueStatus = status;
    },
    complete: (marker, output) => {
      const job = find(marker);
      job.place = 'history';
      job.historyStatus = 'Completed';
      job.storagePath = output.storagePath;
      job.bytes = output.bytes;
      job.bytesLeft = 0;
      job.failMessage = null;
    },
    failJob: (marker, message) => {
      const job = find(marker);
      job.place = 'history';
      job.historyStatus = 'Failed';
      job.storagePath = null;
      job.failMessage = message;
    },
    forget: (marker) => {
      const job = find(marker);
      jobs.delete(job.nzoId);
    },
    setFaults: (next) => { faults = { ...next }; },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => { resolve(); });
    }),
  };
}
