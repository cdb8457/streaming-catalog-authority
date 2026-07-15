# Phase 229: Real-Library Promotion Boundary + Plan

Report id: `phase-229-real-library-promotion-boundary`

Status: `PHASE_229_REAL_LIBRARY_PROMOTION_PLAN_READY`

Phase type: plan, boundary definition, and guard tests only. This phase makes no runtime, Docker
Compose, custody-mode, Jellyfin, provider, downloader, scraper, playback, Gelato, AIO Streams, or
real-library filesystem changes.

## Scope

Phase 229 defines promotion as an operator-approved copy of one already imported Catalog Authority
test-library item into one designated real Movies library path. Promotion is never automatic and is
not provider intake, download orchestration, scraping, playback, metadata writing, Jellyfin write
integration, or media-server control.

This phase follows the local-media workflow proven in Phases 224 through 227:

- Phase 224 defined working foundation as a boring repeatable workflow from input to visible result;
- Phase 225 implemented the observed-state import service and lifecycle state machine;
- Phase 226 proved one live local-media item visible in the isolated Jellyfin test library;
- Phase 227 proved repeatability, idempotency, failure evidence, and retry behavior.

Phase 228 remains a paperwork-only acceptance record if we choose to add it later. Phase 229 does not
pretend that record exists.

## Definition: Promote

`promote` means:

1. select one item that is already `VISIBLE_IN_JELLYFIN` in the isolated Catalog Authority test
   library;
2. require an explicit operator approval gate for this exact item and destination;
3. copy the test-library media file into the approved real Movies target path;
4. verify the copied file by observed size and SHA-256;
5. trigger or await Jellyfin scan only through the same bounded read-only visibility pattern used by
   the local-media pipeline;
6. confirm the item is visible through the Jellyfin read-only path in the real Movies library;
7. record redaction-safe evidence by digest and lifecycle status.

Promotion is a copy for the first implementation. Move and hardlink are out of scope until a later
phase proves their rollback and data-safety behavior.

## Allowed Real-Library Target

Initial allowed target root:

`/mnt/user/media/Movies`

The target is intentionally singular. Phase 230 must fail closed if the configured promotion target
is anything else.

Naming convention:

`/mnt/user/media/Movies/<Title> (<Year>)/<Title> (<Year>).<ext>`

This matches the Jellyfin Movies layout already used by the test-library import convention while
placing the final copy under the real Movies root. The title/year/extension rules remain the Phase
224/225 rules:

- title is the normalized catalog display title;
- year is used when known; unknown year uses `Unknown Year`;
- extension must be one of the existing allowed media extensions;
- raw source path, raw title, and raw Jellyfin item ID stay out of public evidence.

## Explicitly Out of Bounds

The promotion implementation and live run must refuse:

- `/mnt/user/media/catalog-authority-test-library` as a real-library promotion target;
- any Gelato path;
- any AIO Streams path;
- Shows, Collections, playlists, metadata folders, transcode/cache folders, appdata, or Docker
  config paths;
- relative paths, symlink escapes, `..` path traversal, or host paths outside the approved Movies
  root;
- provider, downloader, scraper, playback, or media-server-write side effects.

Gelato and AIO Streams may remain installed and usable by Jellyfin, but they are not promotion
targets and are not consulted by the promotion service.

## Operator Approval Gate

Promotion code must be unreachable unless all approval inputs are present and consistent:

- `PROMOTION_APPROVED=true`;
- a per-run approval token or approval id recorded in evidence;
- the selected catalog item digest;
- the source test-library file digest;
- the exact destination path digest;
- the configured target root equal to `/mnt/user/media/Movies`.

The approval is one-shot for the selected item and destination. It cannot authorize a directory,
wildcard, batch, provider import, or future automatic promotion. Missing approval produces
`PROMOTION_APPROVAL_REQUIRED`.

## Collision Policy

Promotion must never overwrite an existing real-library file.

Collision handling:

- if the destination path exists with the same SHA-256, report `PROMOTION_ALREADY_PRESENT` and do not
  rewrite the file;
- if the destination path exists with a different SHA-256, fail closed with
  `PROMOTION_DESTINATION_COLLISION`;
- if the destination directory exists but the destination file does not, copying may proceed;
- no rename, suffixing, overwrite, or replacement is allowed without a later explicit phase.

The before/after evidence must include a digest of the real Movies target subtree sufficient to prove
only the approved destination changed.

## Rollback / Withdrawal

Withdrawal means removing only the file that Phase 230 promoted, then removing its now-empty
Catalog Authority-created movie directory if and only if:

- the directory path matches the exact planned destination directory;
- the file SHA-256 matches the promoted file digest;
- no extra files are present except optional empty directories created by the promotion run.

Rollback must never delete a pre-existing real-library file and must never delete a directory that
contains unrelated files. Failure produces `PROMOTION_WITHDRAWAL_REFUSED` or
`PROMOTION_WITHDRAWAL_FAILED` with redaction-safe details.

After withdrawal, Jellyfin visibility must be rechecked via the read-only path. A bounded retry
window is required; HTTP acceptance alone is not evidence.

## State Machine Extension

Phase 230 extends the local-media lifecycle with promotion states:

`VISIBLE_IN_JELLYFIN -> PROMOTION_APPROVED -> PROMOTED -> VISIBLE_IN_REAL_LIBRARY`

Failure state:

`PROMOTION_FAILED`

Allowed transitions:

| From | To | Evidence required |
| --- | --- | --- |
| `VISIBLE_IN_JELLYFIN` | `PROMOTION_APPROVED` | Explicit one-shot operator approval for item and destination |
| `PROMOTION_APPROVED` | `PROMOTED` | Destination file exists with matching observed size and SHA-256 |
| `PROMOTED` | `VISIBLE_IN_REAL_LIBRARY` | Jellyfin read-only query sees the promoted item in the real Movies library |
| Any promotion state | `PROMOTION_FAILED` | Failure code, retry/rollback classification, and evidence reference |

Promotion verification follows the same rule learned in Phases 195 and 221: observed state only, not
accepted commands or HTTP status codes alone.

## Phase 230 Execution Plan

Phase 230 may implement the promotion service only after this plan is committed and tagged.

Required implementation coverage:

- approval gate required;
- exact target root enforcement;
- Gelato/AIO path refusal;
- collision refusal;
- same-checksum no-op handling;
- copy verification;
- rollback/withdrawal safety;
- read-only Jellyfin visibility verification;
- failure-state evidence.

Required live proof:

1. choose one Phase 226/227 test-library item;
2. capture a redaction-safe before digest of the real Movies target subtree;
3. promote it into `/mnt/user/media/Movies`;
4. verify file digest and Jellyfin read-only visibility in the real Movies library;
5. withdraw the promoted file using the rollback path;
6. verify the real Movies subtree returns to the prior digest;
7. verify Jellyfin no longer reports the promoted copy after the bounded scan/read window.

## Exit Status

Phase 229 status: `PHASE_229_REAL_LIBRARY_PROMOTION_PLAN_READY`

Phase 230 is unblocked for guarded implementation and a single operator-approved live promotion.

