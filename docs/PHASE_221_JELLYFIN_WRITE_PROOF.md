# Phase 221: Jellyfin Write-Capable Disposable Collection Proof

Report id: `phase-221-jellyfin-write-proof`

Decision status: `JELLYFIN_WRITE_PROOF_CLEANED_UP`

Operator authorization: rung 3 write proof authorized on `2026-07-14`.

## Scope

Phase 221 is the first and only write-capable Jellyfin proof. The write scope is restricted to one
test-owned disposable collection named with the prefix `Catalog Authority disposable write proof`.
The command must refuse to run if any collection with that prefix already exists.

Allowed Jellyfin operations:

- `POST /Collections`
- `POST /Collections/{collectionId}/Items`
- `GET /Items?ParentId={collectionId}`
- `DELETE /Collections/{collectionId}/Items`
- `DELETE /Items/{collectionId}`

Forbidden operations remain out of scope: item metadata writes, library-content deletes, playlists,
user/settings endpoints, provider mode, playback, downloads, scraping, and media-server runtime launch.

## Source Evidence

Phase 220 predecessor status: `JELLYFIN_DATA_POSITIVE_READONLY_MAPPING_ACCEPTED`

Phase 220 file SHA-256:
`7b8cb31e703f20b87a7f262cc376f956c26ed14827ec3c2349db22d183ea3055`

Phase 220 report digest:
`ac423af0f96afcb2fff905c228cdc3dd43e29ee866340b3b96c89f9a8e3e9b71`

Phase 221 uses the Phase 220 mapped set as the live target source. Raw provider refs, Jellyfin item
ids, item titles, hostnames, and API keys are not recorded.

## Command

Unraid launcher:

```bash
/mnt/user/appdata/catalog/repo/deploy/unraid-jellyfin-write-proof.sh
```

Container command:

```bash
npm run ops:jellyfin-write-proof -- --out /mnt/user/appdata/catalog/evidence/phase-221-jellyfin-write-proof.json --confirm-disposable-write
```

Required gates:

- `JELLYFIN_ENABLE_NETWORK=true`
- `JELLYFIN_ALLOW_LIVE_PUBLISH=true`
- `JELLYFIN_API_KEY_FILE=/run/secrets/jellyfin_api_key`
- `--confirm-disposable-write`

## Proof Sequence

1. Preflight: verify Jellyfin is reachable, the Phase 221 write boundary is active, the API key is
   file-backed, and no prior test-owned collection exists.
2. Select target: choose a real Catalog Authority item with encrypted provider refs that maps to at
   least one live Jellyfin library item.
3. Snapshot before: record a digest/count of the mapped live Jellyfin item set.
4. Create one token-marked disposable collection.
5. Add the mapped existing library item reference(s).
6. Read back collection membership and verify the expected hashed item digests are present.
7. Remove the item reference(s).
8. Delete the collection.
9. Verify absence by token and prefix lookup.
10. Snapshot after: verify the mapped live library item digest/count is unchanged.

Cleanup runs through the command's finally path. If cleanup cannot be confirmed, the status is
`JELLYFIN_WRITE_PROOF_CLEANUP_FAILED`, the orphan digest is recorded, and the phase is not accepted.

## Evidence Record

Evidence file: `/mnt/user/appdata/catalog/evidence/phase-221-jellyfin-write-proof.json`

Evidence file SHA-256: `PENDING_LIVE_RUN`

Report digest: `PENDING_LIVE_RUN`

Accepted live result: `PENDING_LIVE_RUN`

The retained evidence must include:

- `status: JELLYFIN_WRITE_PROOF_CLEANED_UP`
- `cleanup.success: true`
- `collection.finalResidueCount: 0`
- `libraryState.unchanged: true`
- hashed catalog item digest(s)
- hashed Jellyfin item digest(s)
- hashed collection digest only

## Status

O4 remains `O4_CLOSED`.

O5 remains `O5_DEFERRED_ACCEPTED`.

Jellyfin runtime integration remains deferred pending Phase 222 operator evidence review and launch
decision. Phase 221 proves the disposable write boundary only; it does not enable provider mode,
playback, downloads, scraping, or a permanent media-server integration.
