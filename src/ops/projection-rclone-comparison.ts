import { readFileSync } from 'node:fs';

// Projection Phase 1 — driving the G22 COMPARISON CONTROL: the same corpus behind an rclone/WebDAV mount.
//
// WHAT THIS FILE IS, AND THE SHORTEST TRUE DESCRIPTION IS "ALMOST NOTHING".
//
// IT IS NOT A FOURTH MEDIA-SERVER DRIVER, AND IT IS NOT EVEN A SECOND CONCURRENCY OBSERVER. The three media
// servers are stood up, scanned and catalogued by exactly the code G18 uses — `runConcurrentScans`,
// `allAdapters`, and through them the three real drivers — and this module re-exports them rather than
// wrapping them. That is not a convenience. G22 says the same corpus is measured "THE SAME WAY", and the only
// way to mean that literally is for the measurement to be the same function: a comparison whose two sides were
// observed by two implementations would be measuring the difference between the implementations as well.
//
// WHAT IT ADDS IS THE OTHER END OF THE WIRE. Two surfaces exist here that have no equivalent in the product's
// topology, and one that does:
//
//   THE REVEAL. The product publishes a one-entry generation, lets the three libraries be created against it,
//     and publishes the corpus afterwards, so the concurrent scan is the corpus's first read. A naive mount
//     has no publish step, so the endpoint holds the corpus back until told — the same shape, produced by the
//     only mechanism this topology has.
//   THE MOUNT CLIENT'S OWN ACCOUNTING, read from its remote-control surface. It is the second instrument, on
//     the other side of the wire from the endpoint's counters, and the two are reported side by side because
//     where they disagree the disagreement is the finding.
//   THE BARRIER, which is the same idea as G18's and reached through the same `setHold` — the endpoint speaks
//     the same `/control/hold/<ref>` and `/counters` shapes on purpose, so `runConcurrentScans` drives it
//     unmodified.

import {
  adapterFor, readCounters, setHold, allAdapters, runConcurrentScans,
  type CatalogueEntry, type ConcurrentScanOutcome, type ExpectedEntry, type ServerAdapter,
} from './projection-three-server-concurrency.js';

export {
  adapterFor, readCounters as readWebdavCounters, setHold, allAdapters, runConcurrentScans,
};
export type { CatalogueEntry, ConcurrentScanOutcome, ExpectedEntry, ServerAdapter };

const CONTROL_TIMEOUT_MS = 15_000;

async function fetchWithDeadline(url: string, init: RequestInit, budgetMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make the corpus visible at the endpoint.
 *
 * IT IS A CONTROL SURFACE AND NOT TRAFFIC. Like `/counters` and `/control/hold`, this path is deliberately
 * outside the WebDAV namespace and is not counted, so the act of setting up the measurement cannot appear
 * inside it.
 */
export async function revealCorpus(baseUrl: string): Promise<void> {
  const response = await fetchWithDeadline(`${baseUrl}/control/reveal`, { method: 'POST' }, CONTROL_TIMEOUT_MS);
  if (!response.ok) throw new Error(`the endpoint answered ${response.status} to a reveal`);
}

/**
 * The mount client's own view of what it did.
 *
 * WHY IT IS READ AT ALL, GIVEN THE ENDPOINT ALREADY COUNTS EVERYTHING. The endpoint counts what the client
 * ASKED FOR. The client counts what it believes it TRANSFERRED. Those are different numbers, they are
 * measured on opposite sides of the wire, and the distance between them describes the client's own read-ahead
 * and chunking rather than the corpus. Reporting only one of them would let a reader believe the other agrees.
 *
 * A NON-2XX IS A FAILURE RATHER THAN AN EMPTY OBJECT. A stats surface that answered 500 and was read through
 * `?? 0` would contribute a confident zero to a comparison table.
 */
export async function readClientStats(rcUrl: string): Promise<Record<string, unknown>> {
  const response = await fetchWithDeadline(
    `${rcUrl}/core/stats`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    CONTROL_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`the mount client answered ${response.status} for its stats`);
  return await response.json() as Record<string, unknown>;
}

/**
 * Drop the mount client's cached directory listings.
 *
 * WHY THE GATE HAS TO DO THIS, STATED PLAINLY RATHER THAN LEFT AS AN IMPLEMENTATION DETAIL. The client caches
 * a directory listing for its configured `--dir-cache-time`, and the reveal happens after the mount exists.
 * Without an explicit invalidation the corpus would become visible somewhere inside that window, at a moment
 * nobody chose, and the scan would begin against whatever the client happened to believe.
 *
 * IT DOES NOT FLATTER THE MEASUREMENT AND IT IS NOT A TUNING. Forgetting a listing makes the client fetch it
 * again — it can only ever ADD metadata traffic to the window, never remove any — and the traffic it adds is
 * exactly the traffic a first listing of the corpus costs, which is the thing being measured.
 */
export async function forgetClientCache(rcUrl: string): Promise<void> {
  const response = await fetchWithDeadline(
    `${rcUrl}/vfs/forget`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    CONTROL_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`the mount client answered ${response.status} to a cache invalidation`);
}

/** Is the mount client alive and serving its control surface? Bounded, and never retried forever. */
export async function clientVersion(rcUrl: string): Promise<string> {
  const response = await fetchWithDeadline(
    `${rcUrl}/core/version`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    CONTROL_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`the mount client answered ${response.status} for its version`);
  const body = await response.json() as Record<string, unknown>;
  return String(body.version ?? '');
}

/**
 * One object as the endpoint registered it, recorded OUTSIDE the mount before anything read one through it.
 *
 * The digest is the whole point: an expectation derived from the mount is an expectation the mount cannot
 * fail. These come from the endpoint's own `--emit` document, written from the files on disk at startup.
 */
export interface RegisteredObject {
  readonly path: string;
  readonly ref: string;
  readonly seed: boolean;
  readonly size: number;
  readonly sha256: string;
}

export function readRegisteredObjects(path: string): RegisteredObject[] {
  return JSON.parse(readFileSync(path, 'utf8')) as RegisteredObject[];
}
