# Phase 251 — consumer-verifiable release integrity and supply-chain packet

Phase 250 proved, read-only, that a release's *coordinates* line up and its publish path is safe. Phase 251 is
for the person on the other end: the consumer who downloaded the archive and wants to know, offline, that the
bytes on their disk are exactly what the release describes — and to see a minimal software bill of materials
for what they are about to run.

It adds two things and nothing else:

1. a **verification packet** — a deterministic, redaction-safe file that ships *alongside* the archive as a
   release asset. It records the archive's SHA-256, every bundle file's digest, a minimal **SBOM** built purely
   from the committed lockfile's production closure and the image's own declared metadata, whether CI is wired
   to attach SLSA **provenance** and an SBOM attestation to the published image, and copy-paste verification
   commands for Linux, macOS and Windows;
2. an **offline verifier** — given a downloaded archive and this packet, it independently recomputes the
   archive digest, extracts the archive in memory, recomputes every file's digest, and cross-checks the
   bundle's own MANIFEST / CHECKSUMS / VERSION / Compose image pin against the packet and against each other.

```
npm run ops:release-verification -- --emit-packet --archive-dir dist/release-archive     # generate the packet
npm run ops:release-verification -- --verify --archive <file.tar.gz> --packet <file.json> # verify a download
npm run ops:release-verification -- --verify --packet <file.json>                         # packet consistency only
```

It contacts no network, uses no credential, and publishes, pushes or tags nothing. Emitting re-assembles the
bundle and archive in memory from the same coordinates the release uses (deterministic), so the packet is a
pure function of the checkout; verifying reads bytes off disk and recomputes digests.

## The three outcomes and their exit codes

| Outcome | Exit | Meaning |
| --- | --- | --- |
| `VERIFIED` | `0` | The archive bytes are exactly what the packet describes, and the packet is internally consistent. |
| `UNVERIFIED` | `20` | The check could not be completed offline (only the packet was supplied, not the archive). Not confirmed, not denied. |
| `INVALID` | `21` | A digest or a coordinate did not match. Something was tampered with, or the packet and artifact disagree. |

A usage error exits `2`; a refused (redaction-unsafe) render exits `3` — a safe failure, never a pass. A skip
is never a pass: with no archive to hash, the verifier says `UNVERIFIED`, not `VERIFIED`.

## What VERIFIED does — and does not — mean

`VERIFIED` is a statement about **integrity**: the bytes match this packet and the packet is self-consistent.
It is **not** a statement about **identity**. A matching checksum proves the bytes are identical to what the
packet describes; it does not prove *who* produced them. Publisher identity requires a cryptographic signature
(GitHub attestations / Sigstore against the published image), which is an online step this offline packet
*describes* but never performs and never pretends to have performed. The report therefore always carries a
separate `publisherIdentity` field fixed at `NOT_ESTABLISHED_OFFLINE`, and an `attestation` field reporting
whether provenance/SBOM are `declared-by-ci` — clearly `DECLARED_NOT_VERIFIED_OFFLINE`. Neither field gates
the integrity outcome; the verifier never implies a signature it has not checked.

## What the verifier cross-checks

Each is one statement that can be false; on a healthy release all pass, and the adversarial tamper corpus in
`test/release-verification.ts` proves each turns to `FAIL` against a minimally-tampered artifact.

* **packet-self-digest** — the packet has not been edited since it was generated (its self-digest recomputes);
* **archive-digest** — the recomputed SHA-256 of the downloaded bytes equals the packet digest;
* **archive-size** — the byte count matches;
* **bundle-contents** — every file inside the archive matches its packet digest, with none added or missing;
* **bundle-checksums** — the bundle's own `SHA256SUMS` verifies against the real files, exactly as
  `sha256sum -c` would report;
* **manifest-consistency** — the MANIFEST, the `VERSION` file, and the shipped Compose/`.env` image pin all
  name the same version and the same immutable image ref, and never a floating `:latest`.

## The software inventory (minimal SBOM)

The inventory is built purely from the committed `package-lock.json` (the `npm ci --omit=dev` production
closure — every entry whose `dev` flag is not set) plus the image's own declared metadata from
`Dockerfile.runtime` (the digest-pinned base image and the static OCI labels). Each package contributes its
name, version, SPDX license, and Subresource Integrity (SRI) hash — the supply-chain anchor. Nothing is read
from `node_modules`, from `npm`, or from the network, so **no build-machine path or environment data can leak
into it**, and two builds of the same lockfile produce a byte-identical inventory. Platform-specific optional
binaries appear as *declared*; only those matching the image platform are installed, and the note says so.

## Verifying a download without our tool

The packet carries copy-paste commands so a user can verify with nothing but their OS tools:

* **Linux** — `sha256sum -c <archive>.sha256`, then `tar -xzf`, then `sha256sum -c SHA256SUMS`;
* **macOS** — `shasum -a 256 -c <archive>.sha256`, then `tar -xzf`, then `shasum -a 256 -c SHA256SUMS`;
* **Windows** — `Get-FileHash -Algorithm SHA256 <archive>` compared to the digest the packet prints, then
  `tar -xzf`, then a per-file `Get-FileHash` loop over `SHA256SUMS`.

The `attestationOnline` commands (`gh attestation verify`, `cosign verify-attestation`) are listed separately
and clearly marked as needing the network and the published image — they are what establish provenance and
publisher identity, which the offline packet does not.

## Self-digest and redaction

Both the packet and the report carry a `selfDigest` over their verdict-bearing fields, independent of the wall
clock, so either can be pinned and re-verified; any change to what is claimed changes it. Both are controlled
text — coordinates, fixed sentences, public digests, registry package names and SRI hashes — and a backstop
scans the rendered output for leaked live *data* (a private key, a token, a database password, an absolute
host path, the Movies library path) and refuses to print rather than emit anything unsafe.

## Integration

Release assembly (`deploy/ci/release-bundle-check.sh`) emits the packet with the same coordinates as the
assembled archive, proves it reproduces, and verifies the assembled archive against it — a packet that does not
describe what shipped fails the build before anything is attached. The publish gate
(`deploy/ci/release-asset-upload.sh`) attaches the packet as a third release asset when assembly produced one,
re-verifying first. CI runs `npm run test:phase251-local` in the suites gate before any publish.

## Boundaries

Offline and read-only. No publish, push, tag, merge or deploy; no credentials; no GitHub, Jellyfin or provider
contact; no promotion, no Movies library access, no Phase 231 authorization. A `VERIFIED` result is a statement
about bytes, never about a publisher's identity, which it never implies without a cryptographic signature.
