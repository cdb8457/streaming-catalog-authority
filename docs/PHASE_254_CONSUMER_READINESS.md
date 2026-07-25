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

**Fixed:** `ops:image-pull-preflight` asks anonymously, the way a consumer's Docker does. The publish job runs
it **after the push** — the digest cannot exist before that — and **before the release archive is assembled or
attached**, so no asset reaches a release until a stranger has been proven able to pull the image that asset
pins.

That ordering is the correction to the first attempt at this, which put the check last: the archive and its
checksum were already attached to a public release by the time it ran, so it reported rather than gated. A
check that can only tell you afterwards is a log line. A semantic test now reads the parsed publish job and
asserts the check sits after the push and before *every* step that publishes anything, matched on what a step
does rather than against a fixed list — so a publishing step added later cannot slip in front of it.

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
* `NOT_PUBLIC` is claimed **only on direct evidence of refusal** — a `401`/`403`, on the manifest or on the
  anonymous token request itself. A missing token is not evidence: without one the manifest question was
  never asked, so a token-endpoint `404` or `500` proves nothing about visibility and is reported as
  `INDETERMINATE`, which blocks and explicitly warns against changing visibility on that basis. `404` **with**
  a token is `ABSENT`, because "that tag does not exist" sends an operator somewhere different again. (The
  probe reports the token status in its own field; folding it into the manifest status is what made the
  earlier, dishonest inference possible.)
* anything else — no network, an unexpected status — is `INDETERMINATE` and **blocks**, stating in as many
  words that it is not evidence the image is fine and not evidence it is broken;
* a supplied `--expect-digest` that cannot be confirmed **blocks**. A `200` with no `docker-content-digest`
  header used to be an advisory that left `ok` true, so a gate would pass having verified nothing about the
  one thing it was asked to verify. "I could not check" must never produce the same verdict as "I checked and
  it matched". When no expected digest is supplied nothing was asked, so nothing blocks — but the report says
  outright that what a consumer would receive was not checked against anything.

### How to invoke it, and why that needed hardening

`npm run x -- --flag value` is not a portable way to pass arguments. What reaches the script depends on the
npm version and the platform, and three behaviours were observed:

* the flags arrive intact (npm 11.4.2, space-separated form);
* `--flag=value` arrives as a **single token**, which an exact-match parser never recognises;
* npm consumes the option **names** and forwards only their values, or forwards nothing at all
  (independently observed on another Windows npm).

All three converge on one failure: the flag is not seen, the default is used, and the check reports on a
different reference from the one the caller asked about — silently. That was reproduced here: asking for
`v1.1.1` with `=` syntax checked `v1.1.2` and reported `ABSENT`, never mentioning the substitution. A release
gate that quietly checks the wrong image is worse than no gate, because it produces a green tick for a
question nobody asked.

So the CLI resolves its inputs strictly and fails closed:

| Channel | Use |
| --- | --- |
| `CATALOG_AUTHORITY_PULL_REFERENCE`, `CATALOG_AUTHORITY_PULL_EXPECT_DIGEST`, `CATALOG_AUTHORITY_PULL_REPOSITORY` | **What CI uses.** Cannot be reordered, renamed or eaten between caller and process. |
| `npx tsx src/ops/image-pull-preflight-cli.ts --reference <ref> --expect-digest <sha256:…>` | Direct invocation for a person at a terminal; bypasses npm's argument handling entirely. |
| `npm run ops:image-pull-preflight -- --reference …` | Supported, but if your npm eats the flag names the CLI **refuses the leftover values** rather than checking a default. |

Windows PowerShell, reliably:

```powershell
$env:CATALOG_AUTHORITY_PULL_REFERENCE="v1.1.1"
$env:CATALOG_AUTHORITY_PULL_EXPECT_DIGEST="sha256:<digest>"
npm run ops:image-pull-preflight
```

An argument that is not a recognised flag is a **hard error** — a bare `v1.1.1` is refused, not discarded in
favour of a default. Two channels that disagree are a refusal, not a precedence puzzle. And the release
workflow sets `CATALOG_AUTHORITY_PULL_REQUIRE_EXPLICIT=1`, which removes the defaults entirely: if the
environment somehow did not arrive, the run fails loudly instead of checking the active release tag by
accident. That is the one mitigation that holds even against an npm forwarding nothing at all. The workflow
passes the reference and digest from the release and push outputs and forwards **no flags through npm**; a
semantic test pins that wiring.

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
