import { createRealJellyfinClient, isJellyfinNetworkEnabled, isJellyfinLivePublishAllowed } from '../core/adapters/jellyfin/real-factory.js';
import { runReadOnlySmoke, runWriteSmoke, formatSmokeReport } from '../core/adapters/jellyfin/smoke.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';

/**
 * Phase 13 — OPT-IN manual smoke against a REAL Jellyfin (NEVER run in CI). Validates the PROVISIONAL
 * endpoint mapping. Until this passes on your server, do not trust that real Jellyfin publishing works.
 *
 *   read-only (safe):  JELLYFIN_ENABLE_NETWORK=true npm run smoke:jellyfin -- <refType> <refValue>
 *   write   (DESTRUCTIVE, self-cleaning; needs BOTH the --write flag AND JELLYFIN_ALLOW_LIVE_PUBLISH):
 *     JELLYFIN_ENABLE_NETWORK=true JELLYFIN_ALLOW_LIVE_PUBLISH=true \
 *     npm run smoke:jellyfin -- --write <refType> <refValue>
 *
 * The write round-trip creates a token-tagged collection, finds it by token, deletes it, and VERIFIES it
 * is gone — self-cleaning, and it reports LOUDLY if cleanup cannot be confirmed. Output is redaction-safe
 * (opaque ids/counts only). This is the ONE place besides ops:publish-reconcile that uses the platform transport.
 */
async function main(): Promise<number> {
  if (!isJellyfinNetworkEnabled()) {
    console.error('refusing: set JELLYFIN_ENABLE_NETWORK=true to run the Jellyfin smoke (default off)');
    return 2;
  }
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const [refType, refValue] = args.filter((a) => a !== '--write');
  if (!refType || !refValue) {
    console.error('usage: smoke:jellyfin [--write] <refType> <refValue>   (--write is DESTRUCTIVE + self-cleaning)');
    return 2;
  }
  if (write && !isJellyfinLivePublishAllowed()) {
    console.error('refusing --write: also set JELLYFIN_ALLOW_LIVE_PUBLISH=true (it creates + deletes a real collection)');
    return 2;
  }

  const client = createRealJellyfinClient(globalThis.fetch as unknown as FetchLike);
  const ref = { type: refType, value: refValue };
  const report = write ? await runWriteSmoke(client, ref, { name: 'catalog smoke' }) : await runReadOnlySmoke(client, ref);

  console.log(write ? 'jellyfin WRITE round-trip smoke (DESTRUCTIVE, self-cleaning):' : 'jellyfin read-only smoke:');
  console.log(formatSmokeReport(report));
  if (!write) console.log('\n(read-only; validates auth + base URL via GET /System/Info, then the GET /Items find mapping. Add --write for the full round-trip.)');
  return report.ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => { console.error('jellyfin smoke failed:', (err as Error).message); process.exit(1); });
