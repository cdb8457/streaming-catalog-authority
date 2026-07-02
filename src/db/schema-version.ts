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
export const MIGRATION_VERSION = 3;
