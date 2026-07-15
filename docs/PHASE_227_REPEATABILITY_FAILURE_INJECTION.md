# Phase 227: Repeatability + Failure Injection

Report id: `phase-227-repeatability-failure-injection`

Status: `PHASE_227_REPEATABILITY_FAILURE_INJECTION_PASS`

Phase type: live Unraid repeatability and failure-mode evidence. This phase adds no provider,
downloader, scraper, playback orchestration, Jellyfin collection write, Jellyfin metadata write,
custody-mode change, or real-library import path.

## Preconditions

Phase 226 was accepted at `0bfbcf9` / `phase-226`.

Additional hardening landed before this live run:

- `6dc30ea`: validate MP4/M4V/MOV source signatures before import, so corrupt files fail before any
  destination write;
- `449ffd5`: convert thrown Jellyfin visibility errors into redaction-safe failed lifecycle evidence
  instead of allowing the CLI to exit without an evidence file.

Runtime image at accepted run:

`sha256:277de78d8337f2310974ae091fcbd650c9a32ec8d18135d7ad0f313e2d80bf13`

UI live check after the run: `ok:true`.

## Evidence Set

Summary evidence:

- file: `phase-227-repeatability-summary.json`;
- SHA-256: `f3a935b78a3bc0a84c3697626ece37000b344eccdad4004e08028cd82212cede`.

Per-run evidence digests:

| Run | Purpose | Status | Digest |
| --- | --- | --- | --- |
| `phase-227-run1.json` | fresh successful E2E | `LOCAL_MEDIA_VISIBLE_IN_JELLYFIN` | `f6ed50ace33d7e57979acf72b8f63cac22eb24081663c82b00780dd300559d77` |
| `phase-227-run2-duplicate.json` | duplicate/idempotent retry | `LOCAL_MEDIA_VISIBLE_IN_JELLYFIN` | `abcb80b6b8c33b420eb8015706de28d0fa3ac41db5ce9ef123d3e2af1990c5f0` |
| `phase-227-run3.json` | second fresh successful E2E | `LOCAL_MEDIA_VISIBLE_IN_JELLYFIN` | `937d764dd4f53204a885eac8e86bc22dade1384b96fc79b414e87e5d2b01f7cb` |
| `phase-227-run4-corrupt.json` | corrupt MP4 failure injection | `LOCAL_MEDIA_FAILED` | `ca2dae943fb240e8945a06af9dcfdee5ec177a035e758b876b51c9c9cff77591` |
| `phase-227-run5-jellyfin-unreachable.json` | Jellyfin unreachable during visibility | `LOCAL_MEDIA_FAILED` | `22ba43c7f8db7605fa8aa858489e30054b0b48c40edb1985b99545c5d473c2b5` |

Additional Jellyfin final item evidence:

- file: `phase-227-jellyfin-final-items.json`;
- SHA-256: `b393c3e2997db4bbf053bd5bfefb45812a4787673d9bd9780c8fb9da022ad695`.

## Results

The repeatability matrix passed:

- run 1: fresh import reached `VISIBLE_IN_JELLYFIN`, path match, poll `2`;
- run 2: duplicate submission reached `VISIBLE_IN_JELLYFIN`, `idempotentNoop:true`, path match,
  poll `1`;
- run 3: second fresh import reached `VISIBLE_IN_JELLYFIN`, path match, poll `2`;
- run 4: corrupt `.mp4` failed with `IMPORT_SOURCE_INVALID`, `partialResidue:false`, and no Jellyfin
  movie residue;
- run 5: Jellyfin-unreachable run failed with `JELLYFIN_SCAN_TIMEOUT`, wrote a failed evidence file,
  retained a checksum-matched import for retry, and became visible after a later healthy Jellyfin
  scan.

Summary assertions:

- `postFailureRetry.unreachableImportVisibleAfterHealthyScan: true`;
- `postFailureRetry.corruptImportResiduePresent: false`;
- final Jellyfin movie evidence contains the Phase 226 final item, run 1/2 idempotent item, run 3
  item, and the retry-visible unreachable item.

## Boundary Confirmation

Still forbidden:

- provider live mode;
- downloading;
- scraping;
- playback orchestration;
- Jellyfin collection writes;
- Jellyfin metadata writes;
- real library paths;
- raw source path, raw media title, raw provider ref, or raw Jellyfin item id in public evidence.

The only Jellyfin mutation-like operation remains the bounded library scan trigger introduced in
Phase 226. It is not a media write, collection write, metadata write, playback operation, provider
operation, or download operation; success continues to require observed read-only visibility.

## Disposition

Phase 227 is accepted. The local-media workflow is repeatable across successful runs, idempotent on
duplicate submission, and produces retrievable failure evidence for corrupt source and Jellyfin
unreachable cases.

Phase 228 is unblocked as a paperwork-only working-foundation acceptance record.
