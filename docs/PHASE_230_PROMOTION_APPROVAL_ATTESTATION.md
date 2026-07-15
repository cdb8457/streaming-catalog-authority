# Phase 230: Promotion Approval-Attestation Workflow (local, non-live)

Report id: `phase-230-promotion-approval-attestation`

Status: `PHASE_230_APPROVAL_ATTESTATION_READY`

A local, non-live readiness tool that **produces** and **validates** the approval JSON the
real-library promotion service requires. It exists so the operator can prepare and pre-flight a
bound approval **offline**, before any live promotion is ever considered.

This artifact does not promote anything. It does not write to `/mnt/user/media/Movies`, does not
contact Jellyfin, and does not run `deploy/unraid-real-library-promotion.sh`. It only reads the
chosen source file inside the isolated test library (to hash it) and computes a destination **path
string**. It grants no authorization: `PROMOTION_APPROVED=true` and Phase 231 remain entirely
separate gates that this tool cannot set.

## What it binds

The attestation is exactly the binding the promotion service enforces at run time (and fails closed
on mismatch): `itemId`, `targetRoot`, `sourceRealPath`, `sourceSha256`, and `destinationPath` (plus an
`approvalId`). It deliberately omits `approved` — authorization to run is a different gate.

The validator re-derives every field the same way the service does (shared `canonicalPath` equality,
shared media-extension allowlist, `buildPromotionDestination`), so a `validate` pass is a faithful
preview of the service's binding check.

Source containment mirrors `runRealLibraryPromotion` exactly, reusing the service's own
`hasSymlinkComponent` and `resolvesWithin`: the workflow refuses a source that is a symlink, sits under
a **symlinked test-library root**, is reached through a **symlinked intermediate component**, or whose
real path escapes the isolated test library — before it ever hashes the file. So an approval can never
be produced or validated for a source smuggled in through a symlink.

## Files

- `src/ops/promotion-approval.ts` — `buildApprovalAttestation` / `validateApprovalAttestation` + redaction-safe evidence.
- `src/ops/promotion-approval-cli.ts` — `build` and `validate` subcommands.
- `test/promotion-approval.ts` — local fixture tests (11), incl. a proof that a built attestation is exactly what the promotion service accepts (mock observer, temp dirs).

## Usage

```
# Produce the approval JSON (operator secret; written mode 0600) + redaction-safe evidence
npm run ops:promotion-approval -- build \
  --approval-out approval.json --evidence-out approval-evidence.json \
  --item-id <uuid> --title "<title>" --year <year> \
  --source-file <test-library file> --target-root /mnt/user/media/Movies

# Validate an existing approval JSON against the intended run
npm run ops:promotion-approval -- validate \
  --approval-file approval.json --evidence-out validate-evidence.json \
  --item-id <uuid> --title "<title>" --year <year> \
  --source-file <test-library file> --target-root /mnt/user/media/Movies
```

Exit code is `0` when the attestation is ready/valid and `1` when it fails closed; problems are
generic, value-free codes (e.g. `ITEM_ID_MISMATCH`, `SOURCE_CHECKSUM_MISMATCH`) safe for evidence.

## Redaction safety

The **approval JSON** contains real paths (source real path, destination path) — it is an operator
secret and is written with mode `0600`; do not commit or share it. The **evidence JSON** is
redaction-safe: it carries only digests (`itemDigest`, `sourceRealPathDigest`, `destinationPathDigest`,
`destinationNameDigest`, `approvalIdDigest`), the content `sourceSha256`, size, and extension — never
the raw title, source path, or destination path (`titleEchoed`/`sourcePathEchoed`/`destinationPathEchoed`
are all `false`).

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no merge/tag/master change, and no Phase 231
or live-promotion authorization is implied by this workflow.
