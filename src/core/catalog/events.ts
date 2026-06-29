/**
 * Opaque event constructors + the event registry.
 *
 * ADR-4 splits events into `structural` (permanent) and `behavioral` (TTL'd).
 * ADR-6 separates events from commands: these constructors author EVENTS only.
 *
 * Hard rule: an event payload may NEVER carry content identity. Payload shape is
 * constrained per event type by the registry below and enforced by the no-leak
 * gate before persistence. The only payloads that exist are:
 *   - ProviderRefAttached: { op: <ref type from a fixed enum> }
 *   - BehavioralSignal:    { weight: <bounded integer> }
 * everything else carries an empty payload.
 */

export type EventKind = 'structural' | 'behavioral';

export interface CatalogEvent {
  itemId: string;
  kind: EventKind;
  type: string;
  payload: Record<string, unknown>;
  expiresAt: Date | null;
}

/** The closed set of provider reference TYPES. Values are never events. */
export const KNOWN_REF_TYPES = ['infohash', 'tmdb', 'imdb', 'tvdb', 'tvmaze', 'anidb'] as const;
export type RefType = (typeof KNOWN_REF_TYPES)[number];

export interface EventSpec {
  kind: EventKind;
  /** true => payload.expiresAt must be set; false => must be null. */
  ttl: boolean;
}

/** Authoritative registry: which event types exist and their envelope rules. */
export const EVENT_REGISTRY: Record<string, EventSpec> = {
  ItemAdded: { kind: 'structural', ttl: false },
  ProviderRefAttached: { kind: 'structural', ttl: false },
  ItemForgotten: { kind: 'structural', ttl: false },
  ItemRestored: { kind: 'structural', ttl: false },
  BehavioralSignal: { kind: 'behavioral', ttl: true },
};

export function itemAdded(itemId: string): CatalogEvent {
  return { itemId, kind: 'structural', type: 'ItemAdded', payload: {}, expiresAt: null };
}

export function providerRefAttached(itemId: string, refType: string): CatalogEvent {
  // refType is an operational LABEL from a fixed enum, never a value.
  return {
    itemId,
    kind: 'structural',
    type: 'ProviderRefAttached',
    payload: { op: refType },
    expiresAt: null,
  };
}

export function itemForgotten(itemId: string): CatalogEvent {
  return { itemId, kind: 'structural', type: 'ItemForgotten', payload: {}, expiresAt: null };
}

export function itemRestored(itemId: string): CatalogEvent {
  return { itemId, kind: 'structural', type: 'ItemRestored', payload: {}, expiresAt: null };
}

export function behavioralSignal(itemId: string, weight: number, ttlMs: number): CatalogEvent {
  return {
    itemId,
    kind: 'behavioral',
    type: 'BehavioralSignal',
    payload: { weight },
    expiresAt: new Date(Date.now() + ttlMs),
  };
}
