import { Client } from 'pg';

import { loadDbConfig } from '../../config/env.js';
import { MIGRATION_VERSION } from '../../db/schema-version.js';
import {
  artifactMatches, ensureArtifact, readPointer, writePointer, type PointerDocument,
} from './artifact-store.js';
import { validateManifestV1, type ManifestProblem, type ProjectionManifestV1 } from './manifest-v1.js';
import {
  artifactNameFor, buildGeneration, type BuildResult, type PreviousGeneration, type PublishSnapshot,
  type SnapshotEntry, type SnapshotRoot, type SnapshotSource, type SnapshotVersion,
} from './publisher.js';

// Projection Phase 1 — the production publisher.
//
// WHAT MAKES THIS SAFE, IN ONE PARAGRAPH. PostgreSQL is the durable authority: a generation's exact bytes and
// its digest are COMMITTED before anything is written to disk, and the row that says which generation is
// current is updated before the pointer file that a daemon reads. Every step is idempotent, every step is
// resumable, and the state after a crash at ANY boundary is one the next run can recognise and finish. The
// filesystem is a rendering of the database, never the other way round; when they disagree the database wins
// and the publisher repairs the file.
//
// THE ORDER, AND WHY IT IS THAT ORDER.
//
//   1. Take the publisher lock. A second publisher is REFUSED, not queued: two producers minting successors
//      to the same predecessor would both be internally consistent and one of them would be a lie.
//   2. RECOVER FIRST, ALWAYS. Before a single new byte is computed, the database and the manifest directory
//      are made to agree. A publisher that built a successor on top of an unrepaired directory would leave a
//      running daemon two generations behind, and admission is strict about succession — a skipped sequence is
//      refused forever, not caught up.
//   3. Read the snapshot and prepare the generation in ONE repeatable-read transaction. The manifest is
//      therefore a picture of one instant, not a scan whose beginning and end disagree.
//   4. Write the artifact under a name no reader watches, fsync'd, renamed into place.
//   5. Make it current IN THE DATABASE. This is the commit point; after it the control plane's answer to
//      "what should be served" has changed.
//   6. Write the pointer file, last. This is the moment a daemon can see it.
//
// A CRASH BETWEEN 5 AND 6 leaves the database ahead of the directory. The daemon goes on serving the previous
// generation — which is exactly what it does during any control-plane outage — and the next run's recovery
// pass republishes the pointer and STOPS, so the daemon gets its one-step succession rather than a jump.
//
// A CRASH BETWEEN 3 AND 5 leaves a `prepared` generation: durable bytes that are not current. The next run
// RESUMES it from the bytes the database already committed, so the artifact it publishes is not an equivalent
// rebuild, it is the same artifact.
//
// NOTHING HERE READS A PROVIDER, A MEDIA SERVER OR A FILE OF MEDIA. The only filesystem it touches is the
// manifest directory, and the only network it speaks is PostgreSQL.

export type PublishOutcome =
  /** A new generation was built, made current and published. */
  | 'published'
  /** The catalog says exactly what the current generation already says. Nothing was minted. */
  | 'unchanged'
  /** The directory disagreed with the database and was repaired. No successor was built this run. */
  | 'recovered'
  /** A generation prepared by an earlier, interrupted run was finished from its committed bytes. */
  | 'resumed'
  /** The snapshot cannot produce an admissible generation. The current generation is untouched. */
  | 'refused'
  /** Another publisher holds the lock. */
  | 'concurrent-publisher';

/**
 * The publish report.
 *
 * REDACTION-SAFE BY CONSTRUCTION, like every other report in this repository: counts, digests, a sequence, a
 * generated artifact NAME and closed-set problem codes. No projected path, no locator, no object reference, no
 * media-server anything, and no directory — the manifest directory is an input, not something to echo back.
 */
export interface PublishReport {
  readonly outcome: PublishOutcome;
  readonly sequence: number | null;
  readonly generationId: string | null;
  readonly artifactName: string | null;
  readonly artifactBytes: number | null;
  readonly manifestDigest: string | null;
  readonly contentDigest: string | null;
  readonly snapshotDigest: string | null;
  readonly entryCount: number | null;
  readonly additions: number;
  readonly deletions: number;
  readonly problems: readonly ManifestProblem[];
  /** What the recovery pass had to put right: `artifact`, `pointer`, or nothing. */
  readonly repaired: readonly string[];
  /** False where the platform cannot fsync a directory. Never silently true. */
  readonly directorySynced: boolean;
}

/**
 * Where a run may be stopped, for the gates that prove a crash at each boundary is survivable.
 *
 * IT IS SAFE TO EXPOSE. Every one of these is a point the design already claims is crash-safe, so a switch
 * that stops there can only demonstrate the property, never create a state the publisher could not otherwise
 * be in. There is no fault point that skips a durability step or writes something different — the stages are
 * the real ones, stopped early.
 */
export type PublishFault = 'after-prepare' | 'after-artifact' | 'after-db-pointer';

export class PublishFaultInjected extends Error {
  readonly code = 'PUBLISH_FAULT_INJECTED';

  constructor(readonly stage: PublishFault) {
    super(`publish stopped at the ${stage} boundary by an injected fault`);
    this.name = 'PublishFaultInjected';
  }
}

export interface PublishOptions {
  /** The directory the pointer and the artifacts are published into. Must exist. */
  readonly manifestDir: string;
  readonly intent?: 'routine' | 'deletion';
  readonly deletions?: readonly string[];
  readonly deletionGuardAcknowledged?: boolean;
  /** Supplied rather than read, so a grace deadline can be tested without waiting for one. */
  readonly now?: () => Date;
  readonly fault?: PublishFault;
  readonly connectionString?: string;
}

const nowIsoOf = (clock: () => Date): string => {
  const iso = clock().toISOString();
  // toISOString is already millisecond-precision UTC, which is exactly the contract's timestamp grammar.
  return iso;
};

interface GenerationRow {
  readonly sequence: number;
  readonly generation_id: string;
  readonly content_digest: string;
  readonly manifest_digest: string;
  readonly artifact_name: string;
  readonly artifact_bytes: number;
  readonly artifact: Buffer;
  readonly state: string;
}

const GENERATION_COLUMNS =
  'sequence, generation_id, content_digest, manifest_digest, artifact_name, artifact_bytes, artifact, state';

function toGenerationRow(row: Record<string, unknown>): GenerationRow {
  return {
    sequence: Number(row['sequence']),
    generation_id: String(row['generation_id']),
    content_digest: String(row['content_digest']),
    manifest_digest: String(row['manifest_digest']),
    artifact_name: String(row['artifact_name']),
    artifact_bytes: Number(row['artifact_bytes']),
    artifact: row['artifact'] as Buffer,
    state: String(row['state']),
  };
}

function pointerFor(row: GenerationRow): PointerDocument {
  return {
    generationId: row.generation_id,
    sequence: row.sequence,
    artifactName: row.artifact_name,
    artifactBytes: row.artifact_bytes,
    manifestDigest: row.manifest_digest,
  };
}

const emptyReport = (outcome: PublishOutcome, extra: Partial<PublishReport> = {}): PublishReport => ({
  outcome, sequence: null, generationId: null, artifactName: null, artifactBytes: null,
  manifestDigest: null, contentDigest: null, snapshotDigest: null, entryCount: null,
  additions: 0, deletions: 0, problems: [], repaired: [], directorySynced: true, ...extra,
});

/** Read the whole registry as one consistent picture. Called inside the repeatable-read transaction. */
async function readSnapshot(client: Client): Promise<PublishSnapshot> {
  const roots = (await client.query('SELECT root_id, kind FROM public.projection_source_roots ORDER BY root_id'))
    .rows.map((row): SnapshotRoot => ({ rootId: String(row.root_id), kind: row.kind }));

  const versions = (await client.query(
    `SELECT projected_version_id, version_key, size_bytes, mtime, probe_window_bytes, probes
       FROM public.projection_versions ORDER BY projected_version_id`))
    .rows.map((row): SnapshotVersion => ({
      projectedVersionId: String(row.projected_version_id),
      versionKey: String(row.version_key),
      // BIGINT arrives as a string from the driver. A size that survived an implicit coercion is not an exact
      // size, so it is converted explicitly and exactly once, here.
      sizeBytes: Number(row.size_bytes),
      mtime: String(row.mtime),
      probeWindowBytes: row.probe_window_bytes === null ? null : Number(row.probe_window_bytes),
      probes: row.probes === null ? null : (row.probes as SnapshotVersion['probes']),
    }));

  const sourcesByEntry = new Map<string, SnapshotSource[]>();
  for (const row of (await client.query(
    `SELECT projected_entry_id, source_id, kind, preference, source_generation, root_id, object_ref
       FROM public.projection_entry_sources ORDER BY projected_entry_id, preference`)).rows) {
    const id = String(row.projected_entry_id);
    const list = sourcesByEntry.get(id) ?? [];
    list.push({
      sourceId: String(row.source_id),
      kind: row.kind,
      preference: Number(row.preference),
      sourceGeneration: Number(row.source_generation),
      rootId: String(row.root_id),
      objectRef: String(row.object_ref),
    });
    sourcesByEntry.set(id, list);
  }

  const entries = (await client.query(
    `SELECT projected_entry_id, item_id, projected_version_id, path, visibility,
            degraded_reason, degraded_since, deletion_intent_id, retiring_declared_at, grace_deadline
       FROM public.projection_entries
      WHERE deleted_in_sequence IS NULL
      ORDER BY projected_entry_id`))
    .rows.map((row): SnapshotEntry => ({
      projectedEntryId: String(row.projected_entry_id),
      itemId: String(row.item_id),
      projectedVersionId: String(row.projected_version_id),
      path: String(row.path),
      visibility: row.visibility,
      degradedReason: row.degraded_reason === null ? null : String(row.degraded_reason),
      degradedSince: row.degraded_since === null ? null : String(row.degraded_since),
      deletionIntentId: row.deletion_intent_id === null ? null : String(row.deletion_intent_id),
      retiringDeclaredAt: row.retiring_declared_at === null ? null : String(row.retiring_declared_at),
      graceDeadline: row.grace_deadline === null ? null : String(row.grace_deadline),
      sources: sourcesByEntry.get(String(row.projected_entry_id)) ?? [],
    }));

  return { roots, versions, entries };
}

async function currentGeneration(client: Client): Promise<GenerationRow | null> {
  const rows = (await client.query(
    `SELECT ${GENERATION_COLUMNS} FROM public.projection_generations WHERE state = 'current'`)).rows;
  return rows.length === 0 ? null : toGenerationRow(rows[0] as Record<string, unknown>);
}

/** The lowest prepared generation above the current one: a run that was interrupted before it committed. */
async function preparedSuccessor(client: Client, currentSequence: number): Promise<GenerationRow | null> {
  const rows = (await client.query(
    `SELECT ${GENERATION_COLUMNS} FROM public.projection_generations
      WHERE state = 'prepared' AND sequence > $1 ORDER BY sequence ASC LIMIT 1`, [currentSequence])).rows;
  return rows.length === 0 ? null : toGenerationRow(rows[0] as Record<string, unknown>);
}

function previousFrom(row: GenerationRow): PreviousGeneration | null {
  const parsed = validateManifestV1(JSON.parse(row.artifact.toString('utf8')) as unknown);
  if (!parsed.ok || parsed.manifest === null) return null;
  return {
    manifest: parsed.manifest as ProjectionManifestV1,
    manifestDigest: row.manifest_digest,
    sequence: row.sequence,
    contentDigest: row.content_digest,
  };
}

/**
 * Make the manifest directory agree with the database.
 *
 * Returns what it had to put right. An empty list means the two already agreed, which is the steady state and
 * the only state in which this run may go on to build a successor.
 */
function recoverDirectory(manifestDir: string, current: GenerationRow): {
  repaired: string[];
  directorySynced: boolean;
} {
  const repaired: string[] = [];
  let directorySynced = true;

  const artifactWrite = ensureArtifact(
    manifestDir, current.artifact_name, current.artifact, current.manifest_digest);
  if (artifactWrite !== null) {
    repaired.push('artifact');
    directorySynced = directorySynced && artifactWrite.directorySynced;
  }

  const published = readPointer(manifestDir);
  const wanted = pointerFor(current);
  const agrees = published !== null
    && published.generationId === wanted.generationId
    && published.sequence === wanted.sequence
    && published.artifactName === wanted.artifactName
    && published.artifactBytes === wanted.artifactBytes
    && published.manifestDigest === wanted.manifestDigest;
  if (!agrees) {
    const write = writePointer(manifestDir, wanted);
    repaired.push('pointer');
    directorySynced = directorySynced && write.directorySynced;
  }
  return { repaired, directorySynced };
}

/**
 * Run one publish.
 *
 * Exactly one outcome per call, and every one of them leaves the namespace in a state a daemon can serve. The
 * caller does not have to interpret an error to know whether something was published.
 */
export async function publishGeneration(options: PublishOptions): Promise<PublishReport> {
  const clock = options.now ?? (() => new Date());
  const connectionString = options.connectionString ?? loadDbConfig().databaseUrl;
  const client = new Client({ connectionString });
  await client.connect();

  let locked = false;
  try {
    locked = (await client.query<{ ok: boolean }>('SELECT cat_projection_publish_lock() AS ok')).rows[0]?.ok === true;
    if (!locked) return emptyReport('concurrent-publisher');

    // ---------------------------------------------------------------------------------------------------
    // 1. Recovery. Nothing new is computed until the database and the directory agree.
    // ---------------------------------------------------------------------------------------------------
    const current = await currentGeneration(client);
    if (current !== null) {
      const { repaired, directorySynced } = recoverDirectory(options.manifestDir, current);
      if (repaired.length > 0) {
        // STOP HERE, deliberately. A daemon admits a successor only when its sequence is exactly one past the
        // one it is serving; publishing a successor in the same run as a repair could hand it a jump it must
        // refuse forever. The next run builds the successor, against a directory that is now correct.
        return emptyReport('recovered', {
          sequence: current.sequence,
          generationId: current.generation_id,
          artifactName: current.artifact_name,
          artifactBytes: current.artifact_bytes,
          manifestDigest: current.manifest_digest,
          contentDigest: current.content_digest,
          repaired,
          directorySynced,
        });
      }
    }

    // A generation whose bytes were committed by a run that then died. It is finished from those bytes.
    const orphan = await preparedSuccessor(client, current?.sequence ?? 0);
    if (orphan !== null) {
      const write = ensureArtifact(
        options.manifestDir, orphan.artifact_name, orphan.artifact, orphan.manifest_digest);
      await client.query('SELECT cat_projection_generation_publish($1)', [orphan.sequence]);
      const pointerWrite = writePointer(options.manifestDir, pointerFor(orphan));
      return emptyReport('resumed', {
        sequence: orphan.sequence,
        generationId: orphan.generation_id,
        artifactName: orphan.artifact_name,
        artifactBytes: orphan.artifact_bytes,
        manifestDigest: orphan.manifest_digest,
        contentDigest: orphan.content_digest,
        repaired: write === null ? ['pointer'] : ['artifact', 'pointer'],
        directorySynced: (write?.directorySynced ?? true) && pointerWrite.directorySynced,
      });
    }

    // ---------------------------------------------------------------------------------------------------
    // 2. One snapshot, one candidate, one prepared row — in one transaction.
    // ---------------------------------------------------------------------------------------------------
    let built: BuildResult;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      const snapshot = await readSnapshot(client);
      const previous = current === null ? null : previousFrom(current);
      if (current !== null && previous === null) {
        // The database holds a current generation whose own bytes do not validate. That is not something to
        // publish a successor on top of: the predecessor chain would be anchored to something inadmissible.
        await client.query('ROLLBACK');
        return emptyReport('refused', {
          sequence: current.sequence,
          generationId: current.generation_id,
          problems: [{ code: 'PUBLISHER_RECORDED_GENERATION_INVALID', at: 'predecessor' }],
        });
      }

      built = buildGeneration({
        snapshot,
        previous,
        nowIso: nowIsoOf(clock),
        intent: options.intent ?? 'routine',
        deletions: options.deletions ?? [],
        deletionGuardAcknowledged: options.deletionGuardAcknowledged ?? false,
        controlPlaneSchemaVersion: MIGRATION_VERSION,
      });

      if (!built.ok) {
        await client.query('ROLLBACK');
        return emptyReport('refused', {
          sequence: current?.sequence ?? null,
          generationId: current?.generation_id ?? null,
          snapshotDigest: built.snapshotDigest,
          problems: built.problems,
        });
      }
      if (built.unchanged) {
        await client.query('ROLLBACK');
        return emptyReport('unchanged', {
          sequence: built.sequence,
          generationId: built.generationId,
          artifactName: current?.artifact_name ?? null,
          artifactBytes: current?.artifact_bytes ?? null,
          manifestDigest: built.manifestDigest,
          contentDigest: built.contentDigest,
          snapshotDigest: built.snapshotDigest,
          entryCount: built.manifest?.entries.length ?? null,
        });
      }

      const manifest = built.manifest as ProjectionManifestV1;
      const artifact = built.artifact as Buffer;
      const artifactName = artifactNameFor(built.sequence, built.generationId as string);
      await client.query(
        `SELECT cat_projection_generation_prepare($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          built.sequence, built.generationId, manifest.generation.createdAt,
          manifest.generation.admission.intent, manifest.generation.admission.entryCount,
          [...manifest.generation.admission.deletions],
          manifest.generation.admission.deletionGuardAcknowledged,
          manifest.generation.admission.deletionGuardDigest,
          manifest.generation.predecessor?.generationId ?? null,
          manifest.generation.predecessor?.sequence ?? null,
          manifest.generation.predecessor?.manifestDigest ?? null,
          built.snapshotDigest, built.contentDigest, artifactName, artifact, built.manifestDigest,
        ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    const artifactName = artifactNameFor(built.sequence, built.generationId as string);
    const artifact = built.artifact as Buffer;
    if (options.fault === 'after-prepare') throw new PublishFaultInjected('after-prepare');

    // 3. The artifact, under a name no reader watches.
    const artifactWrite = ensureArtifact(
      options.manifestDir, artifactName, artifact, built.manifestDigest as string);
    if (options.fault === 'after-artifact') throw new PublishFaultInjected('after-artifact');

    // 4. THE COMMIT POINT. After this the control plane's answer to "what should be served" has changed.
    await client.query('SELECT cat_projection_generation_publish($1)', [built.sequence]);
    if (options.fault === 'after-db-pointer') throw new PublishFaultInjected('after-db-pointer');

    // 5. The pointer, last.
    const pointerWrite = writePointer(options.manifestDir, {
      generationId: built.generationId as string,
      sequence: built.sequence,
      artifactName,
      artifactBytes: artifact.length,
      manifestDigest: built.manifestDigest as string,
    });

    return {
      outcome: 'published',
      sequence: built.sequence,
      generationId: built.generationId,
      artifactName,
      artifactBytes: artifact.length,
      manifestDigest: built.manifestDigest,
      contentDigest: built.contentDigest,
      snapshotDigest: built.snapshotDigest,
      entryCount: built.manifest?.entries.length ?? null,
      additions: built.additions.length,
      deletions: built.deletions.length,
      problems: [],
      repaired: [],
      directorySynced: (artifactWrite?.directorySynced ?? true) && pointerWrite.directorySynced,
    };
  } finally {
    if (locked) await client.query('SELECT cat_projection_publish_unlock()').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

/**
 * Report what the database and the directory currently say, without changing either.
 *
 * A read-only surface: an operator asking "what is published" must never be a thing that publishes.
 */
export async function publishStatus(options: { manifestDir: string; connectionString?: string }): Promise<{
  readonly dbSequence: number | null;
  readonly dbGenerationId: string | null;
  readonly pointerSequence: number | null;
  readonly pointerGenerationId: string | null;
  readonly artifactPresent: boolean;
  readonly preparedSequences: readonly number[];
  readonly agrees: boolean;
}> {
  const connectionString = options.connectionString ?? loadDbConfig().databaseUrl;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const current = await currentGeneration(client);
    const prepared = (await client.query(
      `SELECT sequence FROM public.projection_generations WHERE state = 'prepared' ORDER BY sequence`))
      .rows.map((row) => Number(row.sequence));
    const pointer = readPointer(options.manifestDir);
    const artifactPresent = current !== null
      && artifactMatches(options.manifestDir, current.artifact_name, current.artifact_bytes, current.manifest_digest);
    return {
      dbSequence: current?.sequence ?? null,
      dbGenerationId: current?.generation_id ?? null,
      pointerSequence: pointer?.sequence ?? null,
      pointerGenerationId: pointer?.generationId ?? null,
      artifactPresent,
      preparedSequences: prepared,
      agrees: current !== null && pointer !== null && artifactPresent
        && pointer.generationId === current.generation_id && pointer.sequence === current.sequence,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
