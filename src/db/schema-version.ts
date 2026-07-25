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
export const MIGRATION_VERSION = 4;

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
