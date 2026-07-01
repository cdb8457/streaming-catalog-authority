import { createRealJellyfinClient, isJellyfinNetworkEnabled } from '../core/adapters/jellyfin/real-factory.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';

/**
 * Phase 11 — OPT-IN manual smoke against a REAL Jellyfin (NEVER run in CI). It is the validation gate
 * for the PROVISIONAL endpoint mapping: until this passes against your server, do not trust that real
 * Jellyfin publishing works.
 *
 *   JELLYFIN_ENABLE_NETWORK=true JELLYFIN_BASE_URL=... JELLYFIN_API_KEY_FILE=... \
 *   npm run smoke:jellyfin -- <refType> <refValue>
 *
 * READ-ONLY: it only resolves how many library items match a provider ref (a GET) — it creates and
 * deletes nothing. This is the ONE place `globalThis.fetch` is used (the explicit operator entrypoint);
 * the core adapter never references a bare fetch.
 */
async function main(): Promise<number> {
  if (!isJellyfinNetworkEnabled()) {
    console.error('refusing: set JELLYFIN_ENABLE_NETWORK=true to run the Jellyfin smoke (default off)');
    return 2;
  }
  const refType = process.argv[2];
  const refValue = process.argv[3];
  if (!refType || !refValue) {
    console.error('usage: smoke:jellyfin <refType> <refValue>   (read-only: reports how many library items match)');
    return 2;
  }
  const client = createRealJellyfinClient(globalThis.fetch as unknown as FetchLike);
  const matched = await client.findItemsByRefs([{ type: refType, value: refValue }]);
  console.log(`jellyfin smoke: ${matched.length} library item(s) match ${refType}:${refValue}`);
  console.log('(read-only; validates auth + base URL + the find mapping. Collection create/delete is a further manual step.)');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error('jellyfin smoke failed:', (err as Error).message); process.exit(1); });
