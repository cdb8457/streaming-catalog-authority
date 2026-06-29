/**
 * Opaque event constructors.
 *
 * ADR-4 splits events into `structural` (permanent) and `behavioral` (TTL'd).
 * ADR-6 separates events from commands: these constructors author EVENTS only.
 *
 * Hard rule: an event payload may NEVER carry content identity — no title,
 * year, external_ids, infohash value, magnet, URL, tracker, or key. Identity is
 * written straight into the projection by command handlers in the same
 * transaction; it does not pass through here. The no-leak gate enforces this on
 * every payload before persistence.
 */

export type EventKind = 'structural' | 'behavioral';

export interface CatalogEvent {
  itemId: string;
  kind: EventKind;
  type: string;
  payload: Record<string, unknown>;
  expiresAt: Date | null;
}

/** Item enters the catalog (operationally present). */
export function itemAdded(itemId: string): CatalogEvent {
  return { itemId, kind: 'structural', type: 'ItemAdded', payload: {}, expiresAt: null };
}

/**
 * A provider reference of a given TYPE is attached. `refType` is an operational
 * label (e.g. "infohash", "tmdb") — never the value. The value is written to
 * the projection by the command handler, in the same transaction, off-event.
 */
export function providerRefAttached(itemId: string, refType: string): CatalogEvent {
  return {
    itemId,
    kind: 'structural',
    type: 'ProviderRefAttached',
    payload: { op: refType },
    expiresAt: null,
  };
}

/** Forget / neutralize: operationally removes the item and all its identity. */
export function itemForgotten(itemId: string): CatalogEvent {
  return { itemId, kind: 'structural', type: 'ItemForgotten', payload: {}, expiresAt: null };
}

/** A behavioral signal carrying a non-identifying weight and a TTL. */
export function behavioralSignal(itemId: string, weight: number, ttlMs: number): CatalogEvent {
  return {
    itemId,
    kind: 'behavioral',
    type: 'BehavioralSignal',
    payload: { weight },
    expiresAt: new Date(Date.now() + ttlMs),
  };
}
