import { Client } from 'pg';

import { loadDbConfig } from '../../config/env.js';
import { deriveInode, type DegradedState, type ProjectedEntry, type ProjectionSource } from './manifest-v1.js';
import { byteIdentityFor, locatorFor, type PublishSnapshot, type SnapshotEntry } from './publisher.js';
import { readSnapshot } from './publish-service.js';

// Projection Phase 10 §3.2, D10.1 — THE NAMESPACE AS THE PUBLISHER SEES IT, READ WITHOUT PUBLISHING.
//
// WHY THIS FILE EXISTS. Phase 9 §4's sixth hard refusal is "let a Usenet outage alter the TorBox namespace",
// and `torBoxDrift` is the check that proves it. The check runs around every publish for which the publisher
// can present the namespace — `AdmissionPublisher.namespaceSnapshot`. Phase 10 §2.1 established that on a real
// appliance NO publisher could: `createRegistryPublisher` returned `{ publish }`, so `before` was always null,
// the comparison was always skipped, and every real admission was recorded `admittedWithoutDriftCheck: true`.
// The guard the Phase 9 review moved into the publish path had, in production, exactly the property it was
// moved to stop having. This module is what makes it able to run.
//
// THE THREE DECISIONS IN IT, EACH OF WHICH COULD HAVE BEEN MADE WRONG.
//
// 1. IT TAKES NO PUBLISH LOCK. Phase 10 §7 R1. `readSnapshot` is normally called inside `publishGeneration`,
//    after `cat_projection_publish_lock()`, which is easy to read as "the snapshot needs the lock". It does
//    not. That lock exists to exclude a second WRITER of generations; a consistent READ of the registry needs
//    isolation, not exclusion. Taking it here would serialise every Usenet admission behind every publish, and
//    an admission that blocks on an unrelated publish is a worse product than one that reads a moment later.
//
// 2. IT OPENS ITS OWN SHORT-LIVED CONNECTION rather than borrowing the caller's. The caller's client is the
//    one `registerVersion` and `registerEntry` are about to write on. Issuing BEGIN/COMMIT on it would work
//    today and would silently end an enclosing transaction the day somebody wraps one around the registry —
//    and the failure would be a committed half-publish, discovered at a mount. A separate connection cannot
//    have that bug. It costs one connect per admission, which is the cheapest thing in a path that digests a
//    whole file.
//
// 3. THE DERIVATION IS TOTAL: NO ENTRY IS EVER DROPPED. `buildGeneration` skips a row it cannot turn into an
//    admissible manifest entry — a missing version row, a locator naming an unregistered root — because a
//    partial generation is not a generation. A DRIFT COMPARISON MUST NOT DO THAT. An entry dropped from both
//    sides is an entry the guard is blind to, and "the guard was blind to exactly the rows something had
//    already broken" is how a guard passes while the thing it guards is moving. So an unresolvable version
//    contributes UNRESOLVED_SIZE_BYTES rather than an absence, and a version row that appears or disappears
//    around a publish shows up as TORBOX_ENTRY_SIZE_CHANGED, which is what it is.
//
// IT DERIVES FROM THE PRODUCER'S OWN FUNCTIONS. `locatorFor`, `byteIdentityFor` and `deriveInode` are imported
// rather than re-implemented. A second implementation of a locator would compare cleanly against itself and
// diverge from the manifest nobody was comparing, which is the quietest kind of wrong.
//
// IT CONTACTS NOTHING BUT THE CONTROL PLANE'S OWN DATABASE. No provider, no endpoint, no media server, no
// filesystem, no clock.

/**
 * The size reported for an entry whose version row could not be resolved.
 *
 * NEGATIVE ON PURPOSE. It is not a size any registered version can hold — `registerVersion` refuses a
 * negative — so it can never collide with a real one, and a comparison that meets it is comparing a row whose
 * version is missing rather than a row whose file is empty.
 */
export const UNRESOLVED_SIZE_BYTES = -1;

/** The mtime reported for the same case, for the same reason: not a value a registered version can hold. */
export const UNRESOLVED_MTIME = '';

/**
 * One snapshot picture, as the entries a drift comparison is stated in terms of.
 *
 * PURE. No database, no clock, no filesystem — the same discipline `publisher.ts` keeps, and for the same
 * reason: a reviewer can hold two of these side by side and re-derive the verdict by hand.
 */
export function projectedEntriesOf(snapshot: PublishSnapshot): readonly ProjectedEntry[] {
  const versions = new Map(snapshot.versions.map((version) => [version.projectedVersionId, version]));

  return [...snapshot.entries]
    .sort((a, b) => (a.projectedEntryId < b.projectedEntryId ? -1 : 1))
    .map((entry: SnapshotEntry): ProjectedEntry => {
      const version = versions.get(entry.projectedVersionId);
      const identity = version === undefined ? null : byteIdentityFor(version);

      // ORDERED BY PREFERENCE, AS THE MANIFEST ORDERS THEM. `torBoxDrift` compares the source list by value,
      // so a comparison against an unordered list would report a locator change every time the database
      // returned two rows in a different order — an alarm that fires on nothing teaches an operator to
      // ignore the one that fires on something.
      const sources: ProjectionSource[] = [...entry.sources]
        .sort((a, b) => a.preference - b.preference)
        .map((source) => ({
          sourceId: source.sourceId,
          kind: source.kind,
          preference: source.preference,
          sourceGeneration: source.sourceGeneration,
          locator: locatorFor(source),
          byteIdentity: identity,
        }));

      return {
        projectedEntryId: entry.projectedEntryId,
        logicalMediaId: entry.itemId,
        projectedVersionId: entry.projectedVersionId,
        path: entry.path,
        nodeKind: 'file',
        sizeBytes: version?.sizeBytes ?? UNRESOLVED_SIZE_BYTES,
        mtime: version?.mtime ?? UNRESOLVED_MTIME,
        mode: 0o444,
        readOnly: true,
        inode: deriveInode(entry.projectedVersionId),
        visibility: entry.visibility,
        degraded: entry.visibility === 'degraded'
          ? {
            reason: (entry.degradedReason ?? '') as DegradedState['reason'],
            since: entry.degradedSince ?? '',
          }
          : null,
        retiring: entry.visibility === 'retiring'
          ? {
            deletionIntentId: entry.deletionIntentId ?? '',
            declaredAt: entry.retiringDeclaredAt ?? '',
            graceDeadline: entry.graceDeadline ?? '',
          }
          : null,
        sources,
      };
    });
}

/**
 * Read the live namespace as projected entries, over a connection this function owns.
 *
 * `REPEATABLE READ READ ONLY` and no publish lock — see decisions 1 and 2 above. READ ONLY is not decoration:
 * it makes it a property of the transaction, rather than of this file staying correct, that a snapshot can
 * never write. A caller that wants a drift guard is a caller who must be able to say that.
 *
 * IT THROWS RATHER THAN RETURNING AN EMPTY PICTURE when the database will not answer. An empty namespace and
 * an unreadable one are different facts, and returning `[]` for the second would make a TorBox entry that
 * exists look like one that was never there — a comparison that then reports no drift because it compared
 * nothing against nothing. `admission.ts` is what decides that a declared-but-failing snapshot refuses the
 * admission instead of quietly weakening the guarantee.
 */
export async function readNamespaceSnapshot(connectionString?: string): Promise<readonly ProjectedEntry[]> {
  const client = new Client({ connectionString: connectionString ?? loadDbConfig().databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const snapshot = await readSnapshot(client);
      await client.query('COMMIT');
      return projectedEntriesOf(snapshot);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
