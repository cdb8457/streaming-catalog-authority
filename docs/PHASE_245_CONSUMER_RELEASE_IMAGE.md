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

### What the image actually contains, precisely

`tsx` moved from `devDependencies` to `dependencies` in this phase. That is deliberate and it is not a
"no-toolchain" image, so here is the exact contract rather than a comfortable summary:

- the runtime dependency closure is **`pg` and `tsx`**, and nothing else — `npm ls --omit=dev` proves it, and
  the Phase 245 remediation suite runs exactly that command rather than trusting the Dockerfile's wording;
- **`tsx` is a transpiler and it runs in production.** The entrypoint is `node --import tsx …cli.ts`, so
  every start-up parses TypeScript and transpiles it in-process (esbuild, in memory — nothing is written to
  disk, which is why `read_only: true` holds). Claiming the image ships no tooling would be false;
- what the image does **not** contain: the TypeScript compiler (`typescript`), any `@types/*` package, the
  embedded PostgreSQL the tests use, the test suite, or a package manager step at run time. `npm` is never
  invoked after the build;
- the cost of this choice is a transpile at boot and a supply-chain surface of one extra production package;
  the benefit is that the artifact runs the same source the tests run, with no build-output drift. A
  precompile step (`tsc` to `dist/`) is the alternative and it is a larger change than this remediation
  should carry — several ops modules resolve paths relative to their own source location, so moving them is
  a separate piece of work with its own risk, not a footnote here.

The bundle, separately, genuinely contains no toolchain at all: it is a Compose file, two setup scripts and
text.

## Image, tag and digest policy

The published repository is `ghcr.io/cdb8457/catalog-authority-ops`, and this release pins:

```
ghcr.io/cdb8457/catalog-authority-ops:v1.0.0
```

**This was wrong when the phase first shipped, and the correction is the point of the remediation.** The
first version published to `ghcr.io/catalog-authority/…`. Earlier phases wrote the convention with a
placeholder — `ghcr.io/<owner>/catalog-authority-ops:<tag>` — and later documents copied the placeholder as though it
were a name. Nobody here owns `catalog-authority`, a workflow's `GITHUB_TOKEN` is scoped to its own
repository's owner and cannot write into an unrelated namespace, and every artifact repeating that string was
telling users to pull an image that could never exist. The tests passed because they only checked that the
string was the same everywhere. It was: consistently wrong.

So the owner now lives in exactly one place, `src/ops/release-coordinates.ts`, and everything else reads it:
the Compose default, the bundle's `.env`/`VERSION`/manifest, this document, the README, and the release
workflow. Two things keep it honest:

- `npm run ops:release-coordinates -- --repository <owner/name>` fails when the checked-in owner is not the
  owner the workflow is actually running as. CI runs it on every push, so a fork, a rename or another
  copied-in placeholder is a failed check on the change that caused it, not a failed release months later.
- The image name is **validated, not repaired**: lowercased where GHCR requires it (a GitHub owner may
  legitimately contain uppercase), and otherwise refused. An override that would need rewriting to be legal
  is rejected rather than silently corrected, so what an operator typed and what gets published are the same
  string.

**Override.** `CATALOG_AUTHORITY_IMAGE_REPOSITORY` (workflow/CLI) accepts a full `registry/owner/name` and is
validated identically. Publishing under a different owner needs that owner's credentials: the built-in
`GITHUB_TOKEN` only works for this repository's own namespace, and the publish job's `packages: write`
permission only grants that. For any other registry, replace the `docker/login-action` credentials with a
secret that has package-write there — the workflow will not acquire that permission by itself.

The rules, in full:

1. **Never `latest`.** Not as a default, not as an alias, not as a convenience tag. `docker-compose.runtime.yml`
   defaults to a concrete `vX.Y.Z`; the bundle assembler refuses to build around `latest`; the release gate
   (`src/ops/release-ref.ts`) refuses `latest`, branch names, and anything that is not `vX.Y.Z`; and the
   publish step pushes exactly one tag.
2. **A published tag is immutable.** Once `vX.Y.Z` exists in the registry it is never re-pushed with
   different content. A rebuild gets the next version. This is what makes rollback a one-line edit rather
   than an archaeology exercise.
3. **Digests beat tags, and the bundle carries one.** A release build passes its resolved digest to the
   bundle assembler, which writes `CATALOG_AUTHORITY_IMAGE=…@sha256:…` into the bundle's `.env` and records
   the digest in `bundle-manifest.json` and `VERSION`. An operator who wants the strongest possible pin sets
   that variable by hand:

   ```
   CATALOG_AUTHORITY_IMAGE=ghcr.io/cdb8457/catalog-authority-ops@sha256:<digest>
   ```
4. **The base image is pinned by digest too.** `Dockerfile.runtime` pins `node:22-slim` by its index digest,
   with the tag written alongside it so a human can read what it is. Moving it is an edit, a review and a
   rebuild — never a surprise on someone else's machine.
5. **The tag is decided once, and everything carries the same one.** `src/ops/release-ref.ts` reads the event
   context and returns either a refusal or one tag, one image reference and one asset name.
   `assertReleaseConsistency` then requires the image tag, the bundle's version metadata and the archive's
   filename to be that same version, so a release cannot ship half-labelled. Nothing downstream re-derives a
   tag from `github.ref_name` — that context is a branch on one event and a tag on another, and reading it
   once "correctly" is luck.
6. **Honesty about what is published.** *Nothing has been published yet:* no image, no release asset. This
   phase builds, tests and assembles; it does not publish, tag or push. Until a release runs, the pinned
   reference names an image that does not exist in the registry, and the way to run the stack from source is
   the maintainer override below.

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

### The download itself

The bundle *directory* is what CI inspects. What a user downloads is one file, attached to the GitHub release:

```
catalog-authority-operator-ui-vX.Y.Z.tar.gz
catalog-authority-operator-ui-vX.Y.Z.tar.gz.sha256
```

The first version of this phase attached the bundle with `actions/upload-artifact` and called that the
delivery. It is not one: an Actions artifact expires, requires a GitHub login, lives behind the Actions UI
and arrives double-zipped. The per-job artifact is still produced — it is genuinely useful for inspecting a
CI run — but it is named `ci-inspection-release-bundle` so nothing represents it as the consumer download.

The archive is written by `src/ops/release-archive.ts` rather than shelled out to `tar`, because a release
asset nobody can reproduce cannot be checked against anything:

- entries **sorted by path**, so ordering never depends on a filesystem's `readdir`;
- every **timestamp, uid and gid zero**, owner names empty — no build fingerprint, no "who built it";
- plain **ustar**, no PAX extended headers (which would smuggle timestamps back in), and gzip through node's
  zlib, which writes no mtime into the header;
- everything under **one top-level directory**, so extracting cannot scatter files across a working
  directory; `.sh` files are mode 755, everything else 644.

Two builds of the same bundle are therefore byte-identical, and the published `.sha256` is a fact about the
contents rather than about the machine. CI verifies this end to end: it extracts the archive with the *system*
`tar`, `diff -r`s the result against the bundle it just checksummed, runs `docker compose config` inside the
extracted directory (with no Node.js and no checkout involved), and rebuilds the archive to confirm the digest
is the same. `deploy/ci/release-asset-upload.sh` re-verifies the checksum before attaching, refuses an archive
whose name does not carry the release tag, and only ever uploads to a release that already exists — it never
creates, deletes or moves one.

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
| `suites` | typecheck, Phase 245 + release-delivery + 244/243/242, operator UI auth and boundary suites, release guard and versioned release cut, Compose config validation, and the release-coordinates drift check | every push and PR |
| `image` | `deploy/ci/runtime-image-smoke.sh` — build, container contract, up, `/healthz`, 401 unauthenticated, 200 authenticated, UI shell, graceful stop, down | every push and PR |
| `bundle` | `deploy/ci/release-bundle-check.sh` — assemble, `sha256sum -c`, extract-and-`diff -r`, `docker compose config` in the extracted tree, reproducibility, no-source/no-secret/no-`latest` checks | every push and PR |
| `publish` | Resolve the tag through the gate, build and push one immutable tag, assemble a digest-pinned bundle and archive, verify it, attach it to the release | **only** a published release, or a manual dispatch that explicitly asks and is running from a `v*` tag |

The gate is structural, not a convention:

- the workflow's default permission is `contents: read`, and **only `publish`** raises it — `contents: write`
  (to attach the asset) and `packages: write` (to push the image), nothing else, nowhere else;
- only `publish` logs in to a registry, and only `publish` can run `gh release upload`;
- `publish` needs all three other jobs and runs in a protected `release` environment;
- the `if:` on the job is a cheap pre-filter; the real decision is `src/ops/release-ref.ts`, a pure function
  with adversarial fixtures, which refuses pushes, pull requests, drafts, branch refs, `latest`, malformed
  versions, a release whose ref names a different tag, a run in the wrong repository, and an image name GHCR
  would reject. It is runnable locally — `npm run ops:release-ref -- --event release --release-tag v1.2.3
  --ref refs/tags/v1.2.3` — so the logic is testable without a workflow run.

The Phase 245 remediation suite parses the workflow and asserts each of those, and executes the gate itself
against every refusal case.

### Running the shell steps on Windows

`bash` on a Windows PATH is normally `C:\Windows\System32\bash.exe` — the WSL launcher, not Git Bash. It
answers `bash --version` as GNU bash 5.2 and then either cannot open a script at a Windows path (exit 127,
`No such file or directory`) or, when the path is reachable as `/mnt/c/...`, runs the whole step inside the
Linux distro against a `node_modules` built for win32 — which surfaces to the operator as a broken esbuild
install rather than as the wrong shell. Which shell a developer got depended on whether they typed the command
into PowerShell or into Git Bash.

`src/ops/usable-shell.ts` answers the question once, and answers it by *doing* the thing: it writes a probe
script into a throwaway directory whose name contains a space, runs each candidate against it, and requires
the sentinel back on stdout. WSL bash fails that probe and Git for Windows bash passes it; on Linux and macOS
the first candidate — PATH `bash` — passes immediately, so nothing changes there. `npm run
release:bundle-check` goes through `src/ops/run-with-bash-cli.ts`, which resolves the shell that way and
passes the script's exit code back unchanged; the suites that execute shipped scripts resolve theirs the same
way. A host with no usable bash fails the suites rather than skipping them, because a host that cannot run a
`.sh` file cannot run this project's release steps either.

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
triggers, permissions, job dependencies, single immutable tag, architecture claim and the executable gate
behind it.

`npm run test:release-delivery` (also `test:phase245-remediation-local`) — the remediation. The release
coordinates checked against the repository's own git remote, so a placeholder namespace cannot pass by being
internally consistent; the image-name validator's lowercasing, its refusals, and its refusal to silently
repair an override; the release decision against adversarial contexts — pushes, pull requests, drafts, a
release whose ref names a different tag, a dispatch that did not ask, a dispatch from a branch, `latest`,
`v1.2`, `v01.2.3`, a bare sha, the wrong repository, an owner that disagrees with its repository, an
uppercase image override — each expected to refuse, with the CLI executed to confirm it refuses the same
things the function does; the tag/bundle-version/archive-name/image-tag consistency check; the archive's
contents, modes, ordering, zeroed timestamps and ownership, reproducibility across builds and across entry
order, gzip header with no mtime, separately verifiable checksum, and absence of secrets, source and
toolchain; the same archive read by the *system* `tar` and extracted to the bundle a user would get; the
workflow's permission split (only `publish` may write anything), its single gate, and the artifact naming
that stops an expiring Actions upload from being mistaken for the download; and `npm ls --omit=dev` run for
real to prove the runtime closure is exactly `pg` and `tsx`, with the documentation's transpiler claim held
to it.
