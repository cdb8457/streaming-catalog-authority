# Phase 245: A consumer-ready image and release bundle

Status: `PHASE_245_CONSUMER_RELEASE_IMAGE_READY`

Phase 244 made the operator UI runnable on an ordinary computer — if you had a checkout of this repository, a
Node.js toolchain, and the patience to build an image whose Dockerfile exists to run the test suite. That is
a developer workflow wearing a consumer's clothes.

This phase closes the gap. What a person who wants to *run* this now needs is Docker and a zip file:

- a **production image** built from its own multi-stage `Dockerfile.runtime` — no dev dependencies, non-root,
  signal-correct, and probing the same `/healthz` route the stack always probed;
- a **version-pinned prebuilt image** as the default in `docker-compose.runtime.yml`, so `docker compose up
  -d` pulls a known build instead of compiling one;
- a **release bundle** containing the Compose file, both setup scripts, the image pin, checksums and
  upgrade/rollback instructions — and no source, no `package.json`, no TypeScript;
- **CI** that builds the image on Linux with a real Docker daemon, smoke-tests the running stack end to end,
  assembles the bundle and validates it — with publishing gated behind an explicit release action.

It adds no product capability. The UI, the routes, the token boundary and the audit semantics are exactly
Phases 231–244; this phase is about how they reach a machine.

## Install

See the README for the three-platform quick path. The short version, from the release bundle:

```
extract the bundle  ->  ./setup.sh  (or setup.ps1)  ->  docker compose up -d  ->  http://127.0.0.1:8099/
```

From a checkout, the same stack with the same pinned image:

```bash
./deploy/local-runtime-setup.sh
docker compose -f docker-compose.runtime.yml up -d
```

## Two Dockerfiles, on purpose

| File | Purpose | Used by |
| --- | --- | --- |
| `Dockerfile` | Runs the test suite inside a container (`npm run ci` against the Compose Postgres) | `docker-compose.yml`, the Unraid stacks, `npm run image:build:local` |
| `Dockerfile.runtime` | **New.** The production operator UI on port 8099 | `docker-compose.runtime.build.yml`, the release workflow |

A test-harness image wants every dev dependency and a writable tree. A deployment image wants neither.
Repurposing the existing file would have quietly changed what `docker compose run --rm app npm test` and the
Unraid launcher build, so the production image is a separate file and the old one is untouched.

What `Dockerfile.runtime` guarantees, and what the Phase 245 suite asserts about it:

- **multi-stage** — dependencies are installed in a build stage with `npm ci --omit=dev --ignore-scripts`, so
  TypeScript, `@types/*` and the embedded PostgreSQL used by tests never reach the shipped layer;
- **non-root** — it runs as the base image's `node` user, and the application source is owned by root, so the
  app cannot rewrite its own code even before `read_only: true` is applied;
- **signal-correct** — `node` is PID 1 via an exec-form entrypoint. No `npm`, no shell wrapper. The operator
  UI CLI already installs `SIGTERM`/`SIGINT` handlers that close the server, so `docker stop` is a graceful
  shutdown instead of a ten-second wait and a kill. Compose also sets `init: true` to reap orphans;
- **health-compatible** — the image's own `HEALTHCHECK` and the Compose healthcheck probe the same
  unauthenticated, redaction-safe `/healthz`, so `docker run` and `docker compose` cannot disagree;
- **startup-compatible** — the same `*_FILE` secret indirection and the same PostgreSQL-backed startup the
  stack has always used. Nothing about configuration changed.

`tsx` moved from `devDependencies` to `dependencies` in this phase. That is not a workaround: every
entrypoint this project ships is TypeScript executed through `tsx`, so it is a runtime dependency, and saying
so is what makes `--omit=dev` a minimal image rather than a broken one.

## Image, tag and digest policy

The published repository is `ghcr.io/catalog-authority/catalog-authority-ops`, the convention `RELEASE.md`
has documented since v1.0.0. This release pins:

```
ghcr.io/catalog-authority/catalog-authority-ops:v1.0.0
```

The rules, in full:

1. **Never `latest`.** Not as a default, not as an alias, not as a convenience tag. `docker-compose.runtime.yml`
   defaults to a concrete `vX.Y.Z`; the bundle assembler refuses to build around `latest`; the release
   workflow's tag resolver (`deploy/ci/resolve-release-tag.sh`) exits non-zero for `latest`, for a branch
   name, and for anything that is not `vX.Y.Z`; and the publish step pushes exactly one tag.
2. **A published tag is immutable.** Once `vX.Y.Z` exists in the registry it is never re-pushed with
   different content. A rebuild gets the next version. This is what makes rollback a one-line edit rather
   than an archaeology exercise.
3. **Digests beat tags, and the bundle carries one.** A release build passes its resolved digest to the
   bundle assembler, which writes `CATALOG_AUTHORITY_IMAGE=…@sha256:…` into the bundle's `.env` and records
   the digest in `bundle-manifest.json` and `VERSION`. An operator who wants the strongest possible pin sets
   that variable by hand:

   ```
   CATALOG_AUTHORITY_IMAGE=ghcr.io/catalog-authority/catalog-authority-ops@sha256:<digest>
   ```
4. **The base image is pinned by digest too.** `Dockerfile.runtime` pins `node:22-slim` by its index digest,
   with the tag written alongside it so a human can read what it is. Moving it is an edit, a review and a
   rebuild — never a surprise on someone else's machine.
5. **Honesty about what is published.** *No image has been published yet.* This phase builds, tests and
   assembles; it does not publish, tag or push anything. Until a release runs, the pinned reference names an
   image that does not exist in the registry, and the way to run the stack from source is the maintainer
   override below.

### Architectures

CI builds and smoke-tests **`linux/amd64`**, because that is what the GitHub-hosted runner is, and that is
therefore the only architecture on which "the image works" is a fact rather than an assumption. The publish
step is configured for `linux/amd64` alone.

`linux/arm64` is **not published**. The base image supports it and the application is architecture-neutral
JavaScript, so it would very likely work — but "very likely" is not verification, and shipping an
unverified architecture to Raspberry Pi and Apple Silicon users would be a claim this project has not
earned. Adding it means adding an arm64 runner to the smoke job first, then the platform to
`PUBLISH_PLATFORMS`. Until then, arm64 users build locally with the maintainer override.

## The maintainer override

`docker-compose.runtime.yml` names a prebuilt image and has no `build:` section — that is what lets the same
file work inside a bundle on a machine with no source. Building from a checkout is an explicit second file:

```bash
docker compose -f docker-compose.runtime.yml -f docker-compose.runtime.build.yml up -d --build
```

The override adds a build from `Dockerfile.runtime` and retags the result `catalog-authority-ops:dev`, so a
development build can never be confused with — or accidentally pushed as — a release. It changes nothing
else: every hardening setting is inherited from the file it overrides, and the Phase 245 suite asserts that
the override's only keys are `build`, `image` and `pull_policy`.

CI uses exactly this pair for the smoke test, which is the point: the thing tested is the thing the release
publishes, assembled the same way.

## The release bundle

`npm run ops:consumer-release-bundle -- --out dist/release-bundle` assembles it. Contents:

| File | What it is |
| --- | --- |
| `README.md` | Install, log in, upgrade, roll back, verify |
| `docker-compose.yml` | The runtime stack, byte-for-byte the file this repository tests |
| `setup.sh`, `setup.ps1` | The Phase 244 setup scripts, byte-for-byte |
| `.env` | The image pin for this exact release, plus host port and records folder |
| `.env.example` | The annotated template, with no secret-shaped variable in it |
| `VERSION` | Version, image reference, digest, source revision, build time |
| `bundle-manifest.json` | The same, machine-readable, plus a digest and size per file |
| `SHA256SUMS` | `sha256sum -c`-compatible digests of every other file |

Properties the suite enforces rather than hopes for:

- **No toolchain.** No `package.json`, no lockfile, no `node_modules`, no `.ts`, no Dockerfile. A user with
  Docker and nothing else can run it; the CI check proves the Docker CLI resolves the stack with the bundle
  as the entire project directory.
- **No secrets.** The assembler scans its own *output* for base64 32-byte values, real database passwords and
  key material, and refuses to produce a bundle that contains any — because the interesting failure is a
  maintainer's `./secrets` being swept in by a careless change, not a password typed into a README.
- **LF endings, always.** Every file is emitted LF-terminated no matter how the checkout it was assembled
  from is stored, so a bundle built on Windows and a bundle built on Linux are byte-identical and a shipped
  `.sh` is a script rather than a support ticket.
- **Reproducible.** The assembler is a pure function of its inputs — no clock, no filesystem, no randomness —
  so the same source and the same options produce the same digests.

The setup scripts ship twice (here under `deploy/`, and at a bundle root), so they resolve their own
location: in `deploy/` they step up to the repository and print `docker compose -f docker-compose.runtime.yml
up -d`; at a bundle root they stay put and print `docker compose up -d`. Both are executed, in both layouts,
by the Phase 244 and Phase 245 suites.

## Upgrade and rollback

**Upgrade** is a deliberate change to the pin:

1. Read the release notes for the new version.
2. `docker compose down`
3. Change `CATALOG_AUTHORITY_IMAGE` in `.env` to the new tag or digest — or extract the new bundle beside the
   old one and copy `secrets/` and `promotion-records/` across.
4. `docker compose up -d`

Secrets, the database volume and the artifact folder are untouched by an image change. Re-running the setup
script is safe at any point: existing secrets are kept and never regenerated.

**Rollback** is the same edit in reverse — set `CATALOG_AUTHORITY_IMAGE` back to the previous value and
`docker compose up -d`. This works *because* of the pinning rules: an immutable tag or a digest means the old
image is still exactly the old image. With `latest`, rollback would be a wish.

The honest limit: rolling the image back does not roll data back. If a migration has run and you need the
previous schema, restore the database backup before starting the older image.

## CI

`.github/workflows/runtime-image.yml`, four jobs:

| Job | What it does | Runs on |
| --- | --- | --- |
| `suites` | typecheck, Phase 245/244/243/242, operator UI auth and boundary suites, Compose config validation | every push and PR |
| `image` | `deploy/ci/runtime-image-smoke.sh` — build, container contract, up, `/healthz`, 401 unauthenticated, 200 authenticated, UI shell, graceful stop, down | every push and PR |
| `bundle` | `deploy/ci/release-bundle-check.sh` — assemble, `sha256sum -c`, no-source/no-secret/no-`latest` checks, `docker compose config` | every push and PR |
| `publish` | Build and push one immutable tag, then assemble a digest-pinned bundle | **only** a published release, or a manual dispatch that explicitly asks and is running from a `v*` tag |

The gate is structural, not a convention: the workflow's default permission is `contents: read`; only
`publish` requests `packages: write`; only `publish` logs in to a registry; `publish` needs all three other
jobs; it runs in a protected `release` environment; and the tag it pushes comes from a validating script that
refuses anything that is not `vX.Y.Z`. The Phase 245 suite parses the workflow and asserts each of those.

**The daemon-backed results are CI-required.** The machine this phase was developed on has the Docker CLI but
no running daemon, so the image was never built or run here. That is recorded as an unmet check rather than
papered over: the local suite asserts the *contract* (the Dockerfile's structure, the Compose selection, the
bundle's contents, the workflow's gating) and CI asserts the *behaviour*. A local suite that pretended to
have proven a container serves HTTP would be worth less than one that says it did not.

## Boundaries

No image is published, no tag is created, no branch is merged, nothing is deployed. No promotion, approval,
execution, archival or deletion. No Movies library access, no Jellyfin call, no Phase 231 authorization, no
live or outbound call from any test or script added here. The published stack keeps every boundary Phases
231–244 established: one authenticated read-only UI, an artifact folder mounted read-only, a database that is
never published to the host, and `/healthz` as the only open route.

## Tests

`npm run test:phase245-local` — the pinned image selection and the absence of a build in the consumer path;
the maintainer override's shape and its inability to weaken the stack; the test-harness Dockerfile left
alone; the production Dockerfile's multi-stage structure, digest-pinned base, non-root user, exec-form
entrypoint, signal handling, exposed port and health contract; the dependency split that makes `--omit=dev`
minimal; the bundle's exact contents, checksums, manifest agreement, reproducibility, digest pinning, refusal
of `latest`/bad pins/secrets/source-building Compose, and its upgrade, rollback and token documentation; the
bundle assembled by the shipping CLI and verified with `sha256sum -c`; **both** setup scripts executed inside
an extracted bundle, including re-run preservation and the layout-correct start command; and the workflow's
triggers, permissions, job dependencies, single immutable tag, architecture claim and the executable tag
validator behind it.
