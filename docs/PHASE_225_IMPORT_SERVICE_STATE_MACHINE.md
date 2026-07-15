# Phase 225: Import Service + State Machine

Report id: `phase-225-import-service-state-machine`

Phase type: local import implementation and tests. This phase adds no provider, downloader,
scraper, playback, Jellyfin write API, custody-runtime change, or real-library path.

## Scope

Phase 225 implements the first executable slice of the Phase 224 local-media pipeline:

`REQUESTED -> STORED -> IMPORT_VALIDATING -> IMPORTING -> IMPORTED`

Optional read-only Jellyfin visibility can advance a run to:

`JELLYFIN_SCAN_WAITING -> VISIBLE_IN_JELLYFIN`

Observed-state rule: no success transition is recorded from an accepted API call alone. File import
success requires destination existence, size match, and SHA-256 match. Jellyfin visibility requires a
read-only query to observe the item.

## Implementation

Added:

- `src/ops/local-media-pipeline.ts`;
- `src/ops/local-media-pipeline-cli.ts`;
- `test/import-state-machine.ts`.

The import mode is `copy`. The operator source file is never moved or deleted. The destination layout
is:

`/mnt/user/media/catalog-authority-test-library/Movies/<Title> (<Year>)/<Title> (<Year>).<ext>`

Allowed extensions are `.mkv`, `.mp4`, `.m4v`, `.avi`, `.mov`, and `.webm`.

The CLI is:

`npm run ops:local-media-pipeline -- --out <evidence.json> --item-id <uuid> --title <title> --source-file <path> [--year <year>] [--ref-type <type> --ref-value <value>] [--await-jellyfin]`

If `--ref-type` and `--ref-value` are supplied, the CLI uses `CatalogAuthority.addItem` before import,
keeping ingestion on the existing front-door path.

## Failure Semantics

The test suite covers:

- successful copy import;
- idempotent duplicate retry with matching checksum;
- missing source file;
- forbidden extension;
- destination collision with a different checksum;
- read-only Jellyfin visibility after bounded retry;
- Jellyfin visibility timeout as a clean `FAILED` state.

Each failed report carries a fixed failure code and retrievable lifecycle log. Temporary copy residue
is removed on copy failure. Existing destination files are preserved on collision.

## Boundaries

Forbidden in this phase:

- provider live mode;
- downloading;
- scraping;
- playback;
- Jellyfin write API;
- real-library paths;
- raw source path in evidence;
- raw media title in evidence.

## Gate

Stage 225 gate:

- `test:import-state-machine`;
- `test:deploy`;
- `typecheck`.

Status: `PHASE_225_IMPORT_SERVICE_STATE_MACHINE_READY`
