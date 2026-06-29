import { randomUUID } from 'node:crypto';

/**
 * Opaque event constructors + the event registry.
 *
 * ADR-4 splits events into `structural` (permanent) and `behavioral` (TTL'd).
 * ADR-6 separates events from commands.
 *
 * Authority logic lives in the database (see migrations.sql). These types and
 * constructors are the typed client surface; the DB re-validates everything, so
 * they are convenience + fast-fail, not the boundary.
 */

export type EventKind = 'structural' | 'behavioral';

export interface CatalogEvent {
  itemId: string;
  kind: EventKind;
  type: string;
  payload: Record<string, unknown>;
  expiresAt: Date | null;
}

/** Item ids are opaque UUIDs — never derived from content. */
export function mintItemId(): string {
  return randomUUID();
}

export const ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isOpaqueItemId(id: string): boolean {
  return ITEM_ID_RE.test(id);
}

/** The closed set of provider reference TYPES. Values are never events. */
export const KNOWN_REF_TYPES = ['infohash', 'tmdb', 'imdb', 'tvdb', 'tvmaze', 'anidb'] as const;
export type RefType = (typeof KNOWN_REF_TYPES)[number];

export interface EventSpec {
  kind: EventKind;
  ttl: boolean;
}

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
  return { itemId, kind: 'structural', type: 'ProviderRefAttached', payload: { op: refType }, expiresAt: null };
}
export function itemForgotten(itemId: string): CatalogEvent {
  return { itemId, kind: 'structural', type: 'ItemForgotten', payload: {}, expiresAt: null };
}
export function itemRestored(itemId: string): CatalogEvent {
  return { itemId, kind: 'structural', type: 'ItemRestored', payload: {}, expiresAt: null };
}
export function behavioralSignal(itemId: string, weight: number, ttlMs: number): CatalogEvent {
  return { itemId, kind: 'behavioral', type: 'BehavioralSignal', payload: { weight }, expiresAt: new Date(Date.now() + ttlMs) };
}
