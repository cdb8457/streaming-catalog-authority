# Phase 226: Live Single-File E2E on Unraid

Report id: `phase-226-live-single-file-e2e`

Status: `PHASE_226_LIVE_SINGLE_FILE_E2E_PASS`

Phase type: live Unraid workflow evidence. This phase adds no provider, downloader, scraper,
playback orchestration, Jellyfin collection write, Jellyfin metadata write, custody-mode change, or
real-library import path.

## Preconditions

Operator-provided Jellyfin test-library configuration was verified before import:

- host folder: `/mnt/user/media/catalog-authority-test-library`;
- Jellyfin container mount: `/media/catalog-authority-test-library`;
- Jellyfin library name: `Catalog Authority Test`;
- library scope: isolated test Movies library, separate from Gelato and real Movies/Shows paths;
- preflight evidence: `phase-226-test-library-preflight.json`;
- preflight result: `ok:true`;
- preflight location digest: `c4276e8f6d816b0a`.

The Unraid runtime was sidecar custody mode, with Postgres, sidecar, and app healthy.

## Implementation Notes

Phase 226 added `deploy/unraid-local-media-e2e.sh` as the live Unraid launcher for the Phase 225
pipeline.

Two live-run defects were fixed before the accepted run:

- `7c6b7be` added the launcher;
- `f05d1a8` changed the launcher from `docker compose run` transient volume flags to explicit
  `docker run` bind mounts after the first live attempts proved the import could otherwise be
  observed only inside a throwaway container layer;
- `bf453c8` added the gated `JELLYFIN_TRIGGER_LIBRARY_SCAN=true` path. The trigger is limited to
  `POST /Library/Refresh`; success still requires a later read-only `/Items` query to observe the
  imported item. Accepted state is never based on the scan command alone.

The source media was a tiny valid MP4 test fixture staged under Catalog Authority appdata for the
isolated proof. Source SHA-256:

`f61646264e3f8806ec43742abf75ed142731c57b4346327429dd62ab55afb7cb`

## Accepted Live Evidence

Accepted evidence file:

`phase-226-local-media-e2e.json`

Evidence file SHA-256:

`905140e2e773aa6e42eecb0575fb58fb7ebd5fb90c88bef6c9aa104ddef957d8`

Report digest:

`07e6f2e7c0135e261d18e1717a55152e987d7da22730f4811977268fc6f225ae`

Runtime image at accepted run:

`sha256:cd4a386d2c6b44bd24df426249b78588b09b425573ad0fe70008b555e78ebb0f`

Final report status:

`LOCAL_MEDIA_VISIBLE_IN_JELLYFIN`

Final lifecycle state:

`VISIBLE_IN_JELLYFIN`

Observed lifecycle:

`REQUESTED -> STORED -> IMPORT_VALIDATING -> IMPORTING -> IMPORTED -> JELLYFIN_SCAN_WAITING -> VISIBLE_IN_JELLYFIN`

Visibility basis:

- match basis: `path`;
- Jellyfin visibility polls: `2`;
- raw item ids, raw source path, and raw title are not published in this record.

## Verification Matrix

| Checkpoint | Result | Evidence |
| --- | --- | --- |
| Catalog item stored under sidecar custody | Pass | `STORED` transition, encrypted provider ref expected via front-door add path |
| Source media validated | Pass | allowed `.mp4`, non-empty, source hash recorded |
| Import wrote to isolated test library | Pass | destination size/hash matched source hash |
| Jellyfin scan completed to observed state | Pass | scan trigger followed by read-only item query |
| Jellyfin item visible | Pass | `VISIBLE_IN_JELLYFIN`, path match, poll `2` |
| Real libraries untouched | Pass | import root remained `/mnt/user/media/catalog-authority-test-library` only |
| Runtime healthy after run | Pass | app/Postgres/sidecar healthy; UI live check `ok:true` |

## Boundaries

Still forbidden:

- provider live mode;
- downloading;
- scraping;
- playback orchestration;
- Jellyfin collection writes;
- Jellyfin metadata writes;
- real library paths;
- raw source path, raw media title, or raw Jellyfin item id in public evidence.

The Jellyfin scan trigger is an operational scan request only. It does not create collections, alter
metadata, delete media, modify existing libraries, or claim write-capable Jellyfin integration.

## Disposition

Phase 226 is accepted: a single local media file moved through the live workflow from catalog
storage to file import to Jellyfin-visible state with redaction-safe evidence.

Phase 227 is unblocked for repeatability and failure-injection proof.
