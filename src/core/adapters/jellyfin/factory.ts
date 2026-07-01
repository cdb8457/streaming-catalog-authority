import type { JellyfinClient } from './client.js';
import { JellyfinPublisher } from './publisher.js';
import { JellyfinRevoker } from './revoker.js';

/**
 * Phase 10 — Jellyfin adapter wiring over an INJECTED client.
 *
 * This constructs NO network client: the caller injects a {@link JellyfinClient} (a fake in Phase 10;
 * the real HTTP client arrives in Phase 11). It performs no I/O and reads no config — pure wiring, so
 * the Phase 10 factory can never touch the network.
 */
export function createJellyfinAdapters(client: JellyfinClient): { publisher: JellyfinPublisher; revoker: JellyfinRevoker } {
  return { publisher: new JellyfinPublisher(client), revoker: new JellyfinRevoker(client) };
}
