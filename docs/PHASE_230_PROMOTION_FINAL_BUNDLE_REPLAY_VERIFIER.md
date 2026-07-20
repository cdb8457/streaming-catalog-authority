# Phase 230: Final Bundle Replay Verifier (local, non-live)

Report id: `phase-230-promotion-final-bundle-replay-verifier`

Status: `PHASE_230_PROMOTION_FINAL_BUNDLE_REPLAY_VERIFIER_READY`

The independent **replay** check that sits on top of the final coordinator readiness bundle. Given the
supplied final bundle plus every input it was supposed to be derived from — the four launch-proofing leaves
(approval-request packet, live-execution preflight plan, no-live authorization guard, coordinator review
checklist v2), the operator acceptance trace, and the self-digest verification — it **re-derives** the
operator acceptance trace and the final coordinator readiness bundle from those inputs and confirms the
supplied artifacts reproduce **exactly**.

## What it produces

When the supplied final bundle reproduces exactly from its inputs, it reports:

- the reviewed commit, one green check per replay invariant;
- open blockers (empty when verified);
- an explicit live boundary status of **CLOSED**;
- Phase 231 authorization **NONE**.

`FINAL_BUNDLE_REPLAY_VERIFIED` means the assembled final bundle reproduces exactly from its inputs. `status`
is `PENDING` and `authorization` is `NONE`. It is **not** an approval and does not authorize Phase 231 or any
live promotion.

## Fail-closed conditions

It fails closed (`FINAL_BUNDLE_REPLAY_BLOCKED`) on any of:

- `REPLAY_FINAL_BUNDLE_NOT_READY` — the supplied final bundle is missing, malformed, does not self-verify, or
  is not a green `FINAL_READINESS_BUNDLE_READY` (with `CLOSED` boundary and Phase 231 `NONE`);
- `REPLAY_ACCEPTANCE_TRACE_MISMATCH` — the acceptance trace re-derived from the leaves is not READY, or its
  self-digest does not **exactly** equal the supplied trace's (a self-sealed artifact proves integrity, not
  authenticity, so a forged/tampered-but-self-consistent trace fails here);
- `REPLAY_SELF_DIGEST_MISMATCH` — the self-digest re-derived over exactly the supplied guard components is not
  `ALL_VERIFIED`, or its `verifierDigest` does not equal the supplied self-digest's (a stale digest over an
  unrelated set fails);
- `REPLAY_REVIEWED_COMMIT_MISMATCH` — the reviewed commit differs across the final bundle, the acceptance
  trace, and the approval-request packet;
- `REPLAY_COMPONENT_SET_MISMATCH` — the final bundle re-derived from all supplied components is not READY, or
  its `readinessBundleDigest` does not equal the supplied final bundle's (a swapped-but-green component or a
  re-sealed bundle fails);
- `REPLAY_LIVE_AUTHORIZATION_CLAIMED` — any supplied input (leaf, trace, self-digest, or the final bundle
  itself) claims an approval / live-ready / execution / Phase 231 authorization;
- `REPLAY_OBSERVED_STATE_MISSING` — the preflight plan's observed-state requirement is absent or not green;
- `REPLAY_REDACTION_UNSAFE` — any supplied input is not `redactionSafe`, or a raw path (`/mnt/…`) leaks into
  any artifact tree.

## Files

- `src/ops/promotion-final-bundle-replay-verifier.ts` — `verifyFinalBundleReplay(input)`.
- `src/ops/promotion-final-bundle-replay-verifier-cli.ts` — CLI wrapper.
- `test/promotion-final-bundle-replay-verifier.ts` — VERIFIED replay; blocked on commit / trace / self-digest
  mismatch, live claim, raw path, and missing observed state; CLI run.

## Usage

```
npm run ops:promotion-final-bundle-replay-verifier -- --approvalrequest ar.json --livepreflight lp.json --noliveguard ng.json --checklistv2 cv.json --acceptancetrace at.json --selfdigest sd.json --finalbundle fb.json [--out replay.json]
```

Exit `0` = `FINAL_BUNDLE_REPLAY_VERIFIED`, `1` = `FINAL_BUNDLE_REPLAY_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and no
Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize Phase 231.
