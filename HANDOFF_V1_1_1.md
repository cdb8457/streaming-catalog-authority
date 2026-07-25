# v1.1.1 handoff — first-run remediation

Commits `63624c0`, `5e229ef`, `82e9c32` on `cdb8457/v1-1-1-arcane-first-run`, branched from `22a78b9`. PR
[#23](https://github.com/cdb8457/streaming-catalog-authority/pull/23) → `master`. **Not merged, not tagged,
not published.**

**Real CI on the head commit `6632eee` is GREEN** — all six jobs pass, publish correctly skipped
([run 30138799435](https://github.com/cdb8457/streaming-catalog-authority/actions/runs/30138799435)). The two
preceding commits (`82e9c32`, `3e67db5`) were also independently green.

---

## The four defects, and what was done

### 1. Migration missing from first run

`ops:bootstrap` (`src/ops/bootstrap.ts`, `bootstrap-cli.ts`) is a new one-shot, run by a `migrate` service in
**all four stacks that start an operator UI** — `docker-compose.runtime.yml`, `docker-compose.arcane.yml`,
`docker-compose.unraid.yml`, `docker-compose.unraid.runtime.yml` — each gated by
`depends_on: { migrate: { condition: service_completed_successfully } }` and each setting
`OPERATOR_UI_HEALTHZ_REQUIRES_SCHEMA=1`.

> The two Unraid stacks were **missed in the first pass** and fixed in a second. Both had a one-shot `ops`
> container defaulting to `ops:migrate` that nothing ever ran at startup — the launcher runbook's own
> `up -d postgres app sidecar` never included it — so they still carried the exact defect this phase closes.
> `test/first-run-migration.ts` now enumerates all four stacks by name rather than globbing, so an omission
> of this kind is visible in the list rather than hidden by a pattern. The manual `ops` service is preserved
> in both, and a test asserts nothing gates startup on it.

- **Idempotent**: every statement is `IF NOT EXISTS` / `CREATE OR REPLACE` / a privilege statement.
- **Concurrency-safe**: session-level advisory lock (`MIGRATION_ADVISORY_LOCK_KEY`), acquired with
  `pg_try_advisory_lock` on a deadline — a blocked migration fails closed with
  `BOOTSTRAP_MIGRATION_LOCK_UNAVAILABLE` rather than hanging.
- **Verified**: recorded version + expected relations read back; then a connection as the **least-privileged
  runtime role** confirms that role can read the applied version. That last step is the one that would have
  caught the original defect.
- **Diagnosable**: eight stable failure codes, each with a fixed sentence. No secret, connection string or
  host path in any of them.
- **Second line**: `/healthz` answers 503 until the schema is present when
  `OPERATOR_UI_HEALTHZ_REQUIRES_SCHEMA=1` (shipped stacks set it; default off so DB-less harnesses and
  liveness probes are unaffected). Probes are coalesced and rate-limited so an unauthenticated route cannot be
  used to amplify requests into database connections.
- **Rollback honesty**: unchanged — no down-migrations. `docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md`
  states the limit and the per-version schema table.

### 2. False NEEDS_SETUP / "dependency not ready"

- `EMPTY` records → new severity `AWAITING_EVIDENCE`; `MISSING` stays `SETUP_REQUIRED` (a wrong mount really
  is unfinished setup). New verdict `READY_NO_RECORDS`, rendered **READY - NO RECORDS LOADED**, not styled as
  a green pass.
- New `evidence: LOADED | NONE_LOADED` + `evidenceNote`, on both `/api/installation` and the support report,
  explicitly ruling out: passing audit, authorization, phase completion, Phase 231 result.
  `promotionAuthorization: NOT_IMPLIED` unchanged.
- `/api/status`'s 503 is now rendered instead of thrown: the Status panel and Needs Attention list the failing
  checks **by name**, and the banner points at that panel.

**Latent bug found and fixed:** `probeDatabase` read `schema_meta` over `DATABASE_URL`, which
`migrations.sql` revokes from the `app` role — so any correctly least-privileged deployment reported
`SCHEMA_MISSING` against a migrated database forever. Schema **v3 → v4** adds `cat_schema_version()` (owner-
defined, granted to `app`) and `set_app_role_password()` (owner-only). Setup scripts now generate an
`app_password` and point `database_url` at the `app` role, so `ops:doctor`'s `runtime-least-privileged` passes
because it is true. **Existing installs are unchanged** — a setup re-run never regenerates a secret; moving
across is documented and optional.

### 3. Arcane path resolution

`docker-compose.arcane.yml` — every bind source built from one **required** variable
`CATALOG_AUTHORITY_PROJECT_DIR` (Compose refuse-form, never a default). `deploy/arcane-setup.sh <abs host
path>` prepares the folder. `ops:arcane-preflight` validates before Docker has to, and reports a
`/app/data/...` path as `PROJECT_DIR_LOOKS_CONTAINER_INTERNAL` with **both** honest fixes (Arcane's
recommended matching `PROJECTS_DIRECTORY`, or naming the host path). No machine's path/IP/hostname anywhere —
asserted by test. Ordinary-computer release Compose behaviour unchanged.

### 4. LAN bind

Arcane stack **requires** `OPERATOR_UI_BIND_ADDRESS`, refuses `0.0.0.0`/`::`/`*` and hostnames; loopback is an
ADVISORY that says outright it is not remotely reachable and offers a tunnel.
**Both** Unraid stacks — `docker-compose.unraid.runtime.yml` and `docker-compose.unraid.yml` — now default to
`127.0.0.1` instead of publishing on every interface by omission. (The canonical one was missed in the first
pass; fixing the defect in one of the two places it lives is not fixing it.) **Fail-safe but a behaviour
change**, flagged in `RELEASE.md`.

---

## Verification

| | |
| --- | --- |
| Typecheck | clean |
| Full suite | **262 / 276 suites pass** locally (all 276 executed individually); green in CI |
| New adversarial suites | `test/first-run-migration.ts` 17/17, `test/arcane-install.ts` 24/24 |
| Phase 242–252 | phase242/243/244/245/246/247/248/249/250/251/252-local all pass |
| Release | delivery 26, readiness 41, verification 38, rehearsal 34, guard 10, versioned-cut 5 — all 0 failed |
| Bundle | assembles, archives, **VERIFIED** as `catalog-authority-operator-ui-v1.1.1.tar.gz` |
| `ops:release-readiness` | 20 pass, 0 block, 1 NOT_RUN (the `v1.1.1` tag — deliberately not created) |
| Compose | all seven files parse; `docker compose config` resolves every one, and the Arcane stack refuses without its required variables |

### The local skips are now closed by real CI

They could not run on this machine (no Docker daemon) and exited 3 on the documented SKIP path. All of them
have since run for real on `82e9c32` and passed:

| CI job | Result |
| --- | --- |
| Typecheck and Phase 242-253 suites | success |
| Build and smoke the production image | success |
| Release-candidate acceptance (real browser, real Compose) | success |
| Release lifecycle acceptance (fresh, restart, upgrade, rollback) | success |
| Assemble and validate the release bundle | success |
| Final first-release rehearsal and handoff (Phase 252) | success |
| Publish the release image and asset | **skipped** (correct — nothing is published from a PR) |

The daemon-backed smoke log confirms the new assertions actually executed rather than being skipped:
`migrate exited 0 having verified the runtime connection can read the schema`, `a working install with an
empty records folder reports READY_NO_RECORDS`, `and states what an empty folder does NOT mean`, `the
database was reached AND is migrated to the version this build requires`.

### The one CI failure, and what it taught

The first CI run failed `Build and smoke the production image` on `the readiness route returned no bounded
state`: the shell smoke carried its own hard-coded list of three verdicts and Phase 253 added a fourth.

More interesting were the two surfaces that did **not** go red. The browser acceptance spec matched
`/READY|NEEDS_SETUP|DEGRADED/` against a badge reading `READY - NO RECORDS LOADED` and passed **on the
prefix** — asserting nothing while looking green. Four places independently enumerated a set the type system
owns, and a type cannot reach a shell script.

Fixed at the root: `INSTALLATION_STATES` is now data with the type derived from it, and a test walks it
against every surface that enumerates states. The acceptance spec's pattern is anchored so the set is closed.
Both new guards were mutation-checked — reverting each fix makes them fail.

### One CI attempt stalled — investigated, not reproducible

The first attempt at the head commit hung in `Typecheck and Phase 242-253 suites` for over 20 minutes; the
same step takes ~70 seconds. It was cancelled and re-run, and completed in 83 seconds. That commit changes
only a shell script, and the run's other four jobs had already passed on the first attempt.

It was not taken on trust: all thirteen suites in that step were re-run individually on this machine and every
one completed in bounded time (phase253 80s, phase244 68s, phase245 57s, the rest under 30s each), and the
retried CI job passed. Read as a runner-side stall. If it recurs, the place to look first is
`test/first-run-migration.ts`, which is the only suite in that step that boots a database.

### Pre-existing failures (NOT introduced here)

14 suites fail identically at `22a78b9` on this Windows checkout — each baselined by stashing:

`torbox-boundary`, `torbox-fake-adapter`, `torbox-real-client-gate`, `torbox-readonly-client`,
`torbox-provider-adapter`, `torbox-transport-acceptance`, `torbox-live-transport`, `torbox-live-smoke-cli`
(all one assertion: a path-normalisation allowlist that keeps Windows backslashes, so `rel` never matches);
`launch-readiness-pass`, `working-foundation-plan`, `real-library-promotion-boundary`, `deploy`,
`scheduled-doctor-alert-fix` (assertions embedding a literal `\n` against CRLF-checkout files);
`jellyfin-outbox`. Linux CI (green on master) is unaffected. Not fixed — out of scope and no-ops on Linux.

`npm test` itself cannot run on Windows: the aggregate command line is ~11.7 KB against cmd.exe's 8191-char
limit. Pre-existing; the 276 entries were run individually instead.

---

## Boundaries kept

Not published, no tag created or moved, PR not merged, v1.1.0 image untouched.
`deploy/unraid-real-library-promotion.sh` not run. `/mnt/user/media/Movies` untouched. No live Jellyfin or
provider call. Phase 231 neither authorized nor executed. The isolated Unraid project at
`/mnt/user/projects/catalog-authority-v110-test` was not contacted, mutated or upgraded by this work.

## For the reviewer

Highest-value things to check: the `evidence` semantics in
`src/ops/operator-ui-installation-readiness.ts` (does `READY_NO_RECORDS` ever read as a pass?); the
`set_app_role_password` SQL in `src/db/migrations.sql` (role name is a fixed literal, password `%L`-quoted);
and the `docker-compose.unraid.runtime.yml` bind-address default, which is the one change that can surprise a
working installation.
