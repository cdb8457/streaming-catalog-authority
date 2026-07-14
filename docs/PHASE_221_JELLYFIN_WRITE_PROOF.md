# Phase 221: Jellyfin Write-Capable Disposable Collection Proof

Report id: `phase-221-jellyfin-write-proof`

Decision status: `JELLYFIN_WRITE_PROOF_FAILED_SAFE`

Operator authorization: rung 3 write proof authorized on `2026-07-14`.

## Scope

Phase 221 is the first and only write-capable Jellyfin proof. The write scope is restricted to one
test-owned disposable collection named with the prefix `Catalog Authority disposable write proof`.
The command must refuse to run if any collection with that prefix already exists.

Allowed Jellyfin operations:

- `POST /Collections`
- `POST /Collections/{collectionId}/Items`
- `GET /Items/{itemId}/Collections`
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
   file-backed, and no prior test-owned collection exists after a bounded consistency poll.
2. Select target: choose a real Catalog Authority item with encrypted provider refs that maps to at
   least one live Jellyfin library item.
3. Snapshot before: record a digest/count of the mapped live Jellyfin item set.
4. Create one token-marked disposable collection.
5. Add the mapped existing library item reference(s).
6. Read back collection membership from the mapped item path through a bounded consistency poll and
   verify the expected collection reference is present.
7. Remove the item reference(s).
8. Delete the collection.
9. Verify absence by token and prefix lookup through a bounded consistency poll.
10. Snapshot after: verify the mapped live library item digest/count is unchanged.

Cleanup runs through the command's finally path. Residue and absence checks poll for up to 30 seconds
before accepting presence or absence because Jellyfin collection indexes can be eventually
consistent. If cleanup cannot be confirmed after that bounded window, the status is
`JELLYFIN_WRITE_PROOF_CLEANUP_FAILED`, the orphan digest is recorded, and the phase is not accepted.

## Live Remediation Note

During the live Phase 221 proof, a pre-fix run produced a false-negative membership check: the
collection create/add path returned success, but the membership readback observed zero items. The
run cleaned up according to its immediate checks, yet a following run correctly refused to proceed
because one test-owned collection with the Phase 221 prefix was still visible in Jellyfin. This is
recorded as a guarded residue stop, not as accepted evidence.

Residue guard evidence:

- Evidence file SHA-256: `e20bff64cb7846e065af51ca36a7af01e5e622bc2294f3a362371f06b1b16ebf`
- Report digest: `7c952edbeb1b1861c0135784515955be573009bfde8eecbca2f3f1a475115aee`
- Status: `JELLYFIN_WRITE_PROOF_REFUSED_PRIOR_RESIDUE`
- Residue count: `1`

Manual remediation is part of the phase record: the operator listed only collections with the exact
`Catalog Authority disposable write proof` prefix, reviewed the printed name, deleted the single
test-owned BoxSet through a bounded Jellyfin API call, and verified the prefix count returned to
zero. Raw collection names and ids are not retained in this document; the final accepted evidence
must retain only hashed collection identifiers.

## Evidence Record

Evidence file: `/mnt/user/appdata/catalog/evidence/phase-221-jellyfin-write-proof.json`

Evidence file SHA-256:
`fc2a1841107a8b5f807ffcfed0aeed67a25331e2ba4db465f3c8b0bd97ed0cc6`

Report digest:
`f7a5ca903900da963baa4c927caf1484bf027c68e5a45eec1772befba5637bcd`

Accepted live result: `JELLYFIN_WRITE_PROOF_FAILED_SAFE`

Retained command status: `JELLYFIN_WRITE_PROOF_FAILED`

The retained evidence includes:

- `status: JELLYFIN_WRITE_PROOF_FAILED`
- `cleanup.success: true`
- `collection.finalResidueCount: 0`
- `libraryState.unchanged: true`
- hashed catalog item digest(s)
- hashed Jellyfin item digest(s)
- hashed collection digest only

The failed-safe basis is that the live disposable write proof did not prove membership, but the
operation remained bounded and self-cleaning. The retained proof created a token-marked disposable
collection and the Jellyfin add endpoint returned success, but membership verification did not
materialize through the bounded polling window. Cleanup then deleted the test collection, verified
zero Phase 221 residue, and confirmed the mapped library item set was unchanged.

Retained proof summary:

- `mappedItems: 1`
- `verify-membership: 0 collection-items reference(s) confirmed after 61 poll(s)`
- `cleanup.success: true`
- `collection.finalResidueCount: 0`
- `libraryState.unchanged: true`

Manual membership probe:

To disambiguate a race from a real Jellyfin write-compatibility issue, a separate manual probe was
run from Tower. It selected one existing Jellyfin library item, created a disposable probe
collection, added the item by opaque Jellyfin id, and polled both `ParentId` and `parentId`
membership reads every five seconds for sixty seconds. The add call returned HTTP `204`, but both
membership paths remained at zero for the full polling window. The probe collection was deleted with
HTTP `204`, and the manual probe residue count returned to zero.

Manual probe redacted identifiers:

- item digest: `69e9cf049e9a1da6`
- collection digest: `b6e4b27a82d40669`
- poll result: `members_upper=0`, `members_lower=0` through `t+60s`
- cleanup result: `cleanup_http=204`
- manual probe residue: `0`

Phase 221 therefore does not prove the Jellyfin rung-3 write-capable integration on this server.
It proves the write guard, redaction boundary, bounded polling, and cleanup behavior. Phase 222 must
review this failed-safe evidence and decide whether to defer Jellyfin writes or open a
version-specific Jellyfin collection-write investigation.

## Status

O4 remains `O4_CLOSED`.

O5 remains `O5_DEFERRED_ACCEPTED`.

Jellyfin runtime integration remains deferred pending Phase 222 operator evidence review and launch
decision. Phase 221 does not enable Jellyfin write-capable integration; it does not enable provider
mode, playback, downloads, scraping, or a permanent media-server integration.
