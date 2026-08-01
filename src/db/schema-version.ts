/**
 * Phase 6 — current DB migration/schema generation.
 *
 * `ops:migrate` writes this into `schema_meta.version` (via the owner-only `set_schema_version()`),
 * and `ops:doctor` fails if the deployed DB's version differs from this constant. Bump it by one on
 * ANY schema-affecting migration. This is distinct from the crypto envelope `SCHEMA_VERSION`.
 *
 * Rollback model (accepted): there are no down-migrations — the supported rollback is to restore
 * the pre-upgrade backup (see docs/PHASE_6_LIFECYCLE.md / RELEASE_CHECKLIST.md).
 */
// v2 (Phase 9): adds the identity-free publish_ledger + cat_publish_* functions.
// v3 (Phase 12): extends publish_ledger into a durable publish-intent outbox (correlation_token,
//                nullable external_handle, intent states) + cat_publish_plan/settle/etc.
// v4 (Phase 253): adds cat_schema_version() (app-readable applied version, so the first-run readiness
//                probe works over the least-privileged role) + set_app_role_password() (owner-only, so a
//                deployment can hold a generated runtime credential instead of a placeholder).
// v5 (Phase 261): publish_ledger records what each create PROVED about recovery-by-token
//                (recovery_proof/recovery_proof_at + cat_publish_record_recovery), so a reconciler in a
//                different process than the publisher can tell "the token found nothing because nothing
//                is there" from "the token finds nothing at all" — the difference between recovering and
//                creating a duplicate external copy.
// v6 (Phase 264): adds the durable, identity-free import_history table + cat_import_record, so an operator
//                who applies an import from the browser can still answer "what did I already load, and
//                when?" after the container that served the page has been replaced.
// v7 (Phase 267/268): adds the durable, identity-free collection_control_history table +
//                cat_collection_record, so the plan an operator previewed, the plan they queued into the
//                publish outbox, and every reconcile and revoke that followed are answerable after the
//                container that served the page has been replaced.
// v8 (Phase 268 review remediation): makes one active publish intent per (item_id,target) a database
//                invariant and adds an atomic insert-if-absent command, closing concurrent execute races.
// v9 (Phase 269): the MANAGED COLLECTION — one accepted operator plan is one external collection holding the
//                selected records, rather than N records becoming N collections. Adds managed_collections
//                (durable plan/collection identity, lifecycle, correlation token, recovery proof) and
//                managed_collection_members (opaque catalog ids and their state), with the same
//                one-active-row-per-identity database invariant the per-item outbox has. The v8 per-item
//                publish_ledger rows are NOT migrated, reinterpreted or touched: they remain per-item
//                collections, still tracked, still revocable, and are reported as legacy wherever they matter.
// v10 (Projection Phase 1): the PROJECTION SOURCE REGISTRY and the published-generation ledger. The manifest
//                names an exact byte length, an mtime, a stable source descriptor and a visibility state per
//                entry, and nothing in v9 can answer any of them — `items` holds an opaque id and an encrypted
//                identity blob, with no file, size, path or locator anywhere in it. Rather than let a
//                publisher guess (a guessed size is a file a media server cannot play), the gap is closed with
//                the narrowest boundary that keeps the control plane authoritative: projection_source_roots,
//                projection_versions, projection_entries and projection_entry_sources are asserted through
//                cat_projection_* commands, and projection_generations + projection_pointer hold the exact
//                published artifact bytes, their digest and which generation is current — which is what makes
//                recovery after a crash a rewrite of committed bytes rather than a reconstruction. No access
//                URL, token, header, expiry or lease can be stored in any of them, by CHECK.
export const MIGRATION_VERSION = 10;

/**
 * The advisory-lock key `ops:bootstrap` serialises on.
 *
 * Two containers starting at once — a `docker compose up -d` that races its own restart policy, an operator
 * re-running setup while the stack is coming up, or a scale-2 launcher — would otherwise run migrations.sql
 * concurrently. Most of it is `IF NOT EXISTS`/`OR REPLACE` and would survive that, but not all of it: two
 * sessions racing `CREATE ROLE` or `CREATE OR REPLACE FUNCTION` on the same object deadlock or error, and a
 * half-applied migration that then reports success is the failure mode this whole phase exists to prevent.
 *
 * The value is arbitrary but must never change: it is the identity of the lock, and a changed key means an
 * old container and a new one would not see each other. It is session-scoped (not xact-scoped) because the
 * migration runs as one implicit transaction and the lock has to outlive it to cover the verification read.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 0x4341_0253;
