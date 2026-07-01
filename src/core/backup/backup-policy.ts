import type { Client } from 'pg';

/**
 * Stage 3b — encrypted backup / restore policy.
 *
 * A "main-DB backup" carries CIPHERTEXT and key-control state ONLY. It must never contain
 * decryptable key material, so the cryptographic-erasure guarantee survives any restore:
 * a backup of the database alone cannot resurrect a shredded identity, because the key that
 * could decrypt the surviving ciphertext lives outside the database and is destroyed on forget.
 *
 * What IS backed up (see {@link BACKED_UP_TABLES}):
 *   - events            the append-only log (structural + behavioral; expiry enforced on replay)
 *   - items             projection incl. identity_ct (CIPHERTEXT only — never plaintext)
 *   - provider_refs     projection incl. ref_value_ct (CIPHERTEXT only)
 *   - item_key_control  key *labels* + shred lifecycle (key_id is an opaque id, NOT key material)
 *   - aborted_operations the durable TOCTOU abort fence
 *
 * What is DELIBERATELY EXCLUDED (see {@link EXCLUDED_FROM_BACKUP}) — none of it is in the DB
 * tables above, and this policy guarantees it never leaks into the artifact:
 *   - the FileCustodian KEYSTORE (wrapped DEKs) — lives on a separate filesystem / volume
 *   - the KEK                                   — lives in the custodian process / managed KMS
 *   - crypto_config.completion_secret           — the HMAC attestation secret (its own table)
 *
 * At-rest confidentiality: the operator MUST additionally encrypt the emitted artifact at rest
 * (storage-level encryption, or a `pg_dump | age`/`gpg` pipeline). That is defense-in-depth;
 * the erasure guarantee itself rests on the key-material EXCLUSION above, not on encrypting the
 * backup. This module does not encrypt the artifact — adding a backup-encryption key here would
 * be one more key to manage and is orthogonal to crypto-shredding, so it is left to the operator.
 *
 * External restore prerequisites (out-of-band; NOT carried in the artifact):
 *   1. provision the KEK into the custodian, and
 *   2. set crypto_config.completion_secret to the value shared with the external custodian.
 * Restoring the main-DB backup ALONE yields a fail-closed system: identity reads deny (the
 * custodian/KEK is absent) and shred completions cannot verify (the secret is absent) until an
 * operator supplies both. That is by design.
 *
 * Scope note: like FileCustodian, this is a reference harness — a logical, self-contained
 * dump/restore over the existing connection, suitable for tests and small deployments. It is
 * NOT a cloud-provider backup integration (no S3/GCS/PITR shipping code is scaffolded here);
 * the production target remains a managed-KMS deployment (design O4, still open).
 */

/** Tables carried in a main-DB backup — the single source of truth for what gets dumped. */
export const BACKED_UP_TABLES = [
  'events',
  'items',
  'provider_refs',
  'item_key_control',
  'aborted_operations',
] as const;

export type BackedUpTable = (typeof BACKED_UP_TABLES)[number];

/** Material deliberately kept OUT of every main-DB backup, with why. */
export const EXCLUDED_FROM_BACKUP = {
  crypto_config: 'completion secret — shared out-of-band with the external custodian; its own table is never dumped',
  filecustodian_keystore: 'wrapped DEKs — live on a separate filesystem/volume, never in the DB',
  kek: 'key-encryption key — lives in the custodian process / managed KMS, never in the DB',
} as const;

/** Only an IDENTITY column needs OVERRIDING SYSTEM VALUE on restore. */
const IDENTITY_TABLES = new Set<BackedUpTable>(['events']);

export interface TableDump {
  table: BackedUpTable;
  /** Rows as produced by `to_jsonb(row)`; bytea is hex-encoded, never raw key material. */
  rows: unknown[];
}

export interface BackupArtifact {
  version: 1;
  /** Optional non-secret label (e.g. a caller-supplied timestamp). Never holds key material. */
  label?: string;
  tables: TableDump[];
}

/** Raised when a restore is refused because the artifact is internally inconsistent. */
export class BackupIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupIntegrityError';
  }
}

export class BackupPolicy {
  static readonly BACKED_UP_TABLES = BACKED_UP_TABLES;
  static readonly EXCLUDED_FROM_BACKUP = EXCLUDED_FROM_BACKUP;

  /**
   * Produce a logical, ciphertext-only backup of the main DB. `crypto_config` (the completion
   * secret) is NOT in {@link BACKED_UP_TABLES}, so it is never read or emitted; the keystore and
   * KEK are not in the DB at all. Requires the owner/migrator connection (read access to the
   * projection + log).
   *
   * TRANSACTIONAL CONSISTENCY: all tables are read inside a single `REPEATABLE READ READ ONLY`
   * transaction, so the whole artifact is one point-in-time snapshot (the same guarantee a
   * `pg_dump` gives). Without this, a writer committing between two of the per-table reads could
   * tear the artifact — e.g. `items`/`item_key_control` reflecting an event the dumped `events`
   * does not contain. The snapshot is acquired on the first read and held until COMMIT.
   */
  static async dump(admin: Client, label?: string): Promise<BackupArtifact> {
    await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const tables: TableDump[] = [];
      for (const table of BACKED_UP_TABLES) {
        // ORDER BY a stable key so the artifact is deterministic; to_jsonb keeps bytea as hex.
        const orderBy = table === 'events' ? 'ORDER BY seq' : '';
        const { rows } = await admin.query(
          `SELECT coalesce(jsonb_agg(to_jsonb(t) ${orderBy}), '[]'::jsonb) AS data FROM ${table} t`,
        );
        tables.push({ table, rows: rows[0].data as unknown[] });
      }
      await admin.query('COMMIT');
      return { version: 1, label, tables };
    } catch (err) {
      await admin.query('ROLLBACK');
      throw err;
    }
  }

  /**
   * OFFLINE structural verification of a backup artifact (Phase 6) — no DB required. Catches the
   * torn/tampered/corrupt classes that would otherwise be caught at restore time: unsupported
   * version, a missing backed-up table, an item projection head (`last_seq`) not backed by an event
   * in the same artifact, and dangling `provider_refs` / `item_key_control` referencing a missing
   * item. This is a fast pre-restore sanity check; the FULL replay-and-compare derivability proof
   * requires a database — use `ops:rehearse-restore` for that. Never reads/needs any secret.
   */
  static verifyStructure(artifact: BackupArtifact): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    if (!artifact || (artifact as { version?: unknown }).version !== 1) {
      return { ok: false, problems: [`unsupported or missing artifact version (expected 1)`] };
    }
    const byName = new Map((artifact.tables ?? []).map((t) => [t.table, t.rows]));
    for (const tbl of BACKED_UP_TABLES) if (!byName.has(tbl)) problems.push(`missing backed-up table: ${tbl}`);
    if (problems.length > 0) return { ok: false, problems };

    const events = byName.get('events') as Array<{ item_id: string; seq: number }>;
    const items = byName.get('items') as Array<{ id: string; last_seq: number }>;
    const refs = byName.get('provider_refs') as Array<{ item_id: string }>;
    const keys = byName.get('item_key_control') as Array<{ item_id: string }>;
    const haveEvent = new Set(events.map((e) => `${e.item_id}#${e.seq}`));
    const itemIds = new Set(items.map((i) => i.id));

    for (const i of items) {
      if (i.last_seq > 0 && !haveEvent.has(`${i.id}#${i.last_seq}`)) problems.push(`item ${i.id}: head seq ${i.last_seq} is not backed by an event in the artifact (torn)`);
    }
    for (const r of refs) if (!itemIds.has(r.item_id)) problems.push(`provider_refs references a missing item ${r.item_id}`);
    for (const k of keys) if (!itemIds.has(k.item_id)) problems.push(`item_key_control references a missing item ${k.item_id}`);
    return { ok: problems.length === 0, problems };
  }

  /**
   * Restore a backup into the main DB, replacing the backed-up tables. crypto_config is left
   * untouched — the operator-provisioned completion secret is an external prerequisite, never
   * part of the backup. Runs in one transaction under `session_replication_role = replica` so
   * the append-only / FK triggers do not block a faithful reload (the SAME mechanism the test
   * harness uses to reset). Requires the owner/superuser connection.
   *
   * INTEGRITY GATE: because the reload disables the append-only/FK enforcement, a torn or
   * tampered artifact would otherwise be ingested silently. After loading (still inside the
   * transaction) the projection is re-checked against the event log; any inconsistency throws
   * {@link BackupIntegrityError} and the whole restore is ROLLED BACK, leaving the DB untouched.
   *
   * IMPORTANT: a restore does NOT re-supply key material. If the custodian/KEK or the completion
   * secret are absent, the restored system is fail-closed by design — reads deny and shred
   * completions cannot verify until those out-of-band prerequisites are provisioned.
   */
  static async restore(admin: Client, art: BackupArtifact): Promise<void> {
    if (art.version !== 1) throw new Error(`unsupported backup artifact version ${String(art.version)}`);
    const byName = new Map(art.tables.map((t) => [t.table, t]));
    for (const table of BACKED_UP_TABLES) {
      if (!byName.has(table)) throw new Error(`backup artifact missing table ${table}`);
    }

    await admin.query('BEGIN');
    try {
      await admin.query("SET session_replication_role = 'replica'");
      await admin.query(
        `TRUNCATE ${BACKED_UP_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
      );
      for (const table of BACKED_UP_TABLES) {
        const dump = byName.get(table)!;
        const overriding = IDENTITY_TABLES.has(table) ? 'OVERRIDING SYSTEM VALUE' : '';
        await admin.query(
          `INSERT INTO ${table} ${overriding}
             SELECT * FROM jsonb_populate_recordset(null::${table}, $1::jsonb)`,
          [JSON.stringify(dump.rows)],
        );
      }
      // Realign the events identity sequence so future appends don't collide with restored seqs.
      await admin.query(
        `SELECT setval(pg_get_serial_sequence('events', 'seq'),
                       GREATEST((SELECT max(seq) FROM events), 1))`,
      );
      await BackupPolicy.assertConsistent(admin);          // refuse a torn/tampered artifact
      await admin.query("SET session_replication_role = 'origin'");
      await admin.query('COMMIT');
    } catch (err) {
      await admin.query('ROLLBACK');
      throw err;
    }
  }

  /**
   * Post-restore integrity gate (runs inside the restore transaction). Refuses any artifact whose
   * projection is not derivable from its own event log — the signature of a torn (non-snapshot)
   * dump or a tampered artifact.
   *
   *   (1) item_key_control references an existing item. Key-control is INDEPENDENT of the
   *       event-sourced projection (it survives rebuild, no FK), so it is not part of the replay
   *       comparison below; this referential check is its consistency requirement.
   *   (2) REPLAY-AND-COMPARE: re-fold the restored events with the REAL reducer (`cat_rebuild`)
   *       inside a SAVEPOINT, and compare the resulting STRUCTURAL projection — items
   *       (present, forgotten, last_seq) and provider_refs (present per item+type) — against the
   *       restored one. Any divergence (a projection/ref row not reproduced by the log, or an
   *       event-implied row missing from the projection) is rejected. This subsumes per-item head
   *       checks and also catches refs/forgotten/restored state that head-only checks miss
   *       (e.g. a `provider_refs` row whose `ProviderRefAttached` event was removed while a later
   *       behavioral event still satisfies `last_seq`). `behavioral_score` is intentionally NOT
   *       compared: it is cutoff/time-dependent and is re-derived on the operator's next rebuild,
   *       so it is not a durable derivability invariant.
   *
   * The scratch rebuild is rolled back to the SAVEPOINT, so the restored data (including
   * identity_ct, which a rebuild clears) is left intact for COMMIT. A violation throws
   * {@link BackupIntegrityError}, which the caller turns into a full ROLLBACK.
   */
  private static async assertConsistent(admin: Client): Promise<void> {
    const danglingKeys = Number(
      (await admin.query(
        `SELECT count(*) AS c FROM item_key_control k
          WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = k.item_id)`,
      )).rows[0].c,
    );
    if (danglingKeys > 0) {
      throw new BackupIntegrityError(`restore refused: ${danglingKeys} item_key_control row(s) reference a missing item (projection torn ahead of the log)`);
    }

    const loaded = await BackupPolicy.snapshotProjection(admin);
    let replay: ProjectionSnapshot;
    await admin.query('SAVEPOINT backup_replay');
    try {
      // The replay rebuild must run with FK enforcement ON so `DELETE FROM items` cascades and
      // clears provider_refs; otherwise the loaded (possibly tampered) ref rows would survive the
      // rebuild and falsely match. The surrounding restore runs under replica (FK off) for the
      // bulk load, so flip it back to 'origin' just for this scratch replay. SET LOCAL is reverted
      // by the ROLLBACK TO SAVEPOINT below (back to the load-time 'replica').
      await admin.query("SET LOCAL session_replication_role = 'origin'");
      await admin.query('SELECT cat_rebuild(now())'); // re-fold structural state from the restored events
      replay = await BackupPolicy.snapshotProjection(admin);
    } finally {
      // discard the scratch rebuild; restore the loaded projection (incl. identity_ct) for COMMIT
      await admin.query('ROLLBACK TO SAVEPOINT backup_replay');
      await admin.query('RELEASE SAVEPOINT backup_replay');
    }
    BackupPolicy.assertProjectionsMatch(loaded, replay);
  }

  /** Structural projection columns only — deterministic from the event log (no time dependence). */
  private static async snapshotProjection(admin: Client): Promise<ProjectionSnapshot> {
    const items = (await admin.query(
      'SELECT id, present, forgotten, last_seq::text AS last_seq FROM items',
    )).rows as Array<{ id: string; present: boolean; forgotten: boolean; last_seq: string }>;
    const refs = (await admin.query(
      'SELECT item_id, ref_type, present FROM provider_refs',
    )).rows as Array<{ item_id: string; ref_type: string; present: boolean }>;
    return {
      items: new Map(items.map((r) => [r.id, `${r.present}|${r.forgotten}|${r.last_seq}`])),
      refs: new Map(refs.map((r) => [`${r.item_id}#${r.ref_type}`, String(r.present)])),
    };
  }

  private static assertProjectionsMatch(loaded: ProjectionSnapshot, replay: ProjectionSnapshot): void {
    for (const [id, v] of loaded.items) {
      if (!replay.items.has(id)) throw new BackupIntegrityError(`restore refused: item ${id} is not derivable from the event log (no creating event)`);
      if (replay.items.get(id) !== v) throw new BackupIntegrityError(`restore refused: item ${id} projection (present/forgotten/last_seq) does not match an event-log replay`);
    }
    for (const id of replay.items.keys()) {
      if (!loaded.items.has(id)) throw new BackupIntegrityError(`restore refused: the event log implies item ${id} that the restored projection is missing`);
    }
    for (const [k, v] of loaded.refs) {
      if (!replay.refs.has(k)) throw new BackupIntegrityError(`restore refused: provider ref ${k} is in the projection but not derivable from the event log`);
      if (replay.refs.get(k) !== v) throw new BackupIntegrityError(`restore refused: provider ref ${k} presence does not match an event-log replay`);
    }
    for (const k of replay.refs.keys()) {
      if (!loaded.refs.has(k)) throw new BackupIntegrityError(`restore refused: the event log implies provider ref ${k} missing from the restored projection`);
    }
  }
}

interface ProjectionSnapshot {
  /** item id -> "present|forgotten|last_seq" */
  items: Map<string, string>;
  /** "item_id#ref_type" -> "present" */
  refs: Map<string, string>;
}
