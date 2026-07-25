# Phases 255–257 — plan

Three phases, one arc: **an operator who can diagnose their install, knows what a complete backup is, and can
tell whether the backup they hold is still a rollback point.**

The audience is the one `v1.1.1`/`v1.1.2` were written for: somebody running the published image under Docker
Compose or Arcane on Unraid, with no Node.js toolchain, no source checkout, and no ability to run
`npm run …` outside a container.

## Why these three

Phases 245–254 made the product *installable* by a stranger. What they did not close:

1. **The support report is unreachable by its own audience.** Phase 246 built
   `operator-ui-support-report.ts` explicitly as "the report a person pastes into an issue", and the only way
   to obtain it is `npm run ops:support-report` — which needs a toolchain the release bundle deliberately does
   not ship. The artifact designed for a person in trouble cannot be produced by a person in trouble.
2. **The backup instructions the operator actually reads omit half the backup.** The UI first-run checklist's
   `back-up` step names the database and `./secrets/`. It does not name the **keystore volume**, which holds
   the wrapped DEKs. `docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md` mentions the keystore in its Backup
   section and then omits it again from its own Upgrade checklist. A restore performed from the documented
   backup produces a database nothing can decrypt.
3. **Nothing tells an operator whether the backup they hold is still usable.** Rollback depends on a dump
   taken *before* the migration. There is no way to look at a dump and find out which schema version it holds,
   so "restore the pre-upgrade backup" is advice nobody can check.

## Phase 255 — the support report, in the authenticated UI

* `GET /api/support-report`, behind the same operator token as every other operational route.
* The redaction assertion runs **server-side over the bytes about to be sent**; a rejection is a `503` with a
  fixed message, never a partial report.
* A Support report panel with a Copy button, and an honest fallback where the Clipboard API is unavailable
  (it is, over plain HTTP to a LAN address — a real Unraid configuration).

## Phase 256 — what a complete backup actually is

* `src/ops/backup-components.ts`: the canonical component model — database, secrets, keystore — with what each
  is, what is lost without it, and the exact commands, per platform, that a Docker-only operator can run.
* **Coverage enforced against the shipped Compose stacks.** A stack that gains a named volume or a secret and
  does not classify it as backup-required or explicitly regenerable fails a test. That is the anti-regression
  for the class of defect this phase fixes: a volume existed that nobody's backup instructions mentioned.
* The checklist step, a new Backup & restore panel, the support report and the lifecycle doc all render from
  the one model, so they cannot disagree again.

## Phase 257 — is the backup you have still a rollback point?

* `ops:backup-inspect`: reads a backup directory **offline** — no database, no network, no live anything — and
  reports which components are present and which schema version a plain-format dump holds.
* Fail-closed verdicts. A custom-format dump is `INDETERMINATE`, not "probably fine". Two disagreeing
  `schema_meta` rows are `AMBIGUOUS`. A dump larger than the scan bound is `INDETERMINATE` and says so.
* The Backup & restore panel carries the exact command to run it, per platform.

## Boundaries

No promotion, no approval, no execution, no Phase 231 anything. No provider, media server or library is
contacted. No live Unraid host is touched. Nothing is published, tagged, released, deployed or pushed.
