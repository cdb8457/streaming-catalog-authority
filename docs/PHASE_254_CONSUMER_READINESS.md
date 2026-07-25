# Phase 254: consumer readiness

`v1.1.2`, not yet released. Three defects that all have the same shape: the project believed something about
what a stranger receives, and nobody had checked.

Nothing here changes what the product does. It changes whether a person who is not us can install it.

---

## 1. The Arcane install path was documented but not shipped

`v1.1.1` built an Arcane/Unraid install path, tested it adversarially, wrote it up, and released it — and the
downloadable archive did not contain it. The bundle held exactly one Compose file: the ordinary-computer
stack, whose bind sources are **relative**.

That is not a cosmetic omission. Relative bind sources are precisely what breaks when a launcher relocates the
project under its own `/app/data/projects` — the failure `v1.1.1` existed to fix. So the one class of user
that release was written for downloaded an archive containing only the thing that does not work for them,
alongside a README describing a file that was not there.

**Fixed:** `docker-compose.arcane.yml` and `arcane-setup.sh` now ship in the bundle, byte-identical to the
files the repository tests, and the README carries the Arcane path. The assembler refuses a bundle whose
Arcane stack has a relative bind source, defaults the required host-project variable, or builds from source.

`arcane-setup.sh` now detects whether it is running from a checkout or an extracted bundle, because the
preflight it should recommend differs: `npm run ops:arcane-preflight` where a toolchain exists, and
`docker compose -f docker-compose.arcane.yml config --quiet` in a bundle, which must never ask a Docker-only
user to install Node.js.

**No host identity, enforced rather than intended.** The Arcane work came out of one specific Unraid server.
A new assembled-bytes check refuses to ship a bundle containing a private LAN address, a media library path,
or a particular test project directory — separate from the secret scan, because it is a different kind of
leak: not a credential, but somebody's network and filesystem layout.

---

## 2. A local build was reported as MALFORMED

`describeImageRef` classified any registry-unqualified reference as `MALFORMED`. But `catalog-authority-ops:ci`
is not malformed — it is a valid reference that names no registry, which is exactly what `docker build -t`
produces and exactly what this project's own image smoke and release-candidate runs use.

So the word "malformed" appeared on the Setup & Diagnostics panel during the very runs that exist to
demonstrate the product working, and a digest was thrown away whenever an unqualified reference carried one.

**Fixed:** a new `LOCAL` state, distinct from both `PARSED` (registry-qualified, what a consumer can pull) and
`MALFORMED` (genuine rubbish). `pinnedByDigest` is preserved for a local build that has a digest, the support
report has its own word for it, and the page says "local build" rather than showing a bare state. Registry-
qualified digest references are unaffected and still report as a real pin.

---

## 3. Nothing checked that a stranger can pull the image

Every existing release check verifies what we **produced**: the archive matches its digests, the manifest
agrees with the verification packet, the push reported a digest. None of them asks the only question a
consumer's machine asks — can someone with no credential fetch this image? A registry package can be
published and still not be publicly readable, and that failure lands on a user as `denied` with nothing in
this project's own troubleshooting table naming the cause.

**Fixed:** `ops:image-pull-preflight` asks anonymously, the way a consumer's Docker does, and the publish job
runs it as its final gate against the digest the push step reported.

### The check that already lied once

During `v1.1.1` verification a hand-written probe reported the published image as unreachable, and it was
written up as a limitation in a handoff. **The image was public the whole time.** The probe sent an `Accept`
header listing only the two legacy manifest types, and a registry answers `404` — not `406` — when it holds a
manifest in a media type the caller did not accept. `docker buildx` publishes an OCI image **index**, so the
probe could not see it.

A probe that is wrong in the direction of "your release is broken" is worse than no probe. So:

* the full media-type set is a named constant with a test pinning every member, including both index types;
* a test asserts the probe actually **sends** that header, not merely that the constant exists;
* the check runs **anonymously**, with a test that it accepts no credential — proving *we* can pull would
  prove the wrong thing;
* `404` **without** an anonymous token is reported as `NOT_PUBLIC`, while `404` **with** one is `ABSENT`,
  because "your package is private" and "that tag does not exist" send an operator to different places;
* anything else — no network, no token, an unexpected status — is `INDETERMINATE` and **blocks**, stating in
  as many words that it is not evidence the image is fine and not evidence it is broken.

### If it ever reports NOT_PUBLIC

Package visibility is a GitHub setting. A workflow token cannot change its own package's visibility, and
nothing here pretends otherwise — the preflight prints the exact steps and keeps blocking until a human has
taken them:

1. Open `https://github.com/users/<owner>/packages/container/<package>/settings`
   (organisation: `https://github.com/orgs/<org>/packages/container/<package>/settings`).
2. Under **Danger Zone**, choose **Change visibility**, select **Public**, confirm by typing the package name.
3. Re-run the preflight. It must report `PUBLICLY_PULLABLE` before the release is installable.

**As of this phase no such action is required:** `ghcr.io/cdb8457/catalog-authority-ops` is public, and
`v1.1.1` and `v1.1.0` both resolve anonymously to exactly the digests their releases pin. The gate exists so
that a future regression is caught by CI rather than by a user.

---

## What this phase does not do

It publishes nothing, tags nothing, merges nothing, deploys nothing, and changes no package visibility.
`v1.0.0`, `v1.1.0` and `v1.1.1` remain published and immutable. It runs no promotion, approval, execution,
archival or deletion; contacts no provider, media server or library; touches no Unraid host; and neither
authorizes nor executes any part of Phase 231.

## Tests

* `test/image-pull-preflight.ts` — the media-type set and that it is really sent, the anonymity property,
  every outcome including the `404`-with-and-without-token distinction, digest mismatch blocking a successful
  pull, and that the CLI exits non-zero so the gate cannot be decorative.
* `test/consumer-bundle-arcane.ts` — the Arcane pair is in the extracted archive and executable, the README
  documents it without requiring a toolchain, every bind source is absolute, no host identity survives
  assembly, the assembler refuses each way the stack could be made unportable, the setup script's
  bundle-versus-checkout behaviour, and the `LOCAL`/`PARSED`/`MALFORMED` classification.
