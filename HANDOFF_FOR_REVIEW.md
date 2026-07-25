# Handoff for review — v1.1.2 (Phase 254), consumer readiness

Branch `cdb8457/v1-1-2-consumer-readiness`, from `a5ef828`. **Not tagged, not released, not merged.**

Three defects, all the same shape: the project believed something about what a stranger receives, and nobody
had checked.

1. **The Arcane install path was documented but not shipped.** v1.1.1 built it, tested it, released it — and
   the downloadable archive contained only the ordinary-computer stack, whose *relative* bind sources are
   exactly what a launcher relocation breaks. `docker-compose.arcane.yml` and `arcane-setup.sh` now ship in
   the bundle, byte-identical to the tested files, with assembler guards refusing a relative bind source, a
   defaulted host-project variable, a build-from-source stack, or any baked host identity.
2. **A local build was reported as MALFORMED.** `catalog-authority-ops:ci` is not malformed; it names no
   registry. A new `LOCAL` state reports it honestly, preserves the digest pin when there is one, and still
   says out loud that nobody else could pull it. Genuine rubbish is still `MALFORMED`.
3. **Nothing checked that a stranger can pull the image.** `ops:image-pull-preflight` asks anonymously, and
   the publish job runs it as its final gate against the digest the push step reported.

## The correction that matters most

During v1.1.1 verification I reported the published image as not anonymously readable. **That was wrong.** My
probe sent an `Accept` header missing the OCI image-index type, and a registry answers `404` — not `406` — for
a media type the caller did not accept. `docker buildx` publishes an index, so a public image looked absent.

`ghcr.io/cdb8457/catalog-authority-ops` is **public**. `v1.1.1` resolves anonymously to
`sha256:3dcd1ad9…` and `v1.1.0` to `sha256:e7dc58b9…`, each exactly the digest its release pins. **No GHCR
visibility change is required of anyone.** The new gate exists so a future regression is caught by CI rather
than by a user, and it pins the full media-type set with a test so it cannot repeat my false negative.

## External blockers

**None.** Package visibility is already correct. If the gate ever reports `NOT_PUBLIC`, it prints the exact
human steps (Package settings → Danger Zone → Change visibility → Public) and keeps blocking, because a
workflow token cannot change its own package's visibility and nothing here pretends otherwise.

## Verification

Typecheck clean. New suites `test/image-pull-preflight.ts` and `test/consumer-bundle-arcane.ts`. The assembled
bundle was extracted and driven as a consumer would: `docker-compose.yml` resolves, and the Arcane stack
correctly refuses without its required variables and resolves with them. Phase 242-254 suites green.

`test/deploy.ts` has one failure that reproduces identically at `a5ef828` — a Windows CRLF artifact in an
assertion embedding a literal `
`; it passes in CI on Linux.

## Boundaries

Nothing tagged, published, released, merged or deployed. No package visibility changed. No Unraid contact, no
`/mnt/user/media/Movies`, no live Jellyfin or provider call, no Phase 231 authorization or execution.
`v1.0.0`, `v1.1.0` and `v1.1.1` remain published and immutable.

Detail: `docs/PHASE_254_CONSUMER_READINESS.md`.
