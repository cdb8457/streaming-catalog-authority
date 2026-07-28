# Handoff for review — v1.1.3 release preparation

Branch `cdb8457/v1-1-3-release`, based on `origin/master` at `04e5130`. **Not tagged, not released, not merged
and not deployed.**

This change cuts the release metadata for the work already merged through Phases 255–272. It does not add a
new feature implementation. The release candidate combines the operator catalog workspace, catalog snapshot
import, support and backup tooling, bounded test inventory, keystore-volume repair, durable external-create
recovery, and the explicitly gated managed Jellyfin collection lifecycle.

## Release identity

- `package.json` and the root lockfile package report `1.1.3`.
- The consumer bundle coordinate and shipped Compose defaults select `v1.1.3`.
- A regression test requires the package, lockfile and bundle release identity to agree.
- `v1.0.0` through `v1.1.2` remain published and immutable.

The publish workflow remains responsible for building the production image, applying the `v1.1.3` OCI
version label, resolving its digest, proving an anonymous consumer can pull that digest, and attaching the
verified consumer bundle to the GitHub release.

## Upgrade and rollback

The release upgrades schema version 4 to schema version 9. There are no down-migrations. Before upgrading,
the operator must back up the database, keystore, secret files and promotion records as one recovery set.
Rolling back the image requires restoring the matching pre-upgrade database and keystore together.

Existing root-owned keystore volumes are handled by the shipped `keystore-prepare` one-shot. Its repair is
narrow and fail-closed: it has no network or secrets, mounts only the keystore volume, and refuses an
unexpected tree rather than guessing.

## Required release gates

The release PR must pass:

- typecheck and the complete bounded test inventory;
- production-image smoke and release-bundle checks;
- fresh, restart, upgrade and rollback lifecycle acceptance;
- catalog import/browser and Jellyfin control-plane acceptance against local test doubles;
- release-candidate browser acceptance; and
- final release rehearsal and verification-packet checks.

The feature head merged as PR #30 with its required GitHub checks green, including suites, image, catalog,
Jellyfin, lifecycle, bundle and rehearsal jobs. Release-preparation validation is recorded on this PR rather
than inferred from that earlier run.

Local pre-PR validation completed cleanly:

- `npm run typecheck`;
- release identity, delivery, readiness, verification, rehearsal, release-guard and consumer-readiness suites;
- the 305-suite inventory audit and its runner's adversarial suite;
- focused Phase 259–272 scripts, including their temporary-PostgreSQL integration sections; and
- release-candidate and lifecycle acceptance contract suites.

Windows cannot exercise Linux `O_NOFOLLOW`, POSIX symlink/mode assertions, or the daemon-backed browser and
Compose acceptance runs. Those are not counted as local passes; the required Linux CI jobs remain the release
evidence for them.

## External installation evidence

The Tower test installation remains on the published v1.1.2 digest. It independently confirmed:

- runtime release identity `v1.1.2`, provenance `RELEASE`, digest pinning and bundle agreement;
- healthy app and PostgreSQL containers, schema version 4 and authenticated API enforcement;
- reproduction and repair of the legacy root-owned keystore volume; and
- a least-privileged runtime database identity after credential remediation.

A pre-remediation recovery set is stored on Tower at
`/mnt/user/projects/catalog-authority-v110-test/manual-backups/20260728T175817Z`. This release-preparation
branch does not alter that installation.

## Boundaries

Nothing in this branch tags, publishes, releases, merges or deploys v1.1.3. No package visibility changes,
Unraid media access, live Jellyfin request or provider call are part of this review. Publishing is a separate
manual release-event action after merge and after every required gate is green.
