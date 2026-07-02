import { loadCustodianConfig, createCustodian } from '../core/crypto/custodian-factory.js';
import { loadPublishConsent } from '../core/publish/consent.js';
import { CatalogAuthority } from '../core/catalog/authority.js';
import { OutboxService } from '../core/publish/outbox.js';
import { runRevocation } from '../core/publish/reconcile.js';
import { createRealJellyfinOutboxTarget, createRealJellyfinAdapters } from '../core/adapters/jellyfin/real-factory.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';
import { getPool, closePool } from '../db/pool.js';

/**
 * Phase 12 — OPERATOR repair command (opt-in; NOT in CI). Reconciles the durable publish-intent outbox
 * against Jellyfin: adopt-by-token / (re)create stuck intents, then drive revocation of forgotten items'
 * external copies. Gated (JELLYFIN_ENABLE_NETWORK + JELLYFIN_ALLOW_LIVE_PUBLISH + PUBLISH_EXTERNAL_IDENTITY);
 * this is the ONE place besides the smoke CLI that uses the platform transport. Redaction-safe output
 * (counts only — never identity, handles, or the api key).
 */
async function main(): Promise<number> {
  const consent = loadPublishConsent();
  const custodian = createCustodian(loadCustodianConfig());
  const pool = getPool();
  const auth = new CatalogAuthority(pool, custodian);
  const fetchImpl = globalThis.fetch as unknown as FetchLike;

  try {
    const target = createRealJellyfinOutboxTarget(fetchImpl, process.env); // throws (fail-closed) unless gated on
    const outbox = new OutboxService(pool, auth, consent, target, ['title', 'providerRefs']);
    const intents = await outbox.reconcile();
    console.log(`publish intents: adopted=${intents.adopted} created=${intents.created} failed=${intents.failed} stuck=${intents.stuck}`);

    const { revoker } = createRealJellyfinAdapters(fetchImpl, process.env);
    const rev = await runRevocation(pool, revoker);
    console.log(`revocations: queued=${rev.queued} revoked=${rev.revoked} failed=${rev.failed} pending=${rev.pending}`);
    return intents.failed > 0 || intents.stuck > 0 || rev.pending > 0 ? 1 : 0; // non-zero = operator attention
  } finally {
    await closePool();
  }
}

main().then((code) => process.exit(code)).catch((err) => { console.error('publish-reconcile failed:', (err as Error).message); process.exit(1); });
