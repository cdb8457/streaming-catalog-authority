import type { Pool } from 'pg';
import { getPool } from '../../db/pool.js';
import { validateEventPayload } from '../redaction/noleak.js';
import { EVENT_REGISTRY, isOpaqueItemId, type CatalogEvent } from './events.js';

/** Identity supplied to a command. Stored in the projection, never in events. */
export interface ItemIdentity {
  title?: string | null;
  year?: number | null;
  externalIds?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  providerRefs?: ReadonlyArray<{ type: string; value: string }>;
}

/**
 * Typed client over the database-resident authority.
 *
 * The DB owns the boundary: every method here is a call to a SECURITY DEFINER
 * function that enforces id opacity, the no-leak gate on the exact stored jsonb,
 * lifecycle transitions, append-only, and the projection fold. The TS-side
 * checks below are fast-fail only (and defend against client-side toJSON
 * trickery by validating the parsed, serialized payload) — they are not the
 * enforcement.
 */
export class CatalogAuthority {
  private readonly pool: Pool;

  constructor(pool: Pool = getPool()) {
    this.pool = pool;
  }

  /** Generic event-sourced mutator. */
  async apply(event: CatalogEvent): Promise<string> {
    if (!isOpaqueItemId(event.itemId)) throw new Error('item id must be opaque (uuid)');
    this.assertEnvelope(event);
    // Validate the value that will actually be serialized & stored — defeats a
    // client toJSON()/getter that differs from the enumerable shape.
    const serialized = JSON.stringify(event.payload ?? {});
    validateEventPayload(event.type, JSON.parse(serialized));
    const { rows } = await this.pool.query('SELECT cat_apply($1, $2, $3::jsonb, $4) AS seq', [
      event.itemId,
      event.type,
      serialized,
      event.expiresAt,
    ]);
    return String(rows[0].seq);
  }

  async addItem(itemId: string, identity: ItemIdentity = {}): Promise<string> {
    if (!isOpaqueItemId(itemId)) throw new Error('item id must be opaque (uuid)');
    const { rows } = await this.pool.query(
      'SELECT cat_add_item($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb) AS seq',
      [itemId, identity.title ?? null, identity.year ?? null, this.json(identity.externalIds), this.json(identity.metadata), this.refs(identity)],
    );
    return String(rows[0].seq);
  }

  async restore(itemId: string, identity: ItemIdentity = {}): Promise<string> {
    if (!isOpaqueItemId(itemId)) throw new Error('item id must be opaque (uuid)');
    const { rows } = await this.pool.query(
      'SELECT cat_restore($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb) AS seq',
      [itemId, identity.title ?? null, identity.year ?? null, this.json(identity.externalIds), this.json(identity.metadata), this.refs(identity)],
    );
    return String(rows[0].seq);
  }

  async forget(itemId: string): Promise<string> {
    if (!isOpaqueItemId(itemId)) throw new Error('item id must be opaque (uuid)');
    const { rows } = await this.pool.query('SELECT cat_forget($1) AS seq', [itemId]);
    return String(rows[0].seq);
  }

  async recordSignal(itemId: string, weight: number, ttlMs: number): Promise<string> {
    if (!isOpaqueItemId(itemId)) throw new Error('item id must be opaque (uuid)');
    const { rows } = await this.pool.query('SELECT cat_record_signal($1, $2, $3) AS seq', [itemId, weight, ttlMs]);
    return String(rows[0].seq);
  }

  /** Deterministic rebuild folded against an explicit cutoff. */
  async rebuildProjection(cutoff: Date = new Date()): Promise<void> {
    await this.pool.query('SELECT cat_rebuild($1)', [cutoff]);
  }

  /** Atomic prune of expired behavioral events + refold, one cutoff. */
  async pruneAndRebuild(cutoff: Date = new Date()): Promise<number> {
    const { rows } = await this.pool.query('SELECT cat_prune_and_rebuild($1) AS n', [cutoff]);
    return Number(rows[0].n);
  }

  // --- helpers --------------------------------------------------------------

  private assertEnvelope(event: CatalogEvent): void {
    // Generic messages — never interpolate a (possibly attacker-supplied) type.
    const spec = EVENT_REGISTRY[event.type];
    if (!spec) throw new Error('apply: unknown event type');
    if (event.kind !== spec.kind) throw new Error('apply: event has the wrong kind');
    if (spec.ttl && event.expiresAt === null) throw new Error('apply: event requires expiresAt');
    if (!spec.ttl && event.expiresAt !== null) throw new Error('apply: event must not have expiresAt');
  }

  private json(v: Record<string, unknown> | null | undefined): string | null {
    return v ? JSON.stringify(v) : null;
  }

  private refs(identity: ItemIdentity): string {
    return JSON.stringify((identity.providerRefs ?? []).map((r) => ({ type: r.type, value: r.value })));
  }
}
