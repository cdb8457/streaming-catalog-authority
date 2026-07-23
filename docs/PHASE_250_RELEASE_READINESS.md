# Phase 250 — first-public-release readiness proof

Everything through Phase 249 built and *proved* the pieces of a first public release: an image, a consumer
bundle, a browser acceptance, a lifecycle acceptance, and a publish workflow that gates on all of them.
Phase 250 adds the last thing a first release needs — a single, deterministic, **read-only** command that
cross-checks that all those pieces say the *same thing* and that the publish path is *safe*, and prints the
evidence a human needs before deciding to release.

```
npm run ops:release-readiness                 # readiness for the shipped tag, redaction-safe JSON
npm run ops:release-readiness -- --text       # a concise human summary
npm run ops:release-readiness -- --tag v1.2.3 # readiness for a specific tag
```

It is **evidence, not approval.** A green result — `READY_FOR_HUMAN_RELEASE_DECISION` — means a human MAY now
decide to release. It never decides for them, authorizes nothing, and (this is the whole point) can be run a
hundred times and change nothing: it publishes, pushes, tags, merges and deploys nothing, uses no credential,
and contacts no network, GitHub, Jellyfin or provider.

## The four outcomes and their exit codes

| Outcome | Exit | Meaning |
| --- | --- | --- |
| `READY_FOR_HUMAN_RELEASE_DECISION` | `0` | Every check passed. Evidence that a release decision may be made. |
| `BLOCKED` | `10` | A check found a real problem: drift, a floating pin, a missing gate, a leaked secret, a dirty tree. |
| `INVALID` | `11` | An input could not be interpreted (the workflow does not parse). The question could not be posed. |
| `NOT_RUN` | `12` | A required piece of evidence could not be gathered offline (no Git here, or the tag is not present locally). Readiness is not claimed on incomplete evidence. |

Precedence, most severe first: **INVALID > BLOCKED > NOT_RUN > READY**. Usage errors exit `2`; a refused
render (the report would have contained something unsafe) exits `3` — a safe failure, never a pass.

`READY` is never manufactured: if the tool cannot verify the checkout state because there is no Git, it says
`NOT_RUN`, not `READY`. A skip is never a pass.

## What it cross-validates

Every check is a single statement that can be false. On a healthy release all pass; each is proven to turn to
`BLOCK` against a minimally-weakened fixture (see `test/release-readiness.ts`).

**Coordinates — the version said once, everywhere.**
* the target tag is an immutable `vX.Y.Z` tag, never `latest`;
* the checked-in bundle version matches the tag being released (version drift is a BLOCK);
* the tested publish decision (`src/ops/release-ref.ts`) approves *exactly* these coordinates;
* tag, bundle version, archive name and image tag are one fact (`assertReleaseConsistency`);
* every generated bundle file — the pin, `VERSION`, `.env`, the manifest — names the target version;
* the asset name is canonical and **every checksum verifies by recomputation**: the archive digest against
  its own bytes and its sidecar, and every `SHA256SUMS` entry against its file's recomputed digest;
* the image repository is `ghcr.io` in this repository owner's namespace, lowercase and canonical;
* nothing points at a moving tag, and the runtime image base is pinned by digest;
* the assembled bundle carries **no** secret, host path, or live-provider data.

**The publish path — structurally incapable of going out unsafely.**
* `publish` depends on every gate, *including* the Phase 248 browser acceptance and the Phase 249 lifecycle
  acceptance;
* those two gates carry no `if:`, so they run on every event that can reach `publish` and are never
  conditionally skipped;
* `publish` is gated to a release or a deliberate dispatch, and uses no `always()`/`failure()`/`cancelled()`
  that could let it run over a failed gate;
* the workflow default permission is `contents: read`; **only** `publish` holds `contents`+`packages` write;
* **no job except `publish`** contains a registry login, an image push, a git push/tag, a `gh release` write,
  or a write permission;
* `publish` pushes exactly the gate-decided immutable tag from `Dockerfile.runtime` on the single declared
  architecture, never `latest`;
* the suites job runs typecheck and the Phase 245–249 acceptance suites.

**Documentation and checkout.**
* the bundle README documents install, upgrade, and an honest rollback (including "rolling the image back does
  not roll data back") with checksum verification;
* the Phase 245/248/249 release docs are present;
* the working tree is clean (a dirty tree is a BLOCK);
* HEAD is the commit the release tag names (a local tag pointing elsewhere is a "wrong ref/tag" BLOCK; a tag
  absent locally is `NOT_RUN`, because verifying it against the remote is a CI/human step this offline tool
  does not perform).

## Self-digest

The report carries a `selfDigest` — a sha256 over its verdict-bearing fields (outcome, coordinates, and each
check's id + status), independent of the wall clock. The same evidence always produces the same digest, and
any change to the verdict changes it, so a report can be pinned and re-verified.

## Redaction

The report is entirely controlled text — coordinates, fixed check sentences, a public commit hash and
digests — and it deliberately names Jellyfin, providers and the Movies library in its boundary prose to state
what it never touches. A backstop nonetheless scans the rendered output for leaked *data* — a private key, a
credential, a database URL with a password, an absolute host path, the actual Movies path — and refuses to
print rather than emit anything unsafe.

## What it cannot do (and why that is the point)

It is offline. It cannot confirm that a tag or a release actually exists on GitHub, that the published image
digest matches, or that CI's daemon-backed gates actually went green on the release commit — those require
the network and a real run, and are the CI/human steps this proof exists to *precede*. Where it cannot verify
something offline it says `NOT_RUN`; it never guesses, and it never turns "I could not check" into "READY".

## Boundaries

Read-only. No publish, push, tag, merge or deploy; no credentials; no GitHub, Jellyfin or provider contact;
no promotion, no Movies library access, no Phase 231 authorization. A `READY` result is evidence for a human
decision and is not itself a decision, an approval, or an authorization.
