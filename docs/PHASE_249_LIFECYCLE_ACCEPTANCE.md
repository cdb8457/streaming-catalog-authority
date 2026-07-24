# Phase 249 — real Docker Compose lifecycle acceptance

Phase 248 proved a *fresh* release candidate works in a real browser against a real Compose stack. Phase 249
proves the **lifecycle** an ordinary self-hosted operator actually lives through — the sequence the bundle's
own README documents — against a real Compose stack, end to end:

1. **Fresh setup and start.** Extract the release bundle, run `setup.sh`, `docker compose up -d`.
2. **Authenticated health and version.** `/healthz` is 200; the authenticated `/api/version` reports the
   exact version running and that the image and the bundle **AGREE**.
3. **Read-only promotion-record visibility.** The mounted records folder is readable by the app and mounted
   **read-only** (verified by `docker inspect`).
4. **Persisted state.** The generated operator token and a seeded Postgres row survive.
5. **Graceful restart.** `docker compose restart app` — the token and the Postgres row are still there.
6. **Upgrade.** `docker compose down` (keeping volumes) → re-pin `CATALOG_AUTHORITY_IMAGE` /
   `CATALOG_AUTHORITY_BUNDLE_VERSION` in `.env` → `docker compose up -d`. The UI now reports the **candidate**
   version; the token, the Postgres row and the records are all intact.
7. **Rollback.** The same, back to the prior version. The UI reports the **prior** version again; nothing is
   lost.

It is an **acceptance gate, not a publish step**: it builds only local-only image tags, logs in to no
registry, pushes nothing, tags nothing, and uploads no asset. It runs in a fully **isolated** Compose project.

## What the prior-version fixture proves — and what it cannot

There is no genuine prior release yet. So the "prior version" here is **the same source, built with a
different version label** (`v0.9.0-fixture`) and a local-only tag. This is deliberately honest about its
limits:

* **It proves the lifecycle *mechanics*.** Changing the image pin in `.env` and running `docker compose down`
  then `up` preserves the named volumes (`pgdata`, `keystore`), the `./secrets` folder and the
  `./promotion-records` folder; the UI reports the version it is actually running; and the documented upgrade
  and rollback lose no secrets, data or artifacts. Those are real properties, proven against a real stack.
* **It cannot prove real cross-version database *schema* migration.** Both images carry identical schema and
  migration code, so nothing is actually migrated between them. A genuine "upgrade preserves data across a
  schema change" claim requires a **real prior release** to build the fixture from; **this test does not make
  that claim and must not be read as making it.** The bundle README is correspondingly honest: rolling the
  image back does not roll data back, and a schema change means restoring a backup.

When a real prior release exists, the fixture build step should point at that release's published image (or a
digest-pinned local build of it) instead of a re-labelled build of the current source, and this document
should be updated to claim the stronger property.

## Isolation

Nothing here shares state with the Phase 248 acceptance or with a real operator stack, and teardown can only
ever reach these resources:

* **Compose project:** `catalogauthority-lifecycle` (its own network and volumes) — distinct from Phase 248's
  `catalogauthority-local`.
* **Host port:** `8109` (not `8099`).
* **Image tags:** `catalog-authority-ops:lifecycle-prior` and `:lifecycle-candidate` (local-only).
* **Directories:** `dist/rc-lifecycle-{bundle,archive,staging,artifacts}` and a private `mktemp` extraction.

## Teardown, cancellation and partial failures

Teardown is **armed before every `up`** through the shared `rc_compose_up` helper
(`deploy/ci/acceptance/rc-teardown.sh`, reused from Phase 248), so a partial-up failure at **any** phase —
fresh, upgrade or rollback — still reaches the scoped `docker compose down -v` in the EXIT trap. The
between-phase `down` that an upgrade/rollback performs **keeps volumes** (no `-v`); only teardown removes
them. `INT`/`TERM` re-exit so the same cleanup runs on a cancelled run, and CI's `if: always()` step is the
outer net, scoped by label to this project and these two tags. The teardown is idempotent and can never touch
an unrelated Docker resource. This is exercised by a deterministic test that drives the real teardown library
through `up → keep-volumes-down → up(fail) → cleanup` with an injected compose failure and **no Docker
daemon**.

## Artifacts

Reusing the Phase 248 flow: diagnostics are written to a **staging** directory, the shared redaction gate
scans them, and only redaction-passed artifacts are **promoted** into the upload directory — which CI uploads
**only on failure**, with short retention. A redaction-gate failure (or a kill before it) leaves the upload
directory empty. Nothing suspect can be uploaded.

## Running it

**In CI:** the `lifecycle` job runs on every push and pull request, on `ubuntu-latest`, with
`REQUIRE_ACCEPTANCE=1`, so a missing daemon is a **hard failure** — CI never silently skips. It is a required
dependency of `publish`, alongside `suites`, `image`, `bundle` and `release-candidate`; because it carries no
`if:`, it runs on every event that can reach `publish`, and a failed or cancelled lifecycle blocks the
release.

**Locally**, on a Linux/macOS host **with a running Docker daemon**:

```
REQUIRE_ACCEPTANCE=1 npm run acceptance:release-lifecycle
```

**On a host without Docker** (for example the Windows workstation this was written on), the orchestrator
prints a clear **SKIP** and exits `3` — it never claims to have run:

```
npm run acceptance:release-lifecycle     # -> SKIP (exit 3): "NOT executed here ... CI-required"
```

The **focused static/contract suite always runs and always passes** without Docker:

```
npm run test:phase249-local
```

It validates the workflow wiring, the publish dependency, the orchestrator's isolation, the lifecycle it
exercises, the persistence checks, the honest fixture limitation, and — executed for real — the orchestrator's
skip/fail semantics and the arm-before-up teardown under an injected compose failure.

## Status

**The real lifecycle run is CI-required and runs on Linux.** At the time of writing it has **not** been
executed on the author's machine, which has no Docker daemon; the focused static/contract suite
(`test:phase249-local`) passes there and reports the real job as CI-required rather than pretending it ran.

## Troubleshooting

**The `lifecycle` job fails at "wait for /healthz".** The stack did not become healthy in the bounded window;
the job prints `docker compose ps` and the last log lines. Usual causes are the image failing its asset
self-check or Postgres not initialising.

**A version assertion fails after upgrade/rollback.** The UI reported a version that does not match the pin,
or the image and bundle disagree. Check that the `.env` re-pin set both `CATALOG_AUTHORITY_IMAGE` and
`CATALOG_AUTHORITY_BUNDLE_VERSION`.

**The Postgres marker or token was lost across a down/up.** That is a real regression in the persistence
contract: `docker compose down` (without `-v`) must keep the named volumes, and `./secrets` is a host bind
mount. If the marker vanished, something removed the `pgdata` volume — check that no step ran `down -v` except
teardown.

**The orchestrator SKIPs locally with exit 3.** Expected without a Docker daemon. Start Docker and re-run with
`REQUIRE_ACCEPTANCE=1`, or rely on the CI job. A SKIP is never a pass.

## Boundaries

No image is published, no tag created, no branch merged, nothing deployed; no registry credentials are used.
No promotion, approval, execution, archival or deletion; no Movies library, Jellyfin or provider call; no
Phase 231 authorization. The lifecycle image tags are local-only and removed on teardown. The workflow job is
read-only and structurally incapable of publishing.
