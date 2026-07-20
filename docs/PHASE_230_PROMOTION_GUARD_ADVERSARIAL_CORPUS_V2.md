# Phase 230: Shared Adversarial Guard Corpus v2 (local, non-live)

Report id: `phase-230-promotion-guard-adversarial-corpus-v2`

Status: `PHASE_230_PROMOTION_GUARD_ADVERSARIAL_CORPUS_V2_READY`

A single shared fixture set of adversarial inputs for the launch-proofing guard family: the no-live
authorization guard, the live-execution preflight plan validator, the approval-request packet, the
coordinator review checklist v2, and the operator acceptance trace. It runs every sample through its guard and
confirms the expected outcome.

## Coverage

Negative samples that must **BLOCK** (fail closed):

- nested hard authorization claims;
- whitespace / case / separator / camelCase / object-key token variants;
- forged approval statuses (claim flags, pre-approved preflight items, an approval-request input already
  claiming approval);
- live-surface strings and raw media / symlink-containment paths inside a preflight plan;
- Phase 231 tokens;
- redaction-sensitive failure evidence (a claim carried alongside a raw path must fail closed **and** never be
  echoed);
- forged (non-recomputing self-digest) components handed to the checklist and the acceptance trace.

Safe samples that must stay **clean / pending** without a false positive: genuinely clean artifacts, a valid
PENDING preflight plan, and a pending human gate that merely lists the tokens as pending steps.

`GUARD_CORPUS_V2_HELD` means every adversarial sample failed its guard closed and every safe sample stayed
clean. `authorization` is `NONE`. Every probed live/path literal is fragment-assembled so this source stays
clean under the boundary guards, and the report echoes only fixed ids/categories/booleans.

## Files

- `src/ops/promotion-guard-adversarial-corpus-v2.ts` — `buildGuardAdversarialCorpusV2(projectRoot)`.
- `src/ops/promotion-guard-adversarial-corpus-v2-cli.ts` — CLI wrapper.
- `test/promotion-guard-adversarial-corpus-v2.ts` — asserts the corpus holds and covers every guard.

## Usage

```
npm run ops:promotion-guard-adversarial-corpus-v2 -- [--out corpus.json]
```

Exit `0` = `GUARD_CORPUS_V2_HELD`, `1` = `GUARD_CORPUS_V2_BREACHED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and no
Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize Phase 231.
