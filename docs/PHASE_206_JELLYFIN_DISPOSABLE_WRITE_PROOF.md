# Phase 206: Jellyfin Disposable Write Proof

Report id: `phase-206-jellyfin-disposable-write-proof`

Decision date: `2026-07-13`

Phase type: optional write-boundary proof, artifact, and test work. This phase formalizes the only
allowed Jellyfin write test shape: a disposable, token-marked collection that is created by the test,
found by opaque token, deleted, and verified gone. It does not enable live Jellyfin publishing by
default, does not add Jellyfin to Compose, does not change sidecar custody, and does not run live
Jellyfin without explicit operator gates.

## Source Boundary

Inputs:

- Phase 203 boundary selection: `d5c5b13` / `phase-203`
- Phase 204 read-only smoke gate: `55352a1` / `phase-204`
- Phase 205 read-only mapping gate: `10d3355` / `phase-205`

Phase 206 stays inside Rung 3 from `docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md`.

## Status

Status: `JELLYFIN_DISPOSABLE_WRITE_PROOF_READY`

The write proof is optional and intentionally narrower than production publishing. It proves only:

- the operator intentionally enabled live write validation;
- at least one read-only library lookup matched;
- the test created one token-marked disposable collection;
- the test recovered that collection by opaque token;
- the test deleted it;
- the post-delete lookup confirmed no same-token collection remains.

It does not prove general media-server management, user collection writes, Plex readiness, Emby
readiness, provider availability, download readiness, playback readiness, or scraping behavior.

## Required Gates

Live execution is forbidden unless all gates are true:

- Phase 204 read-only smoke evidence retained and passing;
- Phase 205 read-only mapping evidence retained and passing;
- `JELLYFIN_ENABLE_NETWORK=true`;
- `JELLYFIN_ALLOW_LIVE_PUBLISH=true`;
- operator explicitly invokes `smoke:jellyfin -- --write <refType> <refValue>`;
- the target is non-production or explicitly designated for Catalog Authority testing.

Default committed configuration keeps both `JELLYFIN_ENABLE_NETWORK` and
`JELLYFIN_ALLOW_LIVE_PUBLISH` off.

## Disposable Collection Definition

A disposable collection is valid only when:

- it is created by the test itself;
- its name contains an opaque token marker;
- the token is not a media title, provider ref, API key, Jellyfin item ID, or collection ID;
- the test can find the collection by token after create;
- the test deletes the collection before completion;
- the final lookup proves no same-token collection remains.

If cleanup cannot be confirmed, the proof fails. The operator must manually remove the token-marked
test collection before any retry.

## Allowed Endpoint Shape

The write proof may use:

- Phase 204 read-only lookup endpoints;
- token-tagged collection create through `createTaggedCollection`;
- token lookup through `findCollectionByToken`;
- delete of the single collection handle returned by token proof.

Forbidden:

- writes outside the disposable collection;
- writes to user-managed collections;
- metadata refresh, playback session control, downloads, scraping, provider/debrid calls, or media-file
  mutation;
- silent retries after uncertain cleanup;
- printing raw titles, raw provider refs, API keys, Jellyfin item IDs, collection IDs, URLs, DB URLs,
  KEK/DEK material, or ciphertext.

## Implementation Record

Existing code accepted for Phase 206:

- `src/core/adapters/jellyfin/smoke.ts`
  - `runWriteSmoke(...)`
  - ambiguous create recovery through token lookup;
  - cleanup uncertainty reported as `CLEANUP NOT CONFIRMED`;
  - final `verify-gone` proof.
- `src/ops/jellyfin-smoke-cli.ts`
  - requires `--write`;
  - requires `JELLYFIN_ENABLE_NETWORK=true`;
  - requires `JELLYFIN_ALLOW_LIVE_PUBLISH=true`.
- `src/core/adapters/jellyfin/real-factory.ts`
  - keeps live publish disabled unless explicitly enabled.

Phase 206 adds `test:jellyfin-disposable-write` to pin these invariants.

## Evidence Shape

Retained evidence may include only:

- report id;
- command shape with ref value redacted;
- gate states as yes/no;
- smoke steps and pass/fail status;
- counts and opaque handle length;
- cleanup confirmation status.

Retained evidence must not include raw collection IDs, raw Jellyfin item IDs, media titles, provider
ref values, server URLs, API keys, or logs from Jellyfin itself.

## Verification Matrix

| Checkpoint | Expected result | Proof |
| --- | --- | --- |
| Phase 204 prerequisite | Satisfied | `55352a1` / `phase-204` read-only smoke gate exists. |
| Phase 205 prerequisite | Satisfied | `10d3355` / `phase-205` read-only mapping gate exists. |
| Live write default off | Satisfied | `test:jellyfin-disposable-write` asserts the gates remain false by default. |
| Disposable happy path | Satisfied in fixture client | Create, find-by-token, delete, verify-gone all pass. |
| Ambiguous create recovery | Satisfied in fixture client | Created-then-failed collection is found by token and deleted. |
| Cleanup uncertainty fails | Satisfied in fixture client | Delete or lookup failure reports `CLEANUP NOT CONFIRMED`. |
| Redaction-safe report | Satisfied | Tests assert secrets, refs, and opaque Jellyfin IDs are excluded from formatted output. |

No live Jellyfin write evidence is committed in this phase because no operator-designated Jellyfin
test instance and API key secret file were provided.

## Status Boundaries

- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Phase 206 does not alter sidecar custody or Unraid runtime.
- Phase 207 is unblocked for operator evidence review and an integration launch decision only after
  retained Phase 204, Phase 205, and optional Phase 206 evidence exists.
