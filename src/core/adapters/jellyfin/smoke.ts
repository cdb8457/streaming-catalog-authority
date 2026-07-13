import { randomUUID } from 'node:crypto';
import { JellyfinHttpError } from './http-client.js';
import type { JellyfinRef } from './client.js';

/**
 * Phase 13 — structured, REDACTION-SAFE Jellyfin endpoint-mapping smoke.
 *
 * Validates the PROVISIONAL mapping against a real server via the client primitives only (no DB /
 * authority / outbox). Every step reports `ok` + a detail that carries NO api key, title, ref value, or
 * raw identity — only opaque ids/counts/statuses. The `--write` round-trip is DESTRUCTIVE but
 * SELF-CLEANING and reports explicitly if cleanup cannot be confirmed (never silently leaves a collection).
 */
export interface SmokeStep { step: string; ok: boolean; detail: string; }
export interface SmokeReport { ok: boolean; steps: SmokeStep[]; }

/** The client primitives the smoke exercises (satisfied by JellyfinHttpClient). */
export interface SmokeClient {
  getServerInfo?(): Promise<{ readonly serverName?: string; readonly version?: string }>;
  findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]>;
  createTaggedCollection(name: string, itemIds: readonly string[], token: string): Promise<string>;
  findCollectionByToken(token: string): Promise<string | null>;
  deleteCollection(handle: string): Promise<'deleted' | 'not_found'>;
}

/** Redaction-safe error rendering: operation + status for HTTP errors, else the error name. NEVER a message/key. */
function redactErr(e: unknown): string {
  if (e instanceof JellyfinHttpError) return `${e.operation} ${e.status === null ? 'transport-error' : `HTTP ${e.status}`}`;
  return (e as { name?: string }).name ?? 'error';
}
const finalize = (steps: SmokeStep[]): SmokeReport => ({ ok: steps.every((s) => s.ok), steps });

/**
 * After an AMBIGUOUS create (the create call failed but the server may have created the collection),
 * recover BY TOKEN and clean up: if find-by-token finds it → delete + verify gone; if it finds nothing →
 * the create truly didn't happen (safe); if the lookup/delete cannot confirm → report CLEANUP NOT
 * CONFIRMED loudly. Appends a `verify-gone` step. Never leaves a collection silently.
 */
async function cleanupByToken(client: SmokeClient, token: string, steps: SmokeStep[]): Promise<void> {
  let found: string | null;
  try { found = await client.findCollectionByToken(token); }
  catch (e) { steps.push({ step: 'verify-gone', ok: false, detail: `CLEANUP NOT CONFIRMED (${redactErr(e)}) — the ambiguous create may have left a collection; delete it manually` }); return; }
  if (found === null) { steps.push({ step: 'verify-gone', ok: true, detail: 'ambiguous create left no collection (nothing to clean)' }); return; }
  try {
    await client.deleteCollection(found);
    const after = await client.findCollectionByToken(token);
    steps.push({ step: 'verify-gone', ok: after === null, detail: after === null ? 'cleaned up the collection left by the ambiguous create' : 'CLEANUP NOT CONFIRMED — a same-token collection remains; delete it manually' });
  } catch (e) { steps.push({ step: 'verify-gone', ok: false, detail: `CLEANUP NOT CONFIRMED (${redactErr(e)}) — a collection may remain; delete it manually` }); }
}

/** READ-ONLY: validate auth + base URL + server-info + the find mapping. No writes. */
export async function runReadOnlySmoke(client: SmokeClient, ref: JellyfinRef): Promise<SmokeReport> {
  const steps: SmokeStep[] = [];
  if (typeof client.getServerInfo === 'function') {
    try {
      const info = await client.getServerInfo();
      const labels = [info.serverName ? 'server-name-present' : 'server-name-absent', info.version ? 'version-present' : 'version-absent'];
      steps.push({ step: 'server-info', ok: true, detail: `server info read (${labels.join(', ')})` });
    } catch (e) {
      steps.push({ step: 'server-info', ok: false, detail: `server info failed: ${redactErr(e)}` });
      return finalize(steps);
    }
  } else {
    steps.push({ step: 'server-info', ok: true, detail: 'server info not implemented by fixture client' });
  }
  try {
    const ids = await client.findItemsByRefs([ref]);
    steps.push({ step: 'find', ok: true, detail: `${ids.length} library item(s) matched the provided ref` });
  } catch (e) {
    steps.push({ step: 'find', ok: false, detail: `find failed: ${redactErr(e)}` });
  }
  return finalize(steps);
}

/**
 * DESTRUCTIVE round-trip: find → create token-tagged collection → find-by-token → delete → verify gone.
 * Self-cleaning; the final `verify-gone` step doubles as the NO-DUPLICATE proof (if a second same-token
 * collection existed, find-by-token would still return non-null after we delete our handle).
 */
export async function runWriteSmoke(client: SmokeClient, ref: JellyfinRef, opts: { newToken?: () => string; name?: string } = {}): Promise<SmokeReport> {
  const steps: SmokeStep[] = [];
  const token = (opts.newToken ?? randomUUID)();
  const name = opts.name ?? 'catalog smoke';

  let matched: string[];
  try { matched = await client.findItemsByRefs([ref]); steps.push({ step: 'find', ok: matched.length > 0, detail: `${matched.length} item(s) matched` }); }
  catch (e) { steps.push({ step: 'find', ok: false, detail: `find failed: ${redactErr(e)}` }); return finalize(steps); }
  if (matched.length === 0) { steps.push({ step: 'create', ok: false, detail: 'skipped — no matched items to create a collection over' }); return finalize(steps); }

  let handle: string;
  try { handle = await client.createTaggedCollection(name, matched, token); steps.push({ step: 'create', ok: handle.length > 0, detail: `created a token-tagged collection (opaque handle length ${handle.length})` }); }
  catch (e) {
    steps.push({ step: 'create', ok: false, detail: `create failed: ${redactErr(e)}` });
    // The server MAY have created the collection before the failure (response/transport lost). We know
    // the token — recover + clean up by token so the smoke never orphans a collection it created.
    await cleanupByToken(client, token, steps);
    return finalize(steps);
  }

  try {
    const found = await client.findCollectionByToken(token);
    steps.push({ step: 'find-by-token', ok: found === handle, detail: found === handle ? 'recovered the created collection by token' : found === null ? 'find-by-token returned nothing (mapping issue)' : 'find-by-token returned a DIFFERENT id (mapping issue)' });
  } catch (e) { steps.push({ step: 'find-by-token', ok: false, detail: `find-by-token failed: ${redactErr(e)}` }); }

  // Self-clean + verify. verify-gone also proves NO DUPLICATE (a second same-token collection would
  // still be found after deleting our one handle). If it can't be confirmed, say so LOUDLY.
  let delDetail = '';
  try { const del = await client.deleteCollection(handle); delDetail = `delete -> ${del}`; steps.push({ step: 'revoke', ok: del === 'deleted' || del === 'not_found', detail: delDetail }); }
  catch (e) { steps.push({ step: 'revoke', ok: false, detail: `delete failed: ${redactErr(e)}` }); steps.push({ step: 'verify-gone', ok: false, detail: 'CLEANUP NOT CONFIRMED — a collection may remain; delete it manually' }); return finalize(steps); }
  try {
    const after = await client.findCollectionByToken(token);
    steps.push({ step: 'verify-gone', ok: after === null, detail: after === null ? 'collection is gone (cleanup + no-duplicate confirmed)' : 'CLEANUP NOT CONFIRMED — a same-token collection remains; delete it manually' });
  } catch (e) { steps.push({ step: 'verify-gone', ok: false, detail: `CLEANUP NOT CONFIRMED (${redactErr(e)}) — a collection may remain; delete it manually` }); }

  return finalize(steps);
}

/** Render a report as redaction-safe text lines. */
export function formatSmokeReport(report: SmokeReport): string {
  const lines = report.steps.map((s) => `  ${s.ok ? 'OK  ' : 'FAIL'} ${s.step}: ${s.detail}`);
  lines.push(`\nsmoke: ${report.ok ? 'OK' : 'FAILED'}`);
  return lines.join('\n');
}
